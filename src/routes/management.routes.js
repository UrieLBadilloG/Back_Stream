import bcrypt from 'bcryptjs';
import { Router } from 'express';

import { pool } from '../config/database.js';
import { DEFAULT_ACCESS_DAYS, describeAccess, enrollmentAccessColumns, MAX_ACCESS_DAYS, MIN_ACCESS_DAYS, parseAccessDays, RENEW_ENROLLMENT_SQL, SNAPSHOT_EXPIRES_SQL } from '../lib/access.js';
import { assert, httpError } from '../lib/http-error.js';
import { normalizeEmail, ROLES, serializeUser } from '../lib/users.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

export const managementRouter = Router();
export const superAdminRouter = Router();

const courseLevels = ['beginner', 'intermediate', 'advanced'];

function idOf(value, label = 'identificador') { const id = Number(value); assert(Number.isSafeInteger(id) && id > 0, 400, `El ${label} no es válido.`); return id; }
function text(value, label, max, required = true) { const result = String(value ?? '').trim(); if (required) assert(result.length > 0, 400, `${label} es obligatorio.`); assert(result.length <= max, 400, `${label} supera la longitud permitida.`); return result; }
function slugify(value) { return String(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 155) || `curso-${Date.now()}`; }

async function managedCourse(user, id) {
  const [rows] = await pool.execute('SELECT * FROM courses WHERE id = ? LIMIT 1', [id]);
  const course = rows[0];
  if (!course) throw httpError(404, 'Curso no encontrado.');
  if (user.role !== 'super_admin' && Number(course.owner_id) !== user.id) throw httpError(403, 'Solo puedes administrar tus propios cursos.');
  return course;
}

async function assertCourseOwner(ownerId) {
  const [rows] = await pool.execute('SELECT id, role, is_active FROM users WHERE id = ? LIMIT 1', [ownerId]);
  const owner = rows[0];
  if (!owner || !owner.is_active || !['admin', 'super_admin'].includes(owner.role)) throw httpError(400, 'El propietario debe ser un administrador activo.');
}

managementRouter.use(requireAuth, requireRole('admin', 'super_admin'));

managementRouter.get('/courses', async (request, response) => {
  const values = []; const where = request.user.role === 'super_admin' ? '1 = 1' : 'c.owner_id = ?';
  if (request.user.role !== 'super_admin') values.push(request.user.id);
  const [rows] = await pool.execute(
    `SELECT c.id, c.owner_id, c.slug, c.title, c.category, c.level, c.status, c.access_days, c.updated_at, u.full_name AS owner_name,
      (SELECT COUNT(*) FROM lessons l WHERE l.course_id = c.id AND l.kind = 'video') AS lesson_count
     FROM courses c JOIN users u ON u.id = c.owner_id WHERE ${where} ORDER BY c.updated_at DESC`, values,
  );
  response.json({ courses: rows.map((course) => ({ id: Number(course.id), ownerId: Number(course.owner_id), ownerName: course.owner_name, slug: course.slug, title: course.title, category: course.category, level: course.level, status: course.status, accessDays: course.access_days === null ? null : Number(course.access_days), lessonCount: Number(course.lesson_count), updatedAt: course.updated_at })) });
});

managementRouter.post('/courses', async (request, response) => {
  const { title, subtitle = '', description, category, level = 'beginner', priceCents = 0, thumbnailUrl = null } = request.body ?? {};
  assert(courseLevels.includes(level), 400, 'El nivel no es válido.');
  const ownerId = request.user.role === 'super_admin' && request.body?.ownerId ? idOf(request.body.ownerId, 'propietario') : request.user.id;
  await assertCourseOwner(ownerId);
  const requestedAccessDays = parseAccessDays(request.body?.accessDays);
  const accessDays = requestedAccessDays === undefined ? DEFAULT_ACCESS_DAYS : requestedAccessDays;
  const courseTitle = text(title, 'El título', 180); const slug = `${slugify(courseTitle)}-${Date.now().toString(36)}`;
  const [result] = await pool.execute(
    `INSERT INTO courses (owner_id, slug, title, subtitle, description, category, level, price_cents, access_days, thumbnail_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [ownerId, slug, courseTitle, text(subtitle, 'El subtítulo', 255, false), text(description, 'La descripción', 10000), text(category, 'La categoría', 80), level, Math.max(0, Number(priceCents) || 0), accessDays, thumbnailUrl || null],
  );
  response.status(201).json({ course: { id: Number(result.insertId), ownerId, slug, title: courseTitle, status: 'draft' } });
});

managementRouter.patch('/courses/:courseId', async (request, response) => {
  const id = idOf(request.params.courseId, 'curso'); await managedCourse(request.user, id);
  const allowed = { title: ['title', 180], subtitle: ['subtitle', 255], description: ['description', 10000], category: ['category', 80], thumbnailUrl: ['thumbnail_url', 2048] };
  const assignments = []; const values = [];
  for (const [input, [column, max]] of Object.entries(allowed)) if (Object.hasOwn(request.body ?? {}, input)) { assignments.push(`${column} = ?`); values.push(text(request.body[input], input, max, input !== 'thumbnailUrl')); }
  if (Object.hasOwn(request.body ?? {}, 'level')) { assert(courseLevels.includes(request.body.level), 400, 'El nivel no es válido.'); assignments.push('level = ?'); values.push(request.body.level); }
  if (Object.hasOwn(request.body ?? {}, 'priceCents')) { assignments.push('price_cents = ?'); values.push(Math.max(0, Number(request.body.priceCents) || 0)); }
  if (Object.hasOwn(request.body ?? {}, 'accessDays')) { assignments.push('access_days = ?'); values.push(parseAccessDays(request.body.accessDays) ?? null); }
  for (const [input, column, max] of [['instructorName', 'instructor_name', 120], ['instructorTitle', 'instructor_title', 160]]) {
    if (!Object.hasOwn(request.body ?? {}, input)) continue;
    assert(request.body[input] === null || typeof request.body[input] === 'string', 400, `${input} debe ser texto.`);
    assignments.push(`${column} = ?`); values.push(text(request.body[input], input, max, false) || null);
  }
  assert(assignments.length > 0, 400, 'No se recibió ningún campo actualizable.');
  values.push(id); await pool.execute(`UPDATE courses SET ${assignments.join(', ')} WHERE id = ?`, values);
  response.json({ message: 'Curso actualizado.' });
});

managementRouter.post('/courses/:courseId/lessons', async (request, response) => {
  const courseId = idOf(request.params.courseId, 'curso'); await managedCourse(request.user, courseId);
  const { title, description = '', videoUrl = null, videoPublicId = null, durationSeconds = 0, position, isPreview = false } = request.body ?? {};
  const lessonPosition = idOf(position, 'posición');
  const [result] = await pool.execute(
    `INSERT INTO lessons (course_id, title, description, video_url, video_public_id, duration_seconds, position, is_preview)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [courseId, text(title, 'El título', 180), text(description, 'La descripción', 10000, false), videoUrl || null, videoPublicId || null, Math.max(0, Number(durationSeconds) || 0), lessonPosition, Boolean(isPreview)],
  );
  response.status(201).json({ lesson: { id: Number(result.insertId), courseId, position: lessonPosition } });
});

managementRouter.post('/courses/:courseId/publish', async (request, response) => {
  const id = idOf(request.params.courseId, 'curso'); await managedCourse(request.user, id);
  const [lessons] = await pool.execute('SELECT COUNT(*) AS count FROM lessons WHERE course_id = ? AND kind = \'video\' AND video_url IS NOT NULL AND video_url <> \'\'', [id]);
  assert(Number(lessons[0].count) > 0, 400, 'Agrega al menos una clase con video antes de publicar.');
  const [emptyQuizzes] = await pool.execute("SELECT l.title FROM lessons l WHERE l.course_id = ? AND l.kind = 'quiz' AND NOT EXISTS (SELECT 1 FROM quiz_questions qq WHERE qq.quiz_id = l.id) ORDER BY l.position, l.id LIMIT 1", [id]);
  if (emptyQuizzes[0]) throw httpError(409, `Agrega preguntas a la evaluación «${emptyQuizzes[0].title}» o elimínala antes de publicar.`, true, 'QUIZ_INCOMPLETE');
  await pool.execute("UPDATE courses SET status = 'published', published_at = COALESCE(published_at, CURRENT_TIMESTAMP) WHERE id = ?", [id]);
  response.json({ message: 'Curso publicado.' });
});

managementRouter.post('/courses/:courseId/unpublish', async (request, response) => {
  const id = idOf(request.params.courseId, 'curso');
  const course = await managedCourse(request.user, id);
  if (course.status !== 'published') throw httpError(409, 'El curso ya está fuera del catálogo.');
  await pool.execute("UPDATE courses SET status = 'draft' WHERE id = ?", [id]);
  response.json({ message: 'Curso retirado del catálogo. Los alumnos inscritos conservan su acceso.' });
});

superAdminRouter.use(requireAuth, requireRole('super_admin'));

superAdminRouter.get('/users', async (_request, response) => {
  const [rows] = await pool.execute('SELECT id, full_name, email, role, is_active, created_at FROM users ORDER BY created_at DESC LIMIT 500');
  response.json({ users: rows.map(serializeUser) });
});

superAdminRouter.post('/users', async (request, response) => {
  const { fullName, email, password, role = 'student' } = request.body ?? {};
  assert(ROLES.includes(role), 400, 'El rol no es válido.');
  assert(typeof password === 'string' && password.length >= 10 && password.length <= 128, 400, 'La contraseña debe tener entre 10 y 128 caracteres.');
  const normalizedEmail = normalizeEmail(email); assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail), 400, 'Ingresa un correo válido.');
  try {
    const [result] = await pool.execute('INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)', [text(fullName, 'El nombre', 120), normalizedEmail, await bcrypt.hash(password, 12), role]);
    const [rows] = await pool.execute('SELECT id, full_name, email, role, is_active, created_at FROM users WHERE id = ?', [result.insertId]);
    response.status(201).json({ user: serializeUser(rows[0]) });
  } catch (error) { if (error.code === 'ER_DUP_ENTRY') throw httpError(409, 'Ya existe una cuenta con ese correo.'); throw error; }
});

superAdminRouter.patch('/users/:userId', async (request, response) => {
  const userId = idOf(request.params.userId, 'usuario'); const assignments = []; const values = [];
  const changesOwnAccess = userId === request.user.id && (Object.hasOwn(request.body ?? {}, 'role') || Object.hasOwn(request.body ?? {}, 'isActive'));
  if (changesOwnAccess) throw httpError(400, 'No puedes cambiar tu propio rol ni desactivar tu propia cuenta desde administración.');
  if (Object.hasOwn(request.body ?? {}, 'role')) { assert(ROLES.includes(request.body.role), 400, 'El rol no es válido.'); assignments.push('role = ?'); values.push(request.body.role); }
  if (Object.hasOwn(request.body ?? {}, 'isActive')) { assignments.push('is_active = ?'); values.push(Boolean(request.body.isActive)); }
  assert(assignments.length > 0, 400, 'No se recibió ningún cambio.'); values.push(userId); const [result] = await pool.execute(`UPDATE users SET ${assignments.join(', ')} WHERE id = ?`, values);
  if (!result.affectedRows) throw httpError(404, 'Usuario no encontrado.');
  response.json({ message: 'Usuario actualizado.' });
});

superAdminRouter.post('/courses/:courseId/owner', async (request, response) => {
  const courseId = idOf(request.params.courseId, 'curso'); const ownerId = idOf(request.body?.ownerId, 'propietario'); await assertCourseOwner(ownerId);
  const [result] = await pool.execute('UPDATE courses SET owner_id = ? WHERE id = ?', [ownerId, courseId]); if (!result.affectedRows) throw httpError(404, 'Curso no encontrado.');
  response.json({ message: 'Propietario del curso actualizado.' });
});

superAdminRouter.post('/enrollments', async (request, response) => {
  const userId = idOf(request.body?.userId, 'usuario'); const courseId = idOf(request.body?.courseId, 'curso');
  const [users] = await pool.execute("SELECT id, role, is_active FROM users WHERE id = ? AND role = 'student' LIMIT 1", [userId]);
  if (!users[0]?.is_active) throw httpError(400, 'La inscripción requiere un alumno activo.');
  const [courses] = await pool.execute("SELECT id FROM courses WHERE id = ? AND status = 'published' LIMIT 1", [courseId]);
  if (!courses[0]) throw httpError(400, 'El curso debe estar publicado antes de inscribir alumnos.');
  const [inserted] = await pool.execute(
    `INSERT IGNORE INTO enrollments (user_id, course_id, enrolled_by_id, expires_at) VALUES (?, ?, ?, ${SNAPSHOT_EXPIRES_SQL})`,
    [userId, courseId, request.user.id, courseId],
  );
  const created = Boolean(inserted.affectedRows);
  const [existing] = await pool.execute('SELECT id, expires_at IS NOT NULL AS had_limit FROM enrollments WHERE user_id = ? AND course_id = ? LIMIT 1', [userId, courseId]);
  let renewed = false;
  if (!created && existing[0]?.had_limit) {
    await pool.execute(RENEW_ENROLLMENT_SQL, [request.user.id, existing[0].id]);
    renewed = true;
  }
  const [rows] = await pool.execute(`SELECT ${enrollmentAccessColumns('e')} FROM enrollments e WHERE e.user_id = ? AND e.course_id = ? LIMIT 1`, [userId, courseId]);
  const access = describeAccess(rows[0]);
  response.status(created ? 201 : 200).json({ enrollment: { userId, courseId, enrolledById: request.user.id, expiresAt: access.expiresAt, hasLimit: access.hasLimit }, renewed });
});

superAdminRouter.patch('/enrollments/:enrollmentId', async (request, response) => {
  const enrollmentId = idOf(request.params.enrollmentId, 'inscripción');
  const body = request.body ?? {};
  const hasExtend = Object.hasOwn(body, 'extendDays'); const hasUnlimited = Object.hasOwn(body, 'unlimited');
  assert(hasExtend !== hasUnlimited, 400, 'Envía exactamente una opción: extendDays o unlimited.');
  if (hasExtend) {
    const days = typeof body.extendDays === 'number' ? body.extendDays : NaN;
    assert(Number.isInteger(days) && days >= MIN_ACCESS_DAYS && days <= MAX_ACCESS_DAYS, 400, `extendDays debe ser un entero entre ${MIN_ACCESS_DAYS} y ${MAX_ACCESS_DAYS}.`);
    const [result] = await pool.execute(
      'UPDATE enrollments SET expires_at = DATE_ADD(GREATEST(COALESCE(expires_at, UTC_TIMESTAMP()), UTC_TIMESTAMP()), INTERVAL ? DAY) WHERE id = ?',
      [days, enrollmentId],
    );
    if (!result.affectedRows) throw httpError(404, 'Inscripción no encontrada.');
  } else {
    assert(body.unlimited === true, 400, 'unlimited debe ser true.');
    const [result] = await pool.execute('UPDATE enrollments SET expires_at = NULL WHERE id = ?', [enrollmentId]);
    if (!result.affectedRows) throw httpError(404, 'Inscripción no encontrada.');
  }
  const [rows] = await pool.execute(`SELECT e.id, ${enrollmentAccessColumns('e')} FROM enrollments e WHERE e.id = ? LIMIT 1`, [enrollmentId]);
  response.json({ enrollment: { id: enrollmentId, ...describeAccess(rows[0]) } });
});
