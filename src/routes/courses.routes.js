import { Router } from 'express';

import { cloudinary } from '../config/cloudinary.js';
import { pool } from '../config/database.js';
import { assertEnrollmentActive, describeAccess, enrollmentAccessColumns, RENEW_ENROLLMENT_SQL, SNAPSHOT_EXPIRES_SQL } from '../lib/access.js';
import { numberLessons } from '../lib/course-structure.js';
import { assert, httpError } from '../lib/http-error.js';
import { attemptsLeft, computeLocks, computeProgress, countedLessonSql } from '../lib/quiz-logic.js';
import { assertItemUnlocked, loadCourseItems, visibleItemsFor } from '../lib/quiz-store.js';
import { instructorDisplay, isCourseManager } from '../lib/users.js';
import { requireAuth } from '../middleware/auth.js';

export const coursesRouter = Router();

function courseId(value) {
  const id = Number(value);
  assert(Number.isSafeInteger(id) && id > 0, 400, 'El identificador del curso no es válido.');
  return id;
}

function serializeCourse(row, includeDescription = false) {
  return {
    id: Number(row.id),
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle,
    ...(includeDescription ? { description: row.description } : {}),
    category: row.category,
    level: row.level,
    priceCents: Number(row.price_cents),
    accessDays: row.access_days === null || row.access_days === undefined ? null : Number(row.access_days),
    thumbnailUrl: row.thumbnail_url,
    status: row.status,
    publishedAt: row.published_at,
    owner: { id: Number(row.owner_id), fullName: row.owner_name },
    ...instructorDisplay(row, row.owner_name),
    lessonCount: Number(row.lesson_count ?? 0),
    hasCertificate: Boolean(row.certificate_template),
  };
}

async function findCourse(id) {
  const [rows] = await pool.execute(
    `SELECT c.*, u.full_name AS owner_name,
      (SELECT COUNT(*) FROM lessons l WHERE l.course_id = c.id AND l.kind = 'video') AS lesson_count
     FROM courses c JOIN users u ON u.id = c.owner_id WHERE c.id = ? LIMIT 1`,
    [id],
  );
  return rows[0];
}

async function findEnrollment(userId, id) {
  const [rows] = await pool.execute(
    `SELECT e.id, ${enrollmentAccessColumns('e')} FROM enrollments e WHERE e.user_id = ? AND e.course_id = ? LIMIT 1`,
    [userId, id],
  );
  return rows[0];
}

async function assertCourseAccess(user, id) {
  const course = await findCourse(id);
  if (!course) throw httpError(404, 'Curso no encontrado.');
  const manager = isCourseManager(user, course);
  if (!manager) {
    const enrollment = await findEnrollment(user.id, id);
    if (!enrollment) throw httpError(403, 'No tienes acceso a este curso.');
    assertEnrollmentActive(enrollment);
  }
  if (course.status !== 'published' && !manager) throw httpError(403, 'Este curso todavía no está publicado.');
  return course;
}

function materialAccessResponse(material) {
  if (material.type === 'link') return { url: material.url, expiresInSeconds: null };
  if (!material.public_id) throw httpError(404, 'El archivo no está disponible.');
  return {
    url: cloudinary.utils.private_download_url(material.public_id, null, {
      resource_type: 'raw', type: 'upload',
      expires_at: Math.floor(Date.now() / 1000) + 120,
    }),
    expiresInSeconds: 120,
  };
}

coursesRouter.get('/', async (request, response) => {
  const search = String(request.query.search ?? '').trim();
  const category = String(request.query.category ?? '').trim();
  const values = [];
  let where = "c.status = 'published'";
  if (search) {
    where += ' AND (c.title LIKE ? OR c.subtitle LIKE ? OR c.category LIKE ?)';
    const term = `%${search}%`;
    values.push(term, term, term);
  }
  if (category) {
    where += ' AND c.category = ?';
    values.push(category);
  }
  const [rows] = await pool.execute(
    `SELECT c.*, u.full_name AS owner_name,
      (SELECT COUNT(*) FROM lessons l WHERE l.course_id = c.id AND l.kind = 'video') AS lesson_count
     FROM courses c JOIN users u ON u.id = c.owner_id
     WHERE ${where} ORDER BY c.published_at DESC, c.id DESC LIMIT 100`,
    values,
  );
  response.json({ courses: rows.map((row) => serializeCourse(row)) });
});

const PROMO_SLIDE_LIMIT = 12;

// Declarada antes de '/:slug' para que "promo" no se interprete como un slug.
coursesRouter.get('/promo', async (_request, response) => {
  const [rows] = await pool.execute(
    `SELECT c.id AS course_id, c.slug, c.title, c.category, i.id AS image_id, i.image_url, i.alt_text, i.position
     FROM course_promo_images i JOIN courses c ON c.id = i.course_id
     WHERE c.status = 'published'
     ORDER BY c.published_at DESC, c.id DESC, i.position ASC, i.id ASC`,
  );
  const byCourse = new Map();
  for (const row of rows) {
    const courseKey = Number(row.course_id);
    if (!byCourse.has(courseKey)) byCourse.set(courseKey, { courseId: courseKey, slug: row.slug, title: row.title, category: row.category, images: [] });
    byCourse.get(courseKey).images.push({ id: Number(row.image_id), url: row.image_url, alt: row.alt_text || row.title, position: Number(row.position) });
  }
  const items = [...byCourse.values()];
  const slides = items.flatMap((item) => item.images.map((image) => ({ ...image, courseId: item.courseId, slug: item.slug, title: item.title, category: item.category }))).slice(0, PROMO_SLIDE_LIMIT);
  response.json({ items, slides });
});

coursesRouter.get('/me/enrollments', requireAuth, async (request, response) => {
  const [rows] = await pool.execute(
    `SELECT c.*, u.full_name AS owner_name, ${enrollmentAccessColumns('e')},
      (SELECT COUNT(*) FROM lessons l WHERE l.course_id = c.id AND ${countedLessonSql('l')}) AS progress_total,
      (SELECT COUNT(*) FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id WHERE l.course_id = c.id AND lp.user_id = ? AND lp.completed_at IS NOT NULL AND ${countedLessonSql('l')}) AS completed_lessons
     FROM enrollments e JOIN courses c ON c.id = e.course_id JOIN users u ON u.id = c.owner_id
     WHERE e.user_id = ? ORDER BY e.created_at DESC`,
    [request.user.id, request.user.id],
  );
  response.json({ courses: rows.map((row) => ({ ...serializeCourse(row), lessonCount: Number(row.progress_total), completedLessons: Number(row.completed_lessons), ...describeAccess(row) })) });
});

coursesRouter.get('/:slug', async (request, response) => {
  const [rows] = await pool.execute(
    `SELECT c.*, u.full_name AS owner_name,
      (SELECT COUNT(*) FROM lessons l WHERE l.course_id = c.id AND l.kind = 'video') AS lesson_count
     FROM courses c JOIN users u ON u.id = c.owner_id
     WHERE c.slug = ? AND c.status = 'published' LIMIT 1`,
    [request.params.slug],
  );
  const course = rows[0];
  if (!course) throw httpError(404, 'Curso no encontrado.');
  const [lessons] = await pool.execute(
    `SELECT l.id, l.title, l.description, l.duration_seconds, l.position, l.is_preview, l.section_id, s.title AS section_title, s.position AS section_position
     FROM lessons l LEFT JOIN course_sections s ON s.id = l.section_id
     WHERE l.course_id = ? AND l.kind = 'video' ORDER BY COALESCE(s.position, 0) ASC, l.position ASC`,
    [course.id],
  );
  const [publicQuizzes] = await pool.execute(
    `SELECT l.id, l.title, l.section_id, l.position, q.label, q.is_required
     FROM lessons l JOIN quizzes q ON q.lesson_id = l.id LEFT JOIN course_sections s ON s.id = l.section_id
     WHERE l.course_id = ? AND l.kind = 'quiz' AND EXISTS (SELECT 1 FROM quiz_questions qq WHERE qq.quiz_id = l.id)
     ORDER BY COALESCE(s.position, 0) ASC, l.position ASC`,
    [course.id],
  );
  const [sections] = await pool.execute('SELECT id, title, description, position FROM course_sections WHERE course_id = ? ORDER BY position ASC, id ASC', [course.id]);
  const [promoImages] = await pool.execute('SELECT id, image_url, alt_text, position FROM course_promo_images WHERE course_id = ? ORDER BY position ASC, id ASC', [course.id]);
  response.json({ course: { ...serializeCourse(course, true), promoImages: promoImages.map((image) => ({ id: Number(image.id), url: image.image_url, alt: image.alt_text || course.title, position: Number(image.position) })), sections: sections.map((section) => ({ id: Number(section.id), title: section.title, description: section.description, position: Number(section.position) })), lessons: numberLessons(lessons).map((lesson) => ({ id: Number(lesson.id), title: lesson.title, description: lesson.description, durationSeconds: Number(lesson.duration_seconds), position: Number(lesson.position), lessonNumber: lesson.lessonNumber, sectionId: lesson.section_id ? Number(lesson.section_id) : null, isPreview: Boolean(lesson.is_preview) })), quizzes: publicQuizzes.map((quiz) => ({ id: Number(quiz.id), title: quiz.title, sectionId: quiz.section_id ? Number(quiz.section_id) : null, position: Number(quiz.position), label: quiz.label, isRequired: Boolean(quiz.is_required) })) } });
});

coursesRouter.post('/:courseId/enroll', requireAuth, async (request, response) => {
  const id = courseId(request.params.courseId);
  const course = await findCourse(id);
  if (!course || course.status !== 'published') throw httpError(404, 'Curso no disponible para inscripción.');
  if (Number(course.price_cents) > 0 && !isCourseManager(request.user, course) && !(await findEnrollment(request.user.id, id))) {
    throw httpError(402, 'Este curso es de pago. Completa el pago para obtener acceso.', true, 'PAYMENT_REQUIRED');
  }
  const [inserted] = await pool.execute(
    `INSERT IGNORE INTO enrollments (user_id, course_id, enrolled_by_id, expires_at) VALUES (?, ?, ?, ${SNAPSHOT_EXPIRES_SQL})`,
    [request.user.id, id, request.user.id, id],
  );
  let renewed = false;
  if (!inserted.affectedRows) {
    const existing = await findEnrollment(request.user.id, id);
    if (describeAccess(existing).isExpired) {
      if (Number(course.price_cents) > 0) throw httpError(409, 'Tu acceso venció. Renueva el acceso pagando de nuevo el curso.', true, 'RENEWAL_REQUIRED');
      await pool.execute(RENEW_ENROLLMENT_SQL, [request.user.id, existing.id]);
      renewed = true;
    }
  }
  const enrollment = describeAccess(await findEnrollment(request.user.id, id));
  response.status(inserted.affectedRows ? 201 : 200).json({ enrollment: { userId: request.user.id, courseId: id, expiresAt: enrollment.expiresAt, hasLimit: enrollment.hasLimit }, renewed });
});

coursesRouter.post('/:courseId/materials/:materialId/access', requireAuth, async (request, response) => {
  const id = courseId(request.params.courseId); const materialId = courseId(request.params.materialId);
  await assertCourseAccess(request.user, id);
  const [rows] = await pool.execute('SELECT type, url, public_id FROM course_materials WHERE id = ? AND course_id = ? LIMIT 1', [materialId, id]);
  if (!rows[0]) throw httpError(404, 'Material no encontrado.');
  response.json({ access: materialAccessResponse(rows[0]) });
});

coursesRouter.post('/:courseId/lessons/:lessonId/materials/:materialId/access', requireAuth, async (request, response) => {
  const id = courseId(request.params.courseId); const lessonId = courseId(request.params.lessonId); const materialId = courseId(request.params.materialId);
  const accessCourse = await assertCourseAccess(request.user, id);
  await assertItemUnlocked({ user: request.user, course: accessCourse, manager: isCourseManager(request.user, accessCourse), itemId: lessonId });
  const [rows] = await pool.execute(
    'SELECT m.type, m.url, m.public_id FROM lesson_materials m JOIN lessons l ON l.id = m.lesson_id WHERE m.id = ? AND m.lesson_id = ? AND l.course_id = ? LIMIT 1',
    [materialId, lessonId, id],
  );
  if (!rows[0]) throw httpError(404, 'Material de clase no encontrado.');
  response.json({ access: materialAccessResponse(rows[0]) });
});

coursesRouter.get('/:courseId/learn', requireAuth, async (request, response) => {
  const id = courseId(request.params.courseId);
  const course = await findCourse(id);
  if (!course) throw httpError(404, 'Curso no encontrado.');
  const manager = isCourseManager(request.user, course);
  let enrollment;
  if (!manager) {
    enrollment = await findEnrollment(request.user.id, id);
    if (!enrollment) throw httpError(403, 'No estás inscrito en este curso.');
    assertEnrollmentActive(enrollment);
  }
  if (course.status !== 'published' && !manager) throw httpError(403, 'Este curso todavía no está publicado.');
  const allItems = await loadCourseItems(pool, id, request.user.id);
  const lessons = visibleItemsFor(allItems, manager);
  const locks = manager ? new Map() : computeLocks(lessons);
  const progress = computeProgress(lessons);
  const lessonNumbers = new Map(numberLessons(lessons.map((lesson) => ({ id: lesson.id, kind: lesson.kind, position: lesson.position, sectionPosition: lesson.sectionPosition }))).map((lesson) => [Number(lesson.id), lesson.lessonNumber]));
  const [positionRows] = await pool.execute('SELECT lp.lesson_id, lp.last_position_seconds FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id WHERE l.course_id = ? AND lp.user_id = ?', [id, request.user.id]);
  const lastPositions = new Map(positionRows.map((row) => [Number(row.lesson_id), Number(row.last_position_seconds)]));
  const [attemptRows] = await pool.execute(
    'SELECT a.quiz_id, COUNT(*) AS used, MAX(a.score_percent) AS best, MAX(a.passed) AS passed FROM quiz_attempts a JOIN lessons l ON l.id = a.quiz_id WHERE l.course_id = ? AND a.user_id = ? GROUP BY a.quiz_id',
    [id, request.user.id],
  );
  const attemptsByQuiz = new Map(attemptRows.map((row) => [Number(row.quiz_id), { used: Number(row.used), best: row.best === null ? null : Number(row.best), passed: Boolean(row.passed) }]));
  const [materials] = await pool.execute("SELECT id, type, category, position, title, description, url, original_filename, mime_type, size_bytes FROM course_materials WHERE course_id = ? ORDER BY (category = 'terms') DESC, position ASC, id DESC", [id]);
  const [lessonMaterials] = await pool.execute(
    'SELECT m.id, m.lesson_id, m.type, m.title, m.description, m.url, m.original_filename, m.mime_type, m.size_bytes FROM lesson_materials m JOIN lessons l ON l.id = m.lesson_id WHERE l.course_id = ? ORDER BY m.created_at DESC, m.id DESC',
    [id],
  );
  const materialsByLesson = new Map();
  for (const material of lessonMaterials) {
    const lessonId = Number(material.lesson_id);
    const serialized = { id: Number(material.id), type: material.type, title: material.title, description: material.description, url: material.url, originalFilename: material.original_filename, mimeType: material.mime_type, sizeBytes: material.size_bytes === null ? null : Number(material.size_bytes) };
    materialsByLesson.set(lessonId, [...(materialsByLesson.get(lessonId) ?? []), serialized]);
  }
  response.json({
    course: serializeCourse(course, true),
    access: describeAccess(enrollment),
    progress,
    lessons: lessons.map((lesson) => {
      const lock = locks.get(lesson.id) ?? null;
      const locked = Boolean(lock);
      const isQuiz = lesson.kind === 'quiz';
      const attempts = attemptsByQuiz.get(lesson.id) ?? { used: 0, best: null, passed: false };
      return {
        id: lesson.id, kind: lesson.kind, title: lesson.title, description: lesson.description,
        videoUrl: locked || isQuiz ? null : lesson.videoUrl,
        durationSeconds: lesson.durationSeconds, position: lesson.position, lessonNumber: lessonNumbers.get(lesson.id),
        sectionId: lesson.sectionTitle === null ? null : lesson.sectionId, sectionTitle: lesson.sectionTitle || 'Contenido principal', sectionPosition: lesson.sectionPosition,
        completedAt: lesson.completedAt, lastPositionSeconds: locked ? 0 : (lastPositions.get(lesson.id) ?? 0),
        locked, lockedBy: lock, counts: !isQuiz || lesson.required,
        materials: locked || isQuiz ? [] : (materialsByLesson.get(lesson.id) ?? []),
        ...(isQuiz ? { quiz: { label: lesson.quiz.label, isRequired: lesson.required, passingPercent: lesson.quiz.passingPercent, maxAttempts: lesson.quiz.maxAttempts, questionCount: lesson.questionCount, attemptsUsed: attempts.used, attemptsLeft: attemptsLeft(lesson.quiz.maxAttempts, attempts.used), bestScorePercent: attempts.best, passed: attempts.passed } } : {}),
      };
    }),
    materials: materials.map((material) => ({ id: Number(material.id), type: material.type, category: material.category, position: Number(material.position), title: material.title, description: material.description, url: material.url, originalFilename: material.original_filename, mimeType: material.mime_type, sizeBytes: material.size_bytes === null ? null : Number(material.size_bytes) })),
  });
});

coursesRouter.put('/lessons/:lessonId/progress', requireAuth, async (request, response) => {
  const lessonId = courseId(request.params.lessonId);
  const completed = Boolean(request.body?.completed);
  const lastPositionSeconds = Math.max(0, Number(request.body?.lastPositionSeconds ?? 0));
  assert(Number.isSafeInteger(lastPositionSeconds), 400, 'La posición del video no es válida.');
  const [rows] = await pool.execute(
    `SELECT c.id AS course_id, c.owner_id, l.kind FROM lessons l JOIN courses c ON c.id = l.course_id WHERE l.id = ? LIMIT 1`,
    [lessonId],
  );
  const lesson = rows[0];
  if (!lesson) throw httpError(404, 'Lección no encontrada.');
  if (lesson.kind === 'quiz') throw httpError(400, 'El avance de una evaluación se registra al aprobarla.', true, 'QUIZ_PROGRESS_FORBIDDEN');
  if (!isCourseManager(request.user, lesson)) {
    const enrollment = await findEnrollment(request.user.id, lesson.course_id);
    if (!enrollment) throw httpError(403, 'No puedes modificar el progreso de esta lección.');
    assertEnrollmentActive(enrollment);
    await assertItemUnlocked({ user: request.user, course: { id: lesson.course_id }, manager: false, itemId: lessonId });
  }
  await pool.execute(
    `INSERT INTO lesson_progress (user_id, lesson_id, completed_at, last_position_seconds)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE completed_at = VALUES(completed_at), last_position_seconds = VALUES(last_position_seconds)`,
    [request.user.id, lessonId, completed ? new Date() : null, lastPositionSeconds],
  );
  response.json({ progress: { lessonId, completed, lastPositionSeconds } });
});
