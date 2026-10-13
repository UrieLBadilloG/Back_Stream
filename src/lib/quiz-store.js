import { pool } from '../config/database.js';
import { assertEnrollmentActive, enrollmentAccessColumns } from './access.js';
import { planLessonLayout } from './course-structure.js';
import { httpError } from './http-error.js';
import { computeLocks, insertAtIndex, isEffectiveRequired } from './quiz-logic.js';
import { isCourseManager } from './users.js';

// Capa de base de datos de las evaluaciones. La lógica pura vive en quiz-logic.js.
// En toda la API quizId == lessonId.

const POSITION_OFFSET = 1000000;

// Ejecuta `work(connection)` en una transacción con rollback ante cualquier error.
export async function inTransaction(work) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try { await connection.rollback(); } catch { /* La conexión puede haberse cerrado; se propaga el error original. */ }
    throw error;
  } finally {
    connection.release();
  }
}

// Curso existente y accesible para el usuario: manager (dueño o super_admin) o inscrito con acceso vigente.
export async function assertLearnerCourseAccess(user, courseId) {
  const [rows] = await pool.execute('SELECT * FROM courses WHERE id = ? LIMIT 1', [courseId]);
  const course = rows[0];
  if (!course) throw httpError(404, 'Curso no encontrado.');
  const manager = isCourseManager(user, course);
  if (!manager) {
    const [enrollments] = await pool.execute(
      `SELECT e.id, ${enrollmentAccessColumns('e')} FROM enrollments e WHERE e.user_id = ? AND e.course_id = ? LIMIT 1`,
      [user.id, courseId],
    );
    if (!enrollments[0]) throw httpError(403, 'No estás inscrito en este curso.');
    assertEnrollmentActive(enrollments[0]);
  }
  if (course.status !== 'published' && !manager) throw httpError(403, 'Este curso todavía no está publicado.');
  return { course, manager };
}

// Todas las clases del curso (videos y evaluaciones) en orden de lectura, con el avance del usuario.
export async function loadCourseItems(executor, courseId, userId) {
  const [rows] = await executor.execute(
    `SELECT l.id, l.kind, l.title, l.description, l.section_id, l.position, l.video_url, l.duration_seconds,
      s.title AS section_title, s.position AS section_position, lp.completed_at,
      q.label, q.passing_percent, q.is_required, q.max_attempts, q.show_answers,
      (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = l.id) AS question_count
     FROM lessons l
     LEFT JOIN course_sections s ON s.id = l.section_id
     LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = ?
     LEFT JOIN quizzes q ON q.lesson_id = l.id
     WHERE l.course_id = ?
     ORDER BY COALESCE(s.position, 0), l.position, l.id`,
    [userId ?? null, courseId],
  );
  return rows.map((row) => {
    const questionCount = Number(row.question_count);
    const isQuiz = row.kind === 'quiz';
    return {
      id: Number(row.id),
      kind: row.kind,
      title: row.title,
      description: row.description,
      sectionId: row.section_id === null ? null : Number(row.section_id),
      sectionTitle: row.section_title,
      sectionPosition: Number(row.section_position ?? 0),
      position: Number(row.position),
      videoUrl: row.video_url,
      durationSeconds: Number(row.duration_seconds),
      completedAt: row.completed_at,
      completed: Boolean(row.completed_at),
      questionCount,
      required: isQuiz && isEffectiveRequired({ isRequired: Boolean(row.is_required), questionCount }),
      quiz: isQuiz
        ? { label: row.label, passingPercent: Number(row.passing_percent), isRequired: Boolean(row.is_required), maxAttempts: row.max_attempts === null ? null : Number(row.max_attempts), showAnswers: row.show_answers }
        : null,
    };
  });
}

// Los alumnos no ven evaluaciones sin preguntas; el docente ve todo.
export function visibleItemsFor(items, manager) {
  return manager ? items : items.filter((item) => item.kind !== 'quiz' || item.questionCount > 0);
}

// 403 QUIZ_REQUIRED si una evaluación obligatoria anterior no está aprobada. Los managers están exentos.
export async function assertItemUnlocked({ user, course, manager, itemId, executor = pool }) {
  if (manager) return;
  const items = visibleItemsFor(await loadCourseItems(executor, course.id, user.id), false);
  const lock = computeLocks(items).get(Number(itemId));
  if (lock) throw httpError(403, `Aprueba la evaluación «${lock.title}» para continuar.`, true, 'QUIZ_REQUIRED');
}

// Fila de la evaluación (lessons + quizzes) del curso, o undefined si no existe en ese curso.
export async function findQuiz(executor, courseId, quizId) {
  const [rows] = await executor.execute(
    `SELECT l.id, l.course_id, l.section_id, l.title, l.description, l.position, q.label, q.passing_percent, q.is_required, q.max_attempts, q.show_answers, q.created_at, q.updated_at,
      (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = l.id) AS question_count
     FROM lessons l JOIN quizzes q ON q.lesson_id = l.id
     WHERE l.id = ? AND l.course_id = ? AND l.kind = 'quiz' LIMIT 1`,
    [quizId, courseId],
  );
  return rows[0];
}

// Preguntas y opciones ordenadas por posición. Sin includeCorrect no se devuelve is_correct ni la explicación.
export async function loadQuizModel(executor, quizId, { includeCorrect = false } = {}) {
  const [questions] = await executor.execute(
    'SELECT id, position, type, prompt, explanation, points FROM quiz_questions WHERE quiz_id = ? ORDER BY position, id',
    [quizId],
  );
  const [options] = await executor.execute(
    `SELECT o.id, o.question_id, o.position, o.option_text, o.is_correct
     FROM quiz_options o JOIN quiz_questions q ON q.id = o.question_id
     WHERE q.quiz_id = ? ORDER BY o.question_id, o.position, o.id`,
    [quizId],
  );
  const byQuestion = new Map();
  for (const option of options) {
    const list = byQuestion.get(Number(option.question_id)) ?? [];
    list.push({
      id: Number(option.id),
      position: Number(option.position),
      text: option.option_text,
      ...(includeCorrect ? { isCorrect: Boolean(option.is_correct) } : {}),
    });
    byQuestion.set(Number(option.question_id), list);
  }
  return questions.map((question) => ({
    id: Number(question.id),
    position: Number(question.position),
    type: question.type,
    prompt: question.prompt,
    points: Number(question.points),
    ...(includeCorrect ? { explanation: question.explanation } : {}),
    options: byQuestion.get(Number(question.id)) ?? [],
  }));
}

// Diseño actual del curso: secciones con los ids de sus clases (orden por posición) y clases huérfanas.
export async function readLayout(connection, courseId) {
  const [sections] = await connection.execute('SELECT id FROM course_sections WHERE course_id = ? ORDER BY position, id FOR UPDATE', [courseId]);
  const [lessons] = await connection.execute('SELECT id, section_id FROM lessons WHERE course_id = ? ORDER BY position, id FOR UPDATE', [courseId]);
  const current = sections.map((section) => ({
    id: Number(section.id),
    lessonIds: lessons.filter((lesson) => Number(lesson.section_id) === Number(section.id)).map((lesson) => Number(lesson.id)),
  }));
  const orphans = lessons.filter((lesson) => lesson.section_id === null || !sections.some((section) => Number(section.id) === Number(lesson.section_id)));
  return { current, orphans };
}

// Mismo patrón que PUT /courses/:id/lessons/order: desplaza posiciones, reasigna 1..N y deja los huérfanos al final.
export async function applyLayout(connection, courseId, sectionsLayout) {
  const { current, orphans } = await readLayout(connection, courseId);
  const plan = planLessonLayout(current, sectionsLayout);
  await connection.execute('UPDATE lessons SET position = position + ? WHERE course_id = ?', [POSITION_OFFSET, courseId]);
  for (const item of plan) await connection.execute('UPDATE lessons SET section_id = ?, position = ? WHERE id = ? AND course_id = ?', [item.sectionId, item.position, item.lessonId, courseId]);
  let nextPosition = plan.length;
  for (const orphan of orphans) {
    nextPosition += 1;
    await connection.execute('UPDATE lessons SET position = ? WHERE id = ? AND course_id = ?', [nextPosition, orphan.id, courseId]);
  }
  return plan;
}

// Crea la evaluación (lessons kind='quiz' + quizzes) y la coloca en `index` de la sección. `connection` debe ser una
// conexión dedicada (pool.getConnection): la función abre, confirma o revierte la transacción y NO la libera.
export async function insertQuizAt(connection, { course, sectionId, index, title, description, settings }) {
  await connection.beginTransaction();
  try {
    await connection.execute('SELECT id FROM courses WHERE id = ? FOR UPDATE', [course.id]);
    const [sections] = await connection.execute('SELECT id FROM course_sections WHERE id = ? AND course_id = ? LIMIT 1', [sectionId, course.id]);
    if (!sections[0]) throw httpError(404, 'Sección no encontrada en este curso.');
    const [[next]] = await connection.execute('SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM lessons WHERE course_id = ?', [course.id]);
    const [inserted] = await connection.execute(
      "INSERT INTO lessons (course_id, section_id, kind, title, description, video_url, video_public_id, duration_seconds, position) VALUES (?, ?, 'quiz', ?, ?, NULL, NULL, 0, ?)",
      [course.id, sectionId, title, description || '', next.next_position],
    );
    const quizId = Number(inserted.insertId);
    await connection.execute(
      'INSERT INTO quizzes (lesson_id, label, passing_percent, is_required, max_attempts, show_answers) VALUES (?, ?, ?, ?, ?, ?)',
      [quizId, settings.label, settings.passingPercent, settings.isRequired ? 1 : 0, settings.maxAttempts ?? null, settings.showAnswers],
    );
    const { current } = await readLayout(connection, course.id);
    await applyLayout(connection, course.id, insertAtIndex(current, sectionId, quizId, index));
    await connection.commit();
    return quizId;
  } catch (error) {
    try { await connection.rollback(); } catch { /* La conexión puede haberse cerrado; se propaga el error original. */ }
    throw error;
  }
}
