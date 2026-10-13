import bcrypt from 'bcryptjs';

import { closeDatabasePool, pool } from '../src/config/database.js';

if (process.env.SEED_DEMO_DATA !== 'true') {
  console.error('Seed bloqueado: ejecuta SEED_DEMO_DATA=true npm run seed:demo para crear los datos de prueba.');
  process.exitCode = 1;
} else {
  try {
    async function hasColumn(table, column) {
      const [rows] = await pool.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
      return rows.length > 0;
    }

    if (!(await hasColumn('courses', 'access_days')) || !(await hasColumn('enrollments', 'expires_at'))) {
      throw new Error('Aplica primero la migración 006: APPLY_SCHEMA=true npm run db:migrate');
    }

    async function ensureUser({ fullName, email, password, role }) {
      const [existing] = await pool.execute('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
      if (existing[0]) return Number(existing[0].id);
      const [result] = await pool.execute(
        'INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)',
        [fullName, email, await bcrypt.hash(password, 12), role],
      );
      return Number(result.insertId);
    }

    // accessDays solo se aplica al insertar; los cursos existentes se ajustan con setCoursePolicy.
    async function ensureCourse({ ownerId, slug, title, subtitle, description, category, level, accessDays = null }) {
      const [existing] = await pool.execute('SELECT id FROM courses WHERE slug = ? LIMIT 1', [slug]);
      if (existing[0]) return Number(existing[0].id);
      const [result] = await pool.execute(
        `INSERT INTO courses (owner_id, slug, title, subtitle, description, category, level, access_days, status, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', CURRENT_TIMESTAMP)`,
        [ownerId, slug, title, subtitle, description, category, level, accessDays],
      );
      return Number(result.insertId);
    }

    async function setCoursePolicy(slug, accessDays) {
      await pool.execute('UPDATE courses SET access_days = ? WHERE slug = ?', [accessDays, slug]);
    }

    async function ensureLessons(courseId, titles) {
      const lessonIds = [];
      for (const [index, title] of titles.entries()) {
        const position = index + 1;
        const [existing] = await pool.execute('SELECT id FROM lessons WHERE course_id = ? AND position = ? LIMIT 1', [courseId, position]);
        if (existing[0]) { lessonIds.push(Number(existing[0].id)); continue; }
        const [result] = await pool.execute(
          'INSERT INTO lessons (course_id, title, description, duration_seconds, position) VALUES (?, ?, ?, ?, ?)',
          [courseId, title, 'Lección de demostración para probar progreso y analítica.', 420 + (index * 90), position],
        );
        lessonIds.push(Number(result.insertId));
      }
      return lessonIds;
    }

    // Inscripción con fechas relativas a hoy. Re-ejecutar el seed re-ancla el vencimiento.
    // expiresInDays: número (puede ser negativo = ya vencida) o null (indefinida).
    async function upsertEnrollment({ userId, courseId, enrolledById, expiresInDays, enrolledDaysAgo = 0 }) {
      await pool.execute(
        `INSERT INTO enrollments (user_id, course_id, enrolled_by_id, expires_at, created_at)
         VALUES (?, ?, ?, ${expiresInDays === null ? 'NULL' : 'DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY)'}, DATE_SUB(NOW(), INTERVAL ? DAY))
         ON DUPLICATE KEY UPDATE expires_at = VALUES(expires_at), created_at = VALUES(created_at)`,
        expiresInDays === null
          ? [userId, courseId, enrolledById, enrolledDaysAgo]
          : [userId, courseId, enrolledById, expiresInDays, enrolledDaysAgo],
      );
    }

    // Progreso de una clase: completed=true marca la clase terminada; daysAgo fija completed_at y updated_at.
    async function upsertProgress({ userId, lessonId, completed = true, daysAgo = 0 }) {
      await pool.execute(
        `INSERT INTO lesson_progress (user_id, lesson_id, completed_at, last_position_seconds, updated_at)
         VALUES (?, ?, ${completed ? 'DATE_SUB(NOW(), INTERVAL ? DAY)' : 'NULL'}, ?, DATE_SUB(NOW(), INTERVAL ? DAY))
         ON DUPLICATE KEY UPDATE completed_at = VALUES(completed_at), last_position_seconds = VALUES(last_position_seconds), updated_at = VALUES(updated_at)`,
        completed ? [userId, lessonId, daysAgo, 600, daysAgo] : [userId, lessonId, 240, daysAgo],
      );
    }

    const demoPassword = 'DemoStudent2026!';
    const instructorId = await ensureUser({ fullName: 'Lucía Martínez', email: 'instructor.demo@streamly.test', password: 'DemoInstructor2026!', role: 'admin' });
    const studentId = await ensureUser({ fullName: 'Sofía Torres', email: 'alumna.demo@streamly.test', password: demoPassword, role: 'student' });
    const mateoId = await ensureUser({ fullName: 'Mateo Rivera', email: 'mateo.demo@streamly.test', password: demoPassword, role: 'student' });
    const valentinaId = await ensureUser({ fullName: 'Valentina Ortega', email: 'valentina.demo@streamly.test', password: demoPassword, role: 'student' });
    const diegoId = await ensureUser({ fullName: 'Diego Núñez', email: 'diego.demo@streamly.test', password: demoPassword, role: 'student' });
    const camilaId = await ensureUser({ fullName: 'Camila Reyes', email: 'camila.demo@streamly.test', password: demoPassword, role: 'student' });
    const [juanRows] = await pool.execute('SELECT id FROM users WHERE email = ? LIMIT 1', ['juan@empresa.com']);
    if (!juanRows[0]) throw new Error('No existe juan@empresa.com; crea primero el super administrador.');
    const juanId = Number(juanRows[0].id);

    const productivityCourseId = await ensureCourse({ ownerId: instructorId, slug: 'notion-productividad-demo', title: 'Notion para organizar tu trabajo', subtitle: 'Un sistema claro para proyectos, tareas y aprendizaje.', description: 'Curso de demostración con progreso real para Streamly.', category: 'Productividad', level: 'beginner' });
    const designCourseId = await ensureCourse({ ownerId: instructorId, slug: 'diseno-interfaces-demo', title: 'Diseño de interfaces que se entienden', subtitle: 'Principios visuales y decisiones de UX aplicadas.', description: 'Curso de demostración para probar alumnos, cursos y finalizaciones.', category: 'Diseño', level: 'intermediate' });
    const photographyCourseId = await ensureCourse({ ownerId: instructorId, slug: 'fotografia-movil-demo', title: 'Fotografía con el celular', subtitle: 'Luz, composición y edición rápida con lo que ya tienes en el bolsillo.', description: 'Curso de demostración con acceso de 90 días. Es el curso con acceso expirado de la alumna demo.', category: 'Diseño', level: 'beginner', accessDays: 90 });
    // Política de los cursos existentes (no altera inscripciones ya creadas).
    await setCoursePolicy('notion-productividad-demo', 45);
    await setCoursePolicy('diseno-interfaces-demo', null);
    const productivityLessons = await ensureLessons(productivityCourseId, ['Bienvenida al sistema', 'Organiza tus proyectos', 'Revisión semanal']);
    const designLessons = await ensureLessons(designCourseId, ['Jerarquía visual', 'Componentes consistentes', 'Prueba con usuarios']);
    const photographyLessons = await ensureLessons(photographyCourseId, ['Encuadre y composición', 'Luz natural en interiores', 'Edición rápida en el celular']);

    // Juan y Sofía-productividad: INSERT IGNORE => sin vencimiento (NULL). No se re-anclan.
    for (const [userId, courseId] of [[juanId, productivityCourseId], [juanId, designCourseId], [studentId, productivityCourseId]]) {
      await pool.execute('INSERT IGNORE INTO enrollments (user_id, course_id, enrolled_by_id) VALUES (?, ?, ?)', [userId, courseId, juanId]);
    }

    // Sofía: diseño por vencer (+5 d) y fotografía expirada (-3 d). Fotografía es el único curso expirado de la alumna demo.
    await upsertEnrollment({ userId: studentId, courseId: designCourseId, enrolledById: juanId, expiresInDays: 5, enrolledDaysAgo: 40 });
    await upsertEnrollment({ userId: studentId, courseId: photographyCourseId, enrolledById: juanId, expiresInDays: -3, enrolledDaysAgo: 93 });
    // Alumnos adicionales en productividad.
    await upsertEnrollment({ userId: mateoId, courseId: productivityCourseId, enrolledById: juanId, expiresInDays: 5, enrolledDaysAgo: 40 });
    await upsertEnrollment({ userId: valentinaId, courseId: productivityCourseId, enrolledById: juanId, expiresInDays: 30, enrolledDaysAgo: 15 });
    await upsertEnrollment({ userId: diegoId, courseId: productivityCourseId, enrolledById: juanId, expiresInDays: -1, enrolledDaysAgo: 40 });
    await upsertEnrollment({ userId: camilaId, courseId: productivityCourseId, enrolledById: juanId, expiresInDays: 20, enrolledDaysAgo: 25 });

    // Progreso de Juan (sin cambios respecto al seed anterior).
    for (const lessonId of productivityLessons.slice(0, 2)) await upsertProgress({ userId: juanId, lessonId });
    await upsertProgress({ userId: juanId, lessonId: designLessons[0] });
    // Sofía: productividad activa (actividad refrescada a hoy), diseño 1/3, fotografía 1/3.
    await upsertProgress({ userId: studentId, lessonId: productivityLessons[0] });
    await upsertProgress({ userId: studentId, lessonId: designLessons[0], daysAgo: 2 });
    await upsertProgress({ userId: studentId, lessonId: photographyLessons[0], daysAgo: 10 });
    // Mateo: 2/3, actividad reciente.
    await upsertProgress({ userId: mateoId, lessonId: productivityLessons[0], daysAgo: 3 });
    await upsertProgress({ userId: mateoId, lessonId: productivityLessons[1], daysAgo: 1 });
    // Valentina: completado 3/3.
    for (const [index, lessonId] of productivityLessons.entries()) await upsertProgress({ userId: valentinaId, lessonId, daysAgo: 6 - index });
    // Diego: 1/3, expirado.
    await upsertProgress({ userId: diegoId, lessonId: productivityLessons[0], daysAgo: 12 });
    // Camila: 1/3, inactiva (última actividad hace 20 días).
    await upsertProgress({ userId: camilaId, lessonId: productivityLessons[0], daysAgo: 20 });

    const [summary] = await pool.execute(
      `SELECT u.email, c.slug,
        CASE WHEN e.expires_at IS NULL THEN 'indefinida' WHEN e.expires_at <= UTC_TIMESTAMP() THEN 'expirada'
          WHEN TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), e.expires_at) <= 7 * 86400 THEN 'por vencer' ELSE 'vigente' END AS acceso,
        DATE_FORMAT(e.expires_at, '%Y-%m-%dT%H:%i:%sZ') AS expires_at
       FROM enrollments e JOIN users u ON u.id = e.user_id JOIN courses c ON c.id = e.course_id
       WHERE c.slug IN ('notion-productividad-demo', 'diseno-interfaces-demo', 'fotografia-movil-demo')
       ORDER BY c.slug, u.email`,
    );
    console.log(JSON.stringify({
      seeded: true,
      instructor: 'instructor.demo@streamly.test',
      student: 'alumna.demo@streamly.test',
      note: "'fotografia-movil-demo' es el curso expirado de la alumna demo; re-ejecuta el seed para re-anclar las fechas relativas a hoy.",
      courses: [
        { slug: 'notion-productividad-demo', accessDays: 45 },
        { slug: 'diseno-interfaces-demo', accessDays: null },
        { slug: 'fotografia-movil-demo', accessDays: 90 },
      ],
      students: ['alumna.demo', 'mateo.demo', 'valentina.demo', 'diego.demo', 'camila.demo'].map((name) => `${name}@streamly.test`),
      enrollments: summary.map((row) => ({ email: row.email, course: row.slug, access: row.acceso, expiresAt: row.expires_at })),
    }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await closeDatabasePool();
  }
}
