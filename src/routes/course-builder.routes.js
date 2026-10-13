import { Router } from 'express';

import { cloudinary } from '../config/cloudinary.js';
import { pool } from '../config/database.js';
import { env } from '../config/env.js';
import { DOCUMENT_CATEGORIES, PROMO_IMAGE_LIMIT, isCloudinaryImageUrl, numberLessons, planLessonLayout, planOrder, planSectionOrder } from '../lib/course-structure.js';
import { assert, httpError } from '../lib/http-error.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

export const courseBuilderRouter = Router();
const POSITION_OFFSET = 1000000;
async function inTransaction(work) { const connection = await pool.getConnection(); try { await connection.beginTransaction(); const result = await work(connection); await connection.commit(); return result; } catch (error) { try { await connection.rollback(); } catch { /* La conexión puede haberse cerrado; se propaga el error original. */ } throw error; } finally { connection.release(); } }
function serializePromoImage(row) { return { id: Number(row.id), url: row.image_url, publicId: row.public_id, altText: row.alt_text, position: Number(row.position), createdAt: row.created_at }; }
function documentCategory(value) { const category = value ?? 'document'; assert(typeof category === 'string' && DOCUMENT_CATEGORIES.includes(category), 400, 'La categoría del documento no es válida.'); return category; }
function idOf(value, label) { const id = Number(value); assert(Number.isSafeInteger(id) && id > 0, 400, `${label} no es válido.`); return id; }
function clean(value, label, max, required = true) { const result = String(value ?? '').trim(); if (required) assert(result.length > 0, 400, `${label} es obligatorio.`); assert(result.length <= max, 400, `${label} supera el límite permitido.`); return result; }
function videoUrl(value) { const url = clean(value, 'La URL del video', 2048); try { const parsed = new URL(url); assert(parsed.protocol === 'https:', 400, 'La URL del video debe usar HTTPS.'); } catch (error) { if (error.statusCode) throw error; throw httpError(400, 'La URL del video no es válida.'); } return url; }
function durationSeconds(value) { const duration = Number(value); assert(Number.isSafeInteger(duration) && duration > 0, 400, 'La duración del video debe ser un entero positivo.'); return duration; }
async function managedCourse(user, courseId) { const [rows] = await pool.execute('SELECT * FROM courses WHERE id = ? LIMIT 1', [courseId]); const course = rows[0]; if (!course) throw httpError(404, 'Curso no encontrado.'); if (user.role !== 'super_admin' && Number(course.owner_id) !== user.id) throw httpError(403, 'No puedes administrar este curso.'); return course; }
function secureUrl(value, label = 'La URL') { const result = clean(value, label, 2048); try { const parsed = new URL(result); assert(parsed.protocol === 'https:', 400, `${label} debe usar HTTPS.`); return parsed.href; } catch (error) { if (error.statusCode) throw error; throw httpError(400, `${label} no es válida.`); } }
function serializeMaterial(row) { return { id: Number(row.id), type: row.type, ...(row.category === undefined ? {} : { category: row.category, position: Number(row.position) }), title: row.title, description: row.description, url: row.url, publicId: row.public_id, originalFilename: row.original_filename, mimeType: row.mime_type, sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes), createdAt: row.created_at }; }
const MATERIAL_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/zip', 'text/plain']);
const MAX_MATERIAL_BYTES = 25 * 1024 * 1024;
courseBuilderRouter.use(requireAuth, requireRole('admin', 'super_admin'));
courseBuilderRouter.get('/courses/:courseId/editor', async (request, response) => {
  const course = await managedCourse(request.user, idOf(request.params.courseId, 'Curso'));
  const [sections] = await pool.execute('SELECT id, title, description, position FROM course_sections WHERE course_id = ? ORDER BY position', [course.id]);
  const [lessons] = await pool.execute(
    `SELECT l.id, l.section_id, l.kind, l.title, l.description, l.duration_seconds, l.position, l.video_url, s.position AS section_position,
            q.label AS quiz_label, q.is_required AS quiz_is_required, q.passing_percent AS quiz_passing_percent, q.max_attempts AS quiz_max_attempts, q.show_answers AS quiz_show_answers,
            (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = l.id) AS quiz_question_count
     FROM lessons l
     LEFT JOIN course_sections s ON s.id = l.section_id
     LEFT JOIN quizzes q ON q.lesson_id = l.id
     WHERE l.course_id = ? ORDER BY COALESCE(s.position, 0), l.position`,
    [course.id],
  );
  const lessonNumbers = new Map(numberLessons(lessons).map((lesson) => [Number(lesson.id), lesson.lessonNumber]));
  const [[owner]] = await pool.execute('SELECT full_name FROM users WHERE id = ? LIMIT 1', [course.owner_id]);
  const [materials] = await pool.execute("SELECT * FROM course_materials WHERE course_id = ? ORDER BY (category = 'terms') DESC, position ASC, id DESC", [course.id]);
  const [promoImages] = await pool.execute('SELECT * FROM course_promo_images WHERE course_id = ? ORDER BY position ASC, id ASC', [course.id]);
  const [lessonMaterials] = await pool.execute(
    'SELECT m.* FROM lesson_materials m JOIN lessons l ON l.id = m.lesson_id WHERE l.course_id = ? ORDER BY m.created_at DESC, m.id DESC',
    [course.id],
  );
  const materialsByLesson = new Map();
  for (const material of lessonMaterials) {
    const lessonId = Number(material.lesson_id);
    materialsByLesson.set(lessonId, [...(materialsByLesson.get(lessonId) ?? []), serializeMaterial(material)]);
  }
  response.json({
    course: { id: Number(course.id), slug: course.slug, title: course.title, subtitle: course.subtitle, category: course.category, level: course.level, priceCents: Number(course.price_cents), accessDays: course.access_days === null ? null : Number(course.access_days), thumbnailUrl: course.thumbnail_url, ownerName: owner?.full_name ?? null, instructorName: course.instructor_name ?? null, instructorTitle: course.instructor_title ?? null, status: course.status, certificateTemplate: course.certificate_template ?? null },
    sections: sections.map((section) => ({
      id: Number(section.id), title: section.title, description: section.description, position: Number(section.position),
      lessons: lessons.filter((lesson) => Number(lesson.section_id) === Number(section.id)).map((lesson) => (lesson.kind === 'quiz'
        ? {
          id: Number(lesson.id), kind: 'quiz', title: lesson.title, description: lesson.description, durationSeconds: Number(lesson.duration_seconds), position: Number(lesson.position), lessonNumber: null, videoUrl: null,
          materials: [],
          quiz: { label: lesson.quiz_label, isRequired: Boolean(lesson.quiz_is_required), passingPercent: Number(lesson.quiz_passing_percent), maxAttempts: lesson.quiz_max_attempts === null ? null : Number(lesson.quiz_max_attempts), showAnswers: lesson.quiz_show_answers, questionCount: Number(lesson.quiz_question_count) },
        }
        : {
          id: Number(lesson.id), kind: 'video', title: lesson.title, description: lesson.description, durationSeconds: Number(lesson.duration_seconds), position: Number(lesson.position), lessonNumber: lessonNumbers.get(Number(lesson.id)), videoUrl: lesson.video_url,
          materials: materialsByLesson.get(Number(lesson.id)) ?? [],
        })),
    })),
    materials: materials.map(serializeMaterial),
    promoImages: promoImages.map(serializePromoImage),
  });
});
courseBuilderRouter.post('/courses/:courseId/sections', async (request, response) => { const course = await managedCourse(request.user, idOf(request.params.courseId, 'Curso')); const title = clean(request.body?.title, 'El título de sección', 180); const description = clean(request.body?.description, 'La descripción', 10000, false); const [[position]] = await pool.execute('SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM course_sections WHERE course_id = ?', [course.id]); const [result] = await pool.execute('INSERT INTO course_sections (course_id, title, description, position) VALUES (?, ?, ?, ?)', [course.id, title, description, position.next_position]); response.status(201).json({ section: { id: Number(result.insertId), title, description, position: Number(position.next_position) } }); });
courseBuilderRouter.post('/sections/:sectionId/lessons', async (request, response) => { const sectionId = idOf(request.params.sectionId, 'Sección'); const [sections] = await pool.execute('SELECT s.*, c.owner_id FROM course_sections s JOIN courses c ON c.id = s.course_id WHERE s.id = ? LIMIT 1', [sectionId]); const section = sections[0]; if (!section) throw httpError(404, 'Sección no encontrada.'); if (request.user.role !== 'super_admin' && Number(section.owner_id) !== request.user.id) throw httpError(403, 'No puedes crear clases en esta sección.'); const title = clean(request.body?.title, 'El título de clase', 180); const description = clean(request.body?.description, 'La descripción', 10000, false); const uploadedVideoUrl = videoUrl(request.body?.videoUrl); const uploadedVideoPublicId = clean(request.body?.videoPublicId, 'El identificador público del video', 255); const uploadedDurationSeconds = durationSeconds(request.body?.durationSeconds); const [[position]] = await pool.execute('SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM lessons WHERE course_id = ?', [section.course_id]); const [result] = await pool.execute('INSERT INTO lessons (course_id, section_id, title, description, video_url, video_public_id, duration_seconds, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [section.course_id, sectionId, title, description, uploadedVideoUrl, uploadedVideoPublicId, uploadedDurationSeconds, position.next_position]); response.status(201).json({ lesson: { id: Number(result.insertId), title, position: Number(position.next_position), videoUrl: uploadedVideoUrl, durationSeconds: uploadedDurationSeconds } }); });

courseBuilderRouter.patch('/sections/:sectionId/lessons/:lessonId', async (request, response) => {
  const sectionId = idOf(request.params.sectionId, 'Sección'); const lessonId = idOf(request.params.lessonId, 'Clase');
  const [lessons] = await pool.execute(
    'SELECT l.*, c.owner_id FROM lessons l JOIN course_sections s ON s.id = l.section_id JOIN courses c ON c.id = s.course_id WHERE l.id = ? AND l.section_id = ? LIMIT 1',
    [lessonId, sectionId],
  );
  const lesson = lessons[0];
  if (!lesson) throw httpError(404, 'Clase no encontrada en esta sección.');
  if (request.user.role !== 'super_admin' && Number(lesson.owner_id) !== request.user.id) throw httpError(403, 'No puedes editar clases en esta sección.');
  assert(lesson.kind !== 'quiz', 400, 'Las evaluaciones se editan desde el editor de evaluaciones.');

  const title = clean(request.body?.title, 'El título de clase', 180);
  const description = clean(request.body?.description, 'La descripción', 10000, false);
  const videoFields = ['videoUrl', 'videoPublicId', 'durationSeconds'];
  const replacesVideo = videoFields.some((field) => Object.hasOwn(request.body ?? {}, field));
  assert(!replacesVideo || videoFields.every((field) => Object.hasOwn(request.body ?? {}, field)), 400, 'Para reemplazar el video debes enviar URL, identificador público y duración.');

  const nextVideoUrl = replacesVideo ? videoUrl(request.body.videoUrl) : lesson.video_url;
  const nextVideoPublicId = replacesVideo ? clean(request.body.videoPublicId, 'El identificador público del video', 255) : lesson.video_public_id;
  const nextDurationSeconds = replacesVideo ? durationSeconds(request.body.durationSeconds) : Number(lesson.duration_seconds);
  await pool.execute(
    'UPDATE lessons SET title = ?, description = ?, video_url = ?, video_public_id = ?, duration_seconds = ? WHERE id = ?',
    [title, description, nextVideoUrl, nextVideoPublicId, nextDurationSeconds, lessonId],
  );
  if (replacesVideo && lesson.video_public_id && lesson.video_public_id !== nextVideoPublicId) {
    try { await cloudinary.uploader.destroy(lesson.video_public_id, { resource_type: 'video', invalidate: true }); } catch { /* El contenido actualizado debe permanecer disponible aunque falle la limpieza del video anterior. */ }
  }
  response.json({ lesson: { id: lessonId, sectionId, title, description, position: Number(lesson.position), videoUrl: nextVideoUrl, durationSeconds: nextDurationSeconds } });
});

courseBuilderRouter.post('/courses/:courseId/materials', async (request, response) => {
  const courseId = idOf(request.params.courseId, 'Curso');
  await managedCourse(request.user, courseId);
  const type = request.body?.type;
  assert(type === 'file' || type === 'link', 400, 'El tipo de material debe ser archivo o enlace.');
  const category = documentCategory(request.body?.category);
  const title = clean(request.body?.title, 'El título', 180);
  const description = clean(request.body?.description, 'La descripción', 500, false);
  const url = secureUrl(request.body?.url, type === 'file' ? 'La URL del archivo' : 'La URL del enlace');
  let publicId = null; let originalFilename = null; let mimeType = null; let sizeBytes = null;
  if (type === 'file') {
    publicId = clean(request.body?.publicId, 'El identificador del archivo', 255);
    originalFilename = clean(request.body?.originalFilename, 'El nombre del archivo', 255);
    mimeType = clean(request.body?.mimeType, 'El tipo de archivo', 150);
    sizeBytes = Number(request.body?.sizeBytes);
    assert(MATERIAL_TYPES.has(mimeType), 400, 'El formato del material no está permitido.');
    assert(Number.isSafeInteger(sizeBytes) && sizeBytes > 0 && sizeBytes <= MAX_MATERIAL_BYTES, 400, 'El archivo debe pesar entre 1 byte y 25 MB.');
  }
  const [[next]] = await pool.execute('SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM course_materials WHERE course_id = ?', [courseId]);
  const [result] = await pool.execute(
    'INSERT INTO course_materials (course_id, type, category, position, title, description, url, public_id, original_filename, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [courseId, type, category, next.next_position, title, description, url, publicId, originalFilename, mimeType, sizeBytes],
  );
  const [rows] = await pool.execute('SELECT * FROM course_materials WHERE id = ?', [result.insertId]);
  response.status(201).json({ material: serializeMaterial(rows[0]) });
});

courseBuilderRouter.patch('/courses/:courseId/materials/:materialId', async (request, response) => {
  const courseId = idOf(request.params.courseId, 'Curso'); const materialId = idOf(request.params.materialId, 'Material');
  await managedCourse(request.user, courseId);
  const [rows] = await pool.execute('SELECT * FROM course_materials WHERE id = ? AND course_id = ? LIMIT 1', [materialId, courseId]);
  const material = rows[0]; if (!material) throw httpError(404, 'Material no encontrado.');
  const body = request.body ?? {};
  assert(['title', 'description', 'category'].some((field) => Object.hasOwn(body, field)), 400, 'No hay cambios que guardar.');
  const title = Object.hasOwn(body, 'title') ? clean(body.title, 'El título', 180) : material.title;
  const description = Object.hasOwn(body, 'description') ? clean(body.description, 'La descripción', 500, false) : material.description;
  const category = Object.hasOwn(body, 'category') ? documentCategory(body.category) : material.category;
  await pool.execute('UPDATE course_materials SET title = ?, description = ?, category = ? WHERE id = ?', [title, description, category, materialId]);
  const [updated] = await pool.execute('SELECT * FROM course_materials WHERE id = ?', [materialId]);
  response.json({ material: serializeMaterial(updated[0]) });
});

courseBuilderRouter.put('/courses/:courseId/materials/order', async (request, response) => {
  const course = await managedCourse(request.user, idOf(request.params.courseId, 'Curso'));
  const order = await inTransaction(async (connection) => {
    const [rows] = await connection.execute('SELECT id FROM course_materials WHERE course_id = ? FOR UPDATE', [course.id]);
    const plan = planOrder(rows.map((row) => Number(row.id)), request.body?.materialIds, 'La lista de documentos');
    for (const item of plan) await connection.execute('UPDATE course_materials SET position = ? WHERE id = ? AND course_id = ?', [item.position, item.id, course.id]);
    return plan;
  });
  response.json({ materials: order });
});

courseBuilderRouter.put('/courses/:courseId/sections/order', async (request, response) => {
  const course = await managedCourse(request.user, idOf(request.params.courseId, 'Curso'));
  const order = await inTransaction(async (connection) => {
    const [rows] = await connection.execute('SELECT id FROM course_sections WHERE course_id = ? ORDER BY position, id FOR UPDATE', [course.id]);
    const plan = planSectionOrder(rows.map((row) => Number(row.id)), request.body?.sectionIds);
    await connection.execute('UPDATE course_sections SET position = position + ? WHERE course_id = ?', [POSITION_OFFSET, course.id]);
    for (const item of plan) await connection.execute('UPDATE course_sections SET position = ? WHERE id = ? AND course_id = ?', [item.position, item.id, course.id]);
    return plan;
  });
  response.json({ sections: order });
});

courseBuilderRouter.put('/courses/:courseId/lessons/order', async (request, response) => {
  const course = await managedCourse(request.user, idOf(request.params.courseId, 'Curso'));
  const result = await inTransaction(async (connection) => {
    const [sections] = await connection.execute('SELECT id FROM course_sections WHERE course_id = ? ORDER BY position, id FOR UPDATE', [course.id]);
    const [lessons] = await connection.execute('SELECT id, section_id, kind FROM lessons WHERE course_id = ? ORDER BY position, id FOR UPDATE', [course.id]);
    const kinds = new Map(lessons.map((lesson) => [Number(lesson.id), lesson.kind]));
    const current = sections.map((section) => ({ id: Number(section.id), lessonIds: lessons.filter((lesson) => Number(lesson.section_id) === Number(section.id)).map((lesson) => Number(lesson.id)) }));
    const orphans = lessons.filter((lesson) => lesson.section_id === null || !sections.some((section) => Number(section.id) === Number(lesson.section_id)));
    const plan = planLessonLayout(current, request.body?.sections);
    await connection.execute('UPDATE lessons SET position = position + ? WHERE course_id = ?', [POSITION_OFFSET, course.id]);
    for (const item of plan) await connection.execute('UPDATE lessons SET section_id = ?, position = ? WHERE id = ? AND course_id = ?', [item.sectionId, item.position, item.lessonId, course.id]);
    let nextPosition = plan.length;
    for (const orphan of orphans) { nextPosition += 1; await connection.execute('UPDATE lessons SET position = ? WHERE id = ? AND course_id = ?', [nextPosition, orphan.id, course.id]); }
    const sectionPositions = new Map(current.map((section, index) => [section.id, index + 1]));
    const numbered = numberLessons(plan.map((item) => ({ id: item.lessonId, kind: kinds.get(Number(item.lessonId)), sectionId: item.sectionId, position: item.position, sectionPosition: sectionPositions.get(item.sectionId) })));
    return current.map((section) => ({ id: section.id, lessons: numbered.filter((item) => item.sectionId === section.id).map((item) => ({ id: item.id, position: item.position, lessonNumber: item.lessonNumber })) }));
  });
  response.json({ sections: result });
});

async function sectionOfCourse(connection, courseId, sectionId) {
  const [rows] = await connection.execute('SELECT id, title FROM course_sections WHERE id = ? AND course_id = ? LIMIT 1', [sectionId, courseId]);
  if (!rows[0]) throw httpError(404, 'Sección no encontrada en este curso.');
  return rows[0];
}

async function sectionImpact(connection, courseId, sectionId) {
  const [[lessons]] = await connection.execute("SELECT COUNT(*) AS total FROM lessons WHERE course_id = ? AND section_id = ? AND kind = 'video'", [courseId, sectionId]);
  const [[quizzes]] = await connection.execute("SELECT COUNT(*) AS total FROM lessons WHERE course_id = ? AND section_id = ? AND kind = 'quiz'", [courseId, sectionId]);
  const [[quizAttempts]] = await connection.execute("SELECT COUNT(*) AS total FROM quiz_attempts a JOIN lessons l ON l.id = a.quiz_id WHERE l.course_id = ? AND l.section_id = ? AND l.kind = 'quiz'", [courseId, sectionId]);
  const [[lessonMaterials]] = await connection.execute('SELECT COUNT(*) AS total FROM lesson_materials m JOIN lessons l ON l.id = m.lesson_id WHERE l.course_id = ? AND l.section_id = ?', [courseId, sectionId]);
  const [[progress]] = await connection.execute('SELECT COUNT(*) AS total FROM lesson_progress p JOIN lessons l ON l.id = p.lesson_id WHERE l.course_id = ? AND l.section_id = ?', [courseId, sectionId]);
  const [[remaining]] = await connection.execute("SELECT COUNT(*) AS total FROM lessons WHERE course_id = ? AND (section_id IS NULL OR section_id <> ?) AND kind = 'video' AND video_url IS NOT NULL AND video_url <> ''", [courseId, sectionId]);
  return { lessons: Number(lessons.total), quizzes: Number(quizzes.total), quizAttempts: Number(quizAttempts.total), lessonMaterials: Number(lessonMaterials.total), progress: Number(progress.total), remainingVideoLessons: Number(remaining.total) };
}

const LAST_VIDEO_MESSAGE = 'No puedes eliminar esta sección porque el curso está publicado y se quedaría sin clases con video. Despublica el curso o agrega otra clase antes.';

courseBuilderRouter.get('/courses/:courseId/sections/:sectionId/impact', async (request, response) => {
  const course = await managedCourse(request.user, idOf(request.params.courseId, 'Curso'));
  const section = await sectionOfCourse(pool, course.id, idOf(request.params.sectionId, 'Sección'));
  const impact = await sectionImpact(pool, course.id, section.id);
  response.json({ section: { id: Number(section.id), title: section.title }, impact: { ...impact, courseStatus: course.status, blocked: course.status === 'published' && impact.remainingVideoLessons === 0 && impact.lessons > 0 } });
});

courseBuilderRouter.delete('/courses/:courseId/sections/:sectionId', async (request, response) => {
  const course = await managedCourse(request.user, idOf(request.params.courseId, 'Curso'));
  const sectionId = idOf(request.params.sectionId, 'Sección');
  const deleted = await inTransaction(async (connection) => {
    const [courses] = await connection.execute('SELECT status FROM courses WHERE id = ? FOR UPDATE', [course.id]);
    await sectionOfCourse(connection, course.id, sectionId);
    const impact = await sectionImpact(connection, course.id, sectionId);
    if (courses[0].status === 'published' && impact.lessons > 0 && impact.remainingVideoLessons === 0) throw httpError(409, LAST_VIDEO_MESSAGE);
    await connection.execute('DELETE FROM lessons WHERE course_id = ? AND section_id = ?', [course.id, sectionId]);
    await connection.execute('DELETE FROM course_sections WHERE id = ? AND course_id = ?', [sectionId, course.id]);
    const [rest] = await connection.execute('SELECT id FROM course_sections WHERE course_id = ? ORDER BY position, id FOR UPDATE', [course.id]);
    await connection.execute('UPDATE course_sections SET position = position + ? WHERE course_id = ?', [POSITION_OFFSET, course.id]);
    for (const [index, row] of rest.entries()) await connection.execute('UPDATE course_sections SET position = ? WHERE id = ?', [index + 1, row.id]);
    return { lessons: impact.lessons, quizzes: impact.quizzes, quizAttempts: impact.quizAttempts, lessonMaterials: impact.lessonMaterials, progress: impact.progress };
  });
  response.json({ deleted });
});

courseBuilderRouter.post('/courses/:courseId/promo-images', async (request, response) => {
  const course = await managedCourse(request.user, idOf(request.params.courseId, 'Curso'));
  const url = secureUrl(request.body?.url, 'La URL de la imagen');
  assert(isCloudinaryImageUrl(url, env.cloudinary.cloudName), 400, 'La imagen debe estar alojada en el Cloudinary de la plataforma.');
  const publicId = clean(request.body?.publicId, 'El identificador de la imagen', 255, false) || null;
  const altText = clean(request.body?.altText, 'El texto alternativo', 200, false) || null;
  const image = await inTransaction(async (connection) => {
    await connection.execute('SELECT id FROM courses WHERE id = ? FOR UPDATE', [course.id]);
    const [[stats]] = await connection.execute('SELECT COUNT(*) AS total, COALESCE(MAX(position), 0) + 1 AS next_position FROM course_promo_images WHERE course_id = ?', [course.id]);
    if (Number(stats.total) >= PROMO_IMAGE_LIMIT) throw httpError(409, `Un curso admite hasta ${PROMO_IMAGE_LIMIT} imágenes promocionales.`);
    const [result] = await connection.execute('INSERT INTO course_promo_images (course_id, image_url, public_id, alt_text, position) VALUES (?, ?, ?, ?, ?)', [course.id, url, publicId, altText, stats.next_position]);
    const [rows] = await connection.execute('SELECT * FROM course_promo_images WHERE id = ?', [result.insertId]);
    return rows[0];
  });
  response.status(201).json({ image: serializePromoImage(image) });
});

courseBuilderRouter.patch('/courses/:courseId/promo-images/:imageId', async (request, response) => {
  const course = await managedCourse(request.user, idOf(request.params.courseId, 'Curso'));
  const imageId = idOf(request.params.imageId, 'Imagen');
  assert(Object.hasOwn(request.body ?? {}, 'altText'), 400, 'No hay cambios que guardar.');
  const altText = clean(request.body.altText, 'El texto alternativo', 200, false) || null;
  const [result] = await pool.execute('UPDATE course_promo_images SET alt_text = ? WHERE id = ? AND course_id = ?', [altText, imageId, course.id]);
  if (!result.affectedRows) throw httpError(404, 'Imagen no encontrada.');
  const [rows] = await pool.execute('SELECT * FROM course_promo_images WHERE id = ?', [imageId]);
  response.json({ image: serializePromoImage(rows[0]) });
});

courseBuilderRouter.put('/courses/:courseId/promo-images/order', async (request, response) => {
  const course = await managedCourse(request.user, idOf(request.params.courseId, 'Curso'));
  const order = await inTransaction(async (connection) => {
    const [rows] = await connection.execute('SELECT id FROM course_promo_images WHERE course_id = ? FOR UPDATE', [course.id]);
    const plan = planOrder(rows.map((row) => Number(row.id)), request.body?.imageIds, 'La lista de imágenes');
    for (const item of plan) await connection.execute('UPDATE course_promo_images SET position = ? WHERE id = ? AND course_id = ?', [item.position, item.id, course.id]);
    return plan;
  });
  response.json({ images: order });
});

courseBuilderRouter.delete('/courses/:courseId/promo-images/:imageId', async (request, response) => {
  const course = await managedCourse(request.user, idOf(request.params.courseId, 'Curso'));
  const imageId = idOf(request.params.imageId, 'Imagen');
  const image = await inTransaction(async (connection) => {
    const [rows] = await connection.execute('SELECT * FROM course_promo_images WHERE id = ? AND course_id = ? LIMIT 1 FOR UPDATE', [imageId, course.id]);
    if (!rows[0]) throw httpError(404, 'Imagen no encontrada.');
    await connection.execute('DELETE FROM course_promo_images WHERE id = ?', [imageId]);
    const [rest] = await connection.execute('SELECT id FROM course_promo_images WHERE course_id = ? ORDER BY position, id', [course.id]);
    for (const [index, row] of rest.entries()) await connection.execute('UPDATE course_promo_images SET position = ? WHERE id = ?', [index + 1, row.id]);
    return rows[0];
  });
  if (image.public_id && image.public_id.startsWith(env.cloudinary.uploadFolder)) {
    try {
      const [[shared]] = await pool.execute('SELECT (SELECT COUNT(*) FROM course_promo_images WHERE public_id = ?) + (SELECT COUNT(*) FROM courses WHERE thumbnail_url LIKE ?) AS total', [image.public_id, `%${image.public_id}%`]);
      if (Number(shared.total) === 0) await cloudinary.uploader.destroy(image.public_id, { resource_type: 'image', invalidate: true });
    } catch { /* La imagen ya se quitó del curso; un fallo al limpiar Cloudinary no debe bloquear la operación. */ }
  }
  response.status(204).end();
});

courseBuilderRouter.delete('/courses/:courseId/materials/:materialId', async (request, response) => {
  const courseId = idOf(request.params.courseId, 'Curso'); const materialId = idOf(request.params.materialId, 'Material');
  await managedCourse(request.user, courseId);
  const [rows] = await pool.execute('SELECT * FROM course_materials WHERE id = ? AND course_id = ? LIMIT 1', [materialId, courseId]);
  const material = rows[0]; if (!material) throw httpError(404, 'Material no encontrado.');
  if (material.type === 'file' && material.public_id) await cloudinary.uploader.destroy(material.public_id, { resource_type: 'raw', invalidate: true });
  await pool.execute('DELETE FROM course_materials WHERE id = ?', [materialId]);
  response.status(204).end();
});


courseBuilderRouter.post('/sections/:sectionId/lessons/:lessonId/materials', async (request, response) => {
  const sectionId = idOf(request.params.sectionId, 'Sección');
  const lessonId = idOf(request.params.lessonId, 'Clase');
  const [lessons] = await pool.execute(
    `SELECT l.id, c.owner_id
     FROM lessons l
     JOIN course_sections s ON s.id = l.section_id
     JOIN courses c ON c.id = s.course_id
     WHERE l.id = ? AND l.section_id = ? AND l.kind = 'video' LIMIT 1`,
    [lessonId, sectionId],
  );
  const lesson = lessons[0];
  if (!lesson) throw httpError(404, 'Clase no encontrada en esta sección.');
  if (request.user.role !== 'super_admin' && Number(lesson.owner_id) !== request.user.id) throw httpError(403, 'No puedes administrar materiales de esta clase.');

  const type = request.body?.type;
  assert(type === 'file' || type === 'link', 400, 'El tipo de material debe ser archivo o enlace.');
  const title = clean(request.body?.title, 'El título', 180);
  const description = clean(request.body?.description, 'La descripción', 500, false);
  const url = secureUrl(request.body?.url, type === 'file' ? 'La URL del archivo' : 'La URL del enlace');
  let publicId = null; let originalFilename = null; let mimeType = null; let sizeBytes = null;
  if (type === 'file') {
    publicId = clean(request.body?.publicId, 'El identificador del archivo', 255);
    originalFilename = clean(request.body?.originalFilename, 'El nombre del archivo', 255);
    mimeType = clean(request.body?.mimeType, 'El tipo de archivo', 150);
    sizeBytes = Number(request.body?.sizeBytes);
    assert(MATERIAL_TYPES.has(mimeType), 400, 'El formato del material no está permitido.');
    assert(Number.isSafeInteger(sizeBytes) && sizeBytes > 0 && sizeBytes <= MAX_MATERIAL_BYTES, 400, 'El archivo debe pesar entre 1 byte y 25 MB.');
  }
  const [result] = await pool.execute(
    'INSERT INTO lesson_materials (lesson_id, type, title, description, url, public_id, original_filename, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [lessonId, type, title, description, url, publicId, originalFilename, mimeType, sizeBytes],
  );
  const [rows] = await pool.execute('SELECT * FROM lesson_materials WHERE id = ?', [result.insertId]);
  response.status(201).json({ material: serializeMaterial(rows[0]) });
});

courseBuilderRouter.delete('/sections/:sectionId/lessons/:lessonId/materials/:materialId', async (request, response) => {
  const sectionId = idOf(request.params.sectionId, 'Sección');
  const lessonId = idOf(request.params.lessonId, 'Clase');
  const materialId = idOf(request.params.materialId, 'Material');
  const [rows] = await pool.execute(
    `SELECT m.*, c.owner_id
     FROM lesson_materials m
     JOIN lessons l ON l.id = m.lesson_id
     JOIN course_sections s ON s.id = l.section_id
     JOIN courses c ON c.id = s.course_id
     WHERE m.id = ? AND m.lesson_id = ? AND l.section_id = ? AND l.kind = 'video' LIMIT 1`,
    [materialId, lessonId, sectionId],
  );
  const material = rows[0];
  if (!material) throw httpError(404, 'Material no encontrado en esta clase.');
  if (request.user.role !== 'super_admin' && Number(material.owner_id) !== request.user.id) throw httpError(403, 'No puedes administrar materiales de esta clase.');
  if (material.type === 'file' && material.public_id) await cloudinary.uploader.destroy(material.public_id, { resource_type: 'raw', invalidate: true });
  await pool.execute('DELETE FROM lesson_materials WHERE id = ?', [materialId]);
  response.status(204).end();
});
