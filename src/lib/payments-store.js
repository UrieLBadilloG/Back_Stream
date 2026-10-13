import { enrollmentAccessColumns, RENEW_ENROLLMENT_SQL, SNAPSHOT_EXPIRES_SQL } from './access.js';

// Implementación MySQL del almacén que usa payment-processor.js, más las consultas de listado.
const UPDATABLE = Object.freeze({
  status: 'status',
  statusDetail: 'status_detail',
  mpPaymentId: 'mp_payment_id',
  needsReview: 'needs_review',
  reviewReason: 'review_reason',
  enrollmentId: 'enrollment_id',
});

export const REVIEWABLE_STATUSES = Object.freeze(['pending', 'approved', 'in_process', 'rejected', 'cancelled', 'refunded', 'charged_back']);

function mapRow(row) {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    courseId: Number(row.course_id),
    externalReference: row.external_reference,
    status: row.status,
    statusDetail: row.status_detail,
    mpPaymentId: row.mp_payment_id === null || row.mp_payment_id === undefined ? null : String(row.mp_payment_id),
    amountCents: Number(row.amount_cents),
    amount: Number(row.amount),
    currency: row.currency,
    enrollmentId: row.enrollment_id === null || row.enrollment_id === undefined ? null : Number(row.enrollment_id),
    needsReview: Boolean(row.needs_review),
    reviewReason: row.review_reason,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    preferenceId: row.preference_id,
    checkoutUrl: row.checkout_url,
  };
}

function createTransactionApi(connection) {
  return {
    async lockByReference(reference) {
      const [rows] = await connection.execute('SELECT * FROM payments WHERE external_reference = ? LIMIT 1 FOR UPDATE', [reference]);
      return rows[0] ? mapRow(rows[0]) : null;
    },

    async update(id, fields) {
      const assignments = [];
      const values = [];
      for (const [key, column] of Object.entries(UPDATABLE)) {
        if (fields[key] === undefined) continue;
        assignments.push(`${column} = ?`);
        values.push(typeof fields[key] === 'boolean' ? Number(fields[key]) : fields[key]);
      }
      if (fields.rawStatusPayload !== undefined) {
        assignments.push('raw_status_payload = ?');
        values.push(JSON.stringify(fields.rawStatusPayload));
      }
      if (fields.approvedNow) assignments.push('approved_at = CURRENT_TIMESTAMP');
      if (!assignments.length) return;
      await connection.execute(`UPDATE payments SET ${assignments.join(', ')} WHERE id = ?`, [...values, id]);
    },

    async grantAccess({ userId, courseId }) {
      const [inserted] = await connection.execute(
        `INSERT IGNORE INTO enrollments (user_id, course_id, enrolled_by_id, expires_at) VALUES (?, ?, NULL, ${SNAPSHOT_EXPIRES_SQL})`,
        [userId, courseId, courseId],
      );
      let renewed = false;
      if (!inserted.affectedRows) {
        const [existing] = await connection.execute('SELECT id FROM enrollments WHERE user_id = ? AND course_id = ? LIMIT 1 FOR UPDATE', [userId, courseId]);
        if (!existing[0]) throw new Error('No se pudo crear ni encontrar la inscripción.');
        const [updated] = await connection.execute(RENEW_ENROLLMENT_SQL, [userId, existing[0].id]);
        renewed = updated.affectedRows > 0;
      }
      const [rows] = await connection.execute(
        `SELECT e.id, ${enrollmentAccessColumns('e')} FROM enrollments e WHERE e.user_id = ? AND e.course_id = ? LIMIT 1`,
        [userId, courseId],
      );
      return { enrollmentId: Number(rows[0].id), expiresAtIso: rows[0].expires_at_iso ?? null, renewed };
    },
  };
}

export function createPaymentsStore(pool) {
  const SCOPE_JOINS = 'FROM payments p JOIN users u ON u.id = p.user_id JOIN courses c ON c.id = p.course_id JOIN users o ON o.id = c.owner_id';

  return {
    async transaction(fn) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const result = await fn(createTransactionApi(connection));
        await connection.commit();
        return result;
      } catch (error) {
        try {
          await connection.rollback();
        } catch {
          // La conexión ya pudo haberse perdido; se conserva el error original.
        }
        throw error;
      } finally {
        connection.release();
      }
    },

    async findByReference(reference) {
      const [rows] = await pool.execute('SELECT * FROM payments WHERE external_reference = ? LIMIT 1', [reference]);
      return rows[0] ? mapRow(rows[0]) : null;
    },

    async findById(id) {
      const [rows] = await pool.execute('SELECT * FROM payments WHERE id = ? LIMIT 1', [id]);
      return rows[0] ? mapRow(rows[0]) : null;
    },

    async findReusablePending({ userId, courseId, amountCents, currency }) {
      const [rows] = await pool.execute(
        `SELECT * FROM payments WHERE user_id = ? AND course_id = ? AND status = 'pending' AND amount_cents = ? AND currency = ?
           AND checkout_url IS NOT NULL AND created_at > DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 24 HOUR)
         ORDER BY id DESC LIMIT 1`,
        [userId, courseId, amountCents, currency],
      );
      return rows[0] ? mapRow(rows[0]) : null;
    },

    async insertPending({ userId, courseId, preferenceId, checkoutUrl, externalReference, amountCents, amount, currency, payerEmail }) {
      const [result] = await pool.execute(
        `INSERT INTO payments (user_id, course_id, preference_id, checkout_url, external_reference, status, amount_cents, amount, currency, payer_email)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
        [userId, courseId, preferenceId, checkoutUrl, externalReference, amountCents, amount, currency, payerEmail],
      );
      return Number(result.insertId);
    },

    // Segundo paso del checkout: guarda la preferencia creada en Mercado Pago sobre el registro 'pending'.
    async attachPreference(id, { preferenceId, checkoutUrl }) {
      await pool.execute("UPDATE payments SET preference_id = ?, checkout_url = ? WHERE id = ? AND status = 'pending'", [preferenceId, checkoutUrl, id]);
    },

    // Si Mercado Pago falló, el registro queda cancelado (no reutilizable) pero conservado para conciliar.
    async markCheckoutFailed(id) {
      await pool.execute("UPDATE payments SET status = 'cancelled', status_detail = 'checkout_failed' WHERE id = ? AND status = 'pending' AND preference_id IS NULL", [id]);
    },

    async listMine(userId) {
      const [rows] = await pool.execute(
        `SELECT p.*, c.slug AS course_slug, c.title AS course_title
         FROM payments p JOIN courses c ON c.id = p.course_id
         WHERE p.user_id = ? ORDER BY p.created_at DESC, p.id DESC LIMIT 100`,
        [userId],
      );
      return rows.map((row) => ({ ...mapRow(row), courseSlug: row.course_slug, courseTitle: row.course_title }));
    },

    // ownerId = null lista todo (super_admin); con ownerId solo cursos de ese docente.
    async listScoped({ ownerId, status, page, pageSize }) {
      const scopeWhere = ownerId ? 'c.owner_id = ?' : '1 = 1';
      const scopeValues = ownerId ? [ownerId] : [];
      let where = scopeWhere;
      const values = [...scopeValues];
      if (status === 'review') where += ' AND p.needs_review = 1';
      else if (status) {
        where += ' AND p.status = ?';
        values.push(status);
      }
      const limit = Math.max(1, Math.min(50, Number(pageSize) || 20));
      const offset = (Math.max(1, Number(page) || 1) - 1) * limit;
      const [rows] = await pool.execute(
        `SELECT p.id, p.external_reference, p.status, p.status_detail, p.amount, p.currency, p.needs_review, p.review_reason, p.created_at, p.approved_at,
          u.id AS student_id, u.full_name AS student_name, u.email AS student_email,
          c.id AS course_id, c.title AS course_title, o.full_name AS owner_name
         ${SCOPE_JOINS} WHERE ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT ${limit} OFFSET ${offset}`,
        values,
      );
      const [[count]] = await pool.execute(`SELECT COUNT(*) AS total ${SCOPE_JOINS} WHERE ${where}`, values);
      const [totals] = await pool.execute(
        `SELECT p.status, COUNT(*) AS count, COALESCE(SUM(p.amount), 0) AS amount ${SCOPE_JOINS} WHERE ${scopeWhere} GROUP BY p.status ORDER BY p.status`,
        scopeValues,
      );
      return { rows, total: Number(count.total), totals, page: offset / limit + 1, pageSize: limit };
    },
  };
}
