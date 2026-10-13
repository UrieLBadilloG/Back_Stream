import { Router } from 'express';

import { pool } from '../config/database.js';
import { describeAccess, enrollmentAccessColumns } from '../lib/access.js';
import { env } from '../config/env.js';
import { CERTIFICATE_TEMPLATES, assertNameRenderable, generateCertificatePdf, getCertificateTemplate } from '../lib/certificate-pdf.js';
import {
  certificateContentDisposition,
  evaluateCertificateEligibility,
  generateCertificateCode,
  validateRecipientName,
} from '../lib/certificates.js';
import { assert, httpError } from '../lib/http-error.js';
import { countedLessonSql } from '../lib/quiz-logic.js';
import { certificateShareUrl, resolveApiBase } from '../lib/share.js';
import { isCourseManager } from '../lib/users.js';
import { requireAuth } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rate-limit.js';

export const certificatesRouter = Router();

const PREVIEW_NAME = 'María de los Ángeles Hernández Ordóñez';
const CODE_ATTEMPTS = 5;

const certificateLimiter = createRateLimiter({ windowMs: 60000, max: 6, keyFn: (request) => `cert:${request.user.id}` });

function parseId(value, label) {
  const id = Number(value);
  assert(Number.isSafeInteger(id) && id > 0, 400, `El identificador ${label} no es válido.`);
  return id;
}

async function findCourse(id) {
  const [rows] = await pool.execute('SELECT id, owner_id, title, certificate_template FROM courses WHERE id = ? LIMIT 1', [id]);
  if (!rows[0]) throw httpError(404, 'Curso no encontrado.');
  return rows[0];
}

async function findCertificate(userId, courseId) {
  const [rows] = await pool.execute('SELECT * FROM certificates WHERE user_id = ? AND course_id = ? LIMIT 1', [userId, courseId]);
  return rows[0] ?? null;
}

// Misma regla de avance que workspaces.routes.js: lesson_progress.completed_at no nulo sobre todas las clases.
// `asManager`: el dueño del curso y el super admin no se inscriben a sus propios cursos; si completaron todas las
// clases (p. ej. al probarlo), cuentan como inscritos para poder emitir su propia constancia.
async function loadProgress(userId, courseId, { asManager = false } = {}) {
  const [enrollments] = await pool.execute(
    `SELECT e.id, ${enrollmentAccessColumns('e')} FROM enrollments e WHERE e.user_id = ? AND e.course_id = ? LIMIT 1`,
    [userId, courseId],
  );
  const [[totals]] = await pool.execute(
    `SELECT
       (SELECT COUNT(*) FROM lessons l WHERE l.course_id = ? AND ${countedLessonSql('l')}) AS total_lessons,
       (SELECT COUNT(*) FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id
         WHERE l.course_id = ? AND lp.user_id = ? AND lp.completed_at IS NOT NULL AND ${countedLessonSql('l')}) AS completed_lessons`,
    [courseId, courseId, userId],
  );
  const [pendingRows] = await pool.execute(
    `SELECT l.id, l.title FROM lessons l
     WHERE l.course_id = ? AND l.kind = 'quiz' AND ${countedLessonSql('l')}
       AND NOT EXISTS (SELECT 1 FROM lesson_progress lp WHERE lp.lesson_id = l.id AND lp.user_id = ? AND lp.completed_at IS NOT NULL)
     ORDER BY l.position, l.id`,
    [courseId, userId],
  );
  const enrolled = Boolean(enrollments[0]) || asManager;
  const totalLessons = Number(totals.total_lessons);
  const completedLessons = Number(totals.completed_lessons);
  return {
    enrolled,
    accessExpired: enrollments[0] ? describeAccess(enrollments[0]).isExpired : false,
    totalLessons,
    completedLessons,
    pendingRequiredQuizzes: pendingRows.map((row) => ({ id: Number(row.id), title: row.title })),
    ...evaluateCertificateEligibility({ enrolled, totalLessons, completedLessons }),
  };
}

function toIso(value) {
  return new Date(value).toISOString();
}

function sendPdf(response, definition, bytes, code) {
  response.status(200);
  response.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': certificateContentDisposition(definition.filename),
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    'X-Certificate-Code': code,
  });
  response.end(Buffer.from(bytes));
}

function sameName(a, b) {
  return a.normalize('NFC').toLocaleLowerCase('es') === b.normalize('NFC').toLocaleLowerCase('es');
}

async function resolveTargetUser(request) {
  const requested = request.body?.userId;
  if (requested === undefined || requested === null || Number(requested) === Number(request.user.id)) return request.user;
  if (request.user.role !== 'super_admin') throw httpError(403, 'No tienes permiso para emitir la constancia de otro usuario.');
  const [rows] = await pool.execute('SELECT id, full_name FROM users WHERE id = ? LIMIT 1', [parseId(requested, 'del usuario')]);
  if (!rows[0]) throw httpError(404, 'Usuario no encontrado.');
  return { id: Number(rows[0].id), fullName: rows[0].full_name };
}

// Primera emisión: INSERT IGNORE + SELECT (carrera por UNIQUE user/curso) con reintento si choca el código.
async function createCertificate({ userId, courseId, definition, name }) {
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
    const code = generateCertificateCode(definition.codePrefix);
    await pool.execute(
      'INSERT IGNORE INTO certificates (user_id, course_id, template, certificate_code, recipient_name) VALUES (?, ?, ?, ?, ?)',
      [userId, courseId, definition.key, code, name],
    );
    const row = await findCertificate(userId, courseId);
    if (row) return row;
  }
  throw httpError(500, 'No se pudo registrar la constancia. Intenta de nuevo.', false);
}

certificatesRouter.get('/:courseId/certificate', requireAuth, async (request, response) => {
  const course = await findCourse(parseId(request.params.courseId, 'del curso'));
  const progress = await loadProgress(request.user.id, course.id, { asManager: isCourseManager(request.user, course) });
  const available = Boolean(course.certificate_template);
  const record = available ? await findCertificate(request.user.id, course.id) : null;
  response.json({
    available,
    eligible: available && progress.eligible,
    enrolled: progress.enrolled,
    accessExpired: progress.accessExpired,
    completedLessons: progress.completedLessons,
    totalLessons: progress.totalLessons,
    pendingRequiredQuizzes: progress.pendingRequiredQuizzes,
    canPreview: available && isCourseManager(request.user, course),
    ...(record
      ? {
          issuedAt: toIso(record.issued_at),
          recipientName: record.recipient_name,
          certificateCode: record.certificate_code,
          verifyUrl: `${env.payments.appUrl}/verificar/${record.certificate_code}`,
          shareUrl: certificateShareUrl(resolveApiBase({ publicApiUrl: env.payments.publicApiUrl, protocol: request.protocol, host: request.get('host') }), record.certificate_code),
          courseTitle: course.title,
          issuer: CERTIFICATE_TEMPLATES[course.certificate_template]?.issuer ?? 'Streamly Academia',
        }
      : {}),
  });
});

certificatesRouter.post('/:courseId/certificate', requireAuth, certificateLimiter, async (request, response) => {
  const course = await findCourse(parseId(request.params.courseId, 'del curso'));
  if (!course.certificate_template) throw httpError(404, 'Este curso no emite constancia.');
  const definition = getCertificateTemplate(course.certificate_template);
  const body = request.body ?? {};
  const manager = isCourseManager(request.user, course);

  if (body.preview === true) {
    if (!manager) throw httpError(403, 'Solo el docente del curso o un super administrador pueden ver la vista previa.');
    const bytes = await generateCertificatePdf({ template: definition, recipientName: PREVIEW_NAME, certificateCode: null, issuedAt: new Date() });
    sendPdf(response, definition, bytes, 'PREVIEW');
    return;
  }

  const target = await resolveTargetUser(request);
  const isSelf = Number(target.id) === Number(request.user.id);
  const isSuper = request.user.role === 'super_admin';
  const existing = await findCertificate(target.id, course.id);
  const hasName = body.recipientName !== undefined && body.recipientName !== null;
  const requestedName = hasName ? validateRecipientName(body.recipientName) : null;

  if (!existing) {
    const progress = await loadProgress(target.id, course.id, { asManager: isSelf && manager });
    if (!progress.eligible) {
      const who = isSelf ? 'Aún no cumples' : 'El alumno aún no cumple';
      if (progress.pendingRequiredQuizzes.length > 0) throw httpError(403, `${who} los requisitos: inscripción, 100 % de las clases completadas y aprobar las evaluaciones obligatorias.`);
      throw httpError(403, `${who} los requisitos: inscripción y 100 % de las clases completadas.`);
    }
  }

  let record = existing;
  let name;
  if (existing) {
    if (requestedName && !sameName(requestedName, existing.recipient_name)) {
      if (!isSuper) throw httpError(403, 'Tu constancia ya fue emitida con otro nombre. Contacta a soporte para corregirlo.');
      await assertNameRenderable({ template: definition, recipientName: requestedName });
      await pool.execute('UPDATE certificates SET recipient_name = ? WHERE id = ?', [requestedName, existing.id]);
      record = await findCertificate(target.id, course.id);
    }
    name = record.recipient_name;
  } else {
    try {
      name = requestedName ?? validateRecipientName(target.fullName);
    } catch (error) {
      if (!requestedName) throw httpError(400, 'Escribe tu nombre completo como quieres que aparezca en la constancia.');
      throw error;
    }
    await assertNameRenderable({ template: definition, recipientName: name });
    record = await createCertificate({ userId: target.id, courseId: course.id, definition, name });
    name = record.recipient_name;
  }

  const bytes = await generateCertificatePdf({
    template: definition,
    recipientName: name,
    certificateCode: record.certificate_code,
    issuedAt: record.issued_at,
  });
  sendPdf(response, definition, bytes, record.certificate_code);
});
