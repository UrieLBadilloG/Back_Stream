// Módulo puro: decide qué hacer con un pago de Mercado Pago. El almacenamiento se inyecta (ver payments-store.js).
// Toda la lógica corre dentro de una transacción que bloquea la fila del pago, así webhook y verify se serializan.
const PAYLOAD_FIELDS = ['status', 'status_detail', 'payment_type_id', 'payment_method_id', 'transaction_amount', 'transaction_amount_refunded', 'currency_id', 'date_approved', 'date_last_updated'];

export function pickPaymentPayload(mp) {
  const payload = {};
  for (const field of PAYLOAD_FIELDS) {
    if (mp?.[field] !== undefined && mp[field] !== null) payload[field] = mp[field];
  }
  return payload;
}

function sameNumber(value, expected) {
  return value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value)) && Math.abs(Number(value) - Number(expected)) < 0.005;
}

const NOT_APPROVED = new Set(['pending', 'in_process', 'in_mediation', 'authorized', 'rejected', 'cancelled']);
const REVERSALS = new Set(['refunded', 'charged_back']);

export function createPaymentProcessor({ store }) {
  async function processMercadoPagoPayment(mp) {
    const reference = String(mp?.external_reference ?? '');
    if (!reference) return { handled: false, reason: 'unknown_reference', accessGranted: false };
    // Las referencias de demostración nunca otorgan acceso.
    if (reference.startsWith('demo-')) return { handled: true, accessGranted: false, reason: 'demo_reference' };

    return store.transaction(async (tx) => {
      const row = await tx.lockByReference(reference);
      if (!row) return { handled: false, reason: 'unknown_reference', accessGranted: false };

      const mpStatus = String(mp.status ?? '');
      const mpId = /^\d{1,20}$/.test(String(mp.id ?? '')) ? String(mp.id) : null;
      const statusDetail = mp.status_detail ? String(mp.status_detail).slice(0, 80) : null;
      const payload = pickPaymentPayload(mp);
      const wasApproved = row.status === 'approved' || Boolean(row.approvedAt);
      const sameId = mpId !== null && row.mpPaymentId !== null && row.mpPaymentId !== undefined && String(row.mpPaymentId) === mpId;
      const result = (extra = {}) => ({ handled: true, paymentRowId: row.id, accessGranted: wasApproved && row.enrollmentId !== null && row.enrollmentId !== undefined, ...extra });
      const flag = async (reason, extraFields = {}) => {
        await tx.update(row.id, { needsReview: true, reviewReason: reason, rawStatusPayload: payload, ...extraFields });
        return result({ flagged: reason });
      };

      // Regla 3: monto, moneda y metadatos deben coincidir con lo cobrado en el checkout.
      if (mp.currency_id !== row.currency || !sameNumber(mp.transaction_amount, row.amount)) return flag('amount_mismatch');
      const meta = mp.metadata ?? {};
      if ((meta.user_id !== undefined && Number(meta.user_id) !== Number(row.userId)) || (meta.course_id !== undefined && Number(meta.course_id) !== Number(row.courseId))) {
        return flag('metadata_mismatch');
      }

      // Regla 6: aprobado.
      if (mpStatus === 'approved') {
        if (wasApproved && sameId) return result({ replay: true });
        if (wasApproved) return flag('duplicate_payment');
        const grant = await tx.grantAccess({ userId: row.userId, courseId: row.courseId });
        await tx.update(row.id, { status: 'approved', statusDetail, mpPaymentId: mpId, approvedNow: true, enrollmentId: grant.enrollmentId, rawStatusPayload: payload });
        return { handled: true, paymentRowId: row.id, accessGranted: true, expiresAt: grant.expiresAtIso ?? null, renewed: Boolean(grant.renewed) };
      }

      // Regla 5: reembolsos y contracargos del pago aprobado.
      if (REVERSALS.has(mpStatus)) {
        if (wasApproved && !sameId) return result({ ignored: true });
        await tx.update(row.id, { status: mpStatus, statusDetail, mpPaymentId: mpId ?? row.mpPaymentId ?? null, needsReview: true, reviewReason: mpStatus === 'refunded' ? 'refunded' : 'charged_back', rawStatusPayload: payload });
        return result({ flagged: mpStatus });
      }

      // Regla 4: estados no aprobados.
      if (wasApproved) {
        if (mpStatus === 'cancelled' && sameId) return flag('cancelled_after_approval');
        return result({ ignored: true });
      }
      const status = NOT_APPROVED.has(mpStatus) ? mpStatus : String(mpStatus || row.status).slice(0, 32);
      await tx.update(row.id, { status, statusDetail, mpPaymentId: mpId ?? row.mpPaymentId ?? null, rawStatusPayload: payload });
      return result({ status });
    });
  }

  return { processMercadoPagoPayment };
}
