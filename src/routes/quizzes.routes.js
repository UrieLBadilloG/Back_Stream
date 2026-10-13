import { Router } from 'express';

import { pool } from '../config/database.js';
import { planOrder } from '../lib/course-structure.js';
import { assert, httpError } from '../lib/http-error.js';
import {
  QUIZ_LIMITS,
  attemptsLeft,
  gradeAttempt,
  isEffectiveRequired,
  normalizeAnswers,
  normalizeQuestion,
  normalizeQuizSettings,
  revealResults,
} from '../lib/quiz-logic.js';
import {
  assertItemUnlocked,
  assertLearnerCourseAccess,
  findQuiz,
  inTransaction,
  insertQuizAt,
  loadQuizModel,
} from '../lib/quiz-store.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rate-limit.js';

export const quizzesAdminRouter = Router();
export const quizzesLearnerRouter = Router();

function idOf(value, label) {
  const id = Number(value);
  assert(Number.isSafeInteger(id) && id > 0, 400, `${label} no es válido.`);
  return id;
}

async function managedCourse(user, courseId) {
  const [rows] = await pool.execute('SELECT * FROM courses WHERE id = ? LIMIT 1', [courseId]);
  const course = rows[0];
  if (!course) throw httpError(404, 'Curso no encontrado.');
  if (user.role !== 'super_admin' && Number(course.owner_id) !== user.id) throw httpError(403, 'No puedes administrar este curso.');
  return course;
}

async function managedQuiz(user, courseParam, quizParam) {
  const course = await managedCourse(user, idOf(courseParam, 'Curso'));
  const quiz = await findQuiz(pool, course.id, idOf(quizParam, 'Evaluación'));
  if (!quiz) throw httpError(404, 'Evaluación no encontrada.');
  return { course, quiz };
}

function serializeQuiz(row) {
  const questionCount = Number(row.question_count);
  return {
    id: Number(row.id),
    sectionId: row.section_id === null ? null : Number(row.section_id),
    position: Number(row.position),
    title: row.title,
    description: row.description,
    label: row.label,
    passingPercent: Number(row.passing_percent),
    isRequired: Boolean(row.is_required),
    isEffectiveRequired: isEffectiveRequired({ isRequired: Boolean(row.is_required), questionCount }),
    maxAttempts: row.max_attempts === null ? null : Number(row.max_attempts),
    showAnswers: row.show_answers,
    questionCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeAdminQuestion(question) {
  return {
    id: question.id,
    position: question.position,
    type: question.type,
    prompt: question.prompt,
    explanation: question.explanation,
    points: question.points,
    options: question.options.map((option) => ({ id: option.id, position: option.position, text: option.text, isCorrect: option.isCorrect })),
  };
}

function optionalIndex(value) {
  if (value === undefined || value === null) return undefined;
  assert(typeof value === 'number' && Number.isInteger(value) && value >= 0, 400, 'La posición debe ser un entero mayor o igual a 0.');
  return value;
}

async function insertOptions(connection, questionId, options) {
  for (const [index, option] of options.entries()) {
    await connection.execute('INSERT INTO quiz_options (question_id, position, option_text, is_correct) VALUES (?, ?, ?, ?)', [questionId, index + 1, option.text, option.isCorrect ? 1 : 0]);
  }
}

async function renumberQuestions(connection, quizId, orderedIds) {
  for (const [index, id] of orderedIds.entries()) await connection.execute('UPDATE quiz_questions SET position = ? WHERE id = ? AND quiz_id = ?', [index + 1, id, quizId]);
}

async function questionOfQuiz(connection, quizId, questionId) {
  const [rows] = await connection.execute('SELECT id FROM quiz_questions WHERE id = ? AND quiz_id = ? LIMIT 1 FOR UPDATE', [questionId, quizId]);
  if (!rows[0]) throw httpError(404, 'Pregunta no encontrada en esta evaluación.');
}

async function loadAdminQuestion(executor, quizId, questionId) {
  const model = await loadQuizModel(executor, quizId, { includeCorrect: true });
  return serializeAdminQuestion(model.find((question) => question.id === questionId));
}

// ---------------------------------------------------------------------------------------------
// Docente
// ---------------------------------------------------------------------------------------------

quizzesAdminRouter.use(requireAuth, requireRole('admin', 'super_admin'));

quizzesAdminRouter.post('/courses/:courseId/quizzes', async (request, response) => {
  const course = await managedCourse(request.user, idOf(request.params.courseId, 'Curso'));
  const body = request.body ?? {};
  const sectionId = idOf(body.sectionId, 'Sección');
  const index = optionalIndex(body.index);
  const settings = normalizeQuizSettings(body);
  const connection = await pool.getConnection();
  let quizId;
  try {
    quizId = await insertQuizAt(connection, { course, sectionId, index, title: settings.title, description: settings.description, settings });
  } finally {
    connection.release();
  }
  response.status(201).json({ quiz: serializeQuiz(await findQuiz(pool, course.id, quizId)) });
});

quizzesAdminRouter.get('/courses/:courseId/quizzes/:quizId', async (request, response) => {
  const { quiz } = await managedQuiz(request.user, request.params.courseId, request.params.quizId);
  const questions = await loadQuizModel(pool, Number(quiz.id), { includeCorrect: true });
  const [[attempts]] = await pool.execute('SELECT COUNT(*) AS total FROM quiz_attempts WHERE quiz_id = ?', [quiz.id]);
  response.json({ quiz: { ...serializeQuiz(quiz), attemptCount: Number(attempts.total), questions: questions.map(serializeAdminQuestion) } });
});

quizzesAdminRouter.patch('/courses/:courseId/quizzes/:quizId', async (request, response) => {
  const { course, quiz } = await managedQuiz(request.user, request.params.courseId, request.params.quizId);
  const changes = normalizeQuizSettings(request.body, { partial: true });
  await inTransaction(async (connection) => {
    const lessonFields = [];
    const lessonValues = [];
    if (changes.title !== undefined) { lessonFields.push('title = ?'); lessonValues.push(changes.title); }
    if (changes.description !== undefined) { lessonFields.push('description = ?'); lessonValues.push(changes.description); }
    if (lessonFields.length) await connection.execute(`UPDATE lessons SET ${lessonFields.join(', ')} WHERE id = ? AND course_id = ?`, [...lessonValues, quiz.id, course.id]);
    const columns = { label: 'label', passingPercent: 'passing_percent', isRequired: 'is_required', maxAttempts: 'max_attempts', showAnswers: 'show_answers' };
    const quizFields = [];
    const quizValues = [];
    for (const [key, column] of Object.entries(columns)) {
      if (changes[key] === undefined) continue;
      quizFields.push(`${column} = ?`);
      quizValues.push(key === 'isRequired' ? (changes[key] ? 1 : 0) : changes[key]);
    }
    if (quizFields.length) await connection.execute(`UPDATE quizzes SET ${quizFields.join(', ')} WHERE lesson_id = ?`, [...quizValues, quiz.id]);
  });
  response.json({ quiz: serializeQuiz(await findQuiz(pool, course.id, Number(quiz.id))) });
});

quizzesAdminRouter.delete('/courses/:courseId/quizzes/:quizId', async (request, response) => {
  const { course, quiz } = await managedQuiz(request.user, request.params.courseId, request.params.quizId);
  const deleted = await inTransaction(async (connection) => {
    const [[questions]] = await connection.execute('SELECT COUNT(*) AS total FROM quiz_questions WHERE quiz_id = ?', [quiz.id]);
    const [[attempts]] = await connection.execute('SELECT COUNT(*) AS total FROM quiz_attempts WHERE quiz_id = ?', [quiz.id]);
    await connection.execute("DELETE FROM lessons WHERE id = ? AND course_id = ? AND kind = 'quiz'", [quiz.id, course.id]);
    return { questions: Number(questions.total), attempts: Number(attempts.total) };
  });
  response.json({ deleted });
});

quizzesAdminRouter.post('/courses/:courseId/quizzes/:quizId/questions', async (request, response) => {
  const { quiz } = await managedQuiz(request.user, request.params.courseId, request.params.quizId);
  const question = normalizeQuestion(request.body);
  const index = optionalIndex(request.body?.index);
  const created = await inTransaction(async (connection) => {
    await connection.execute('SELECT lesson_id FROM quizzes WHERE lesson_id = ? FOR UPDATE', [quiz.id]);
    const [existing] = await connection.execute('SELECT id FROM quiz_questions WHERE quiz_id = ? ORDER BY position, id', [quiz.id]);
    if (existing.length >= QUIZ_LIMITS.maxQuestions) throw httpError(409, `Una evaluación admite hasta ${QUIZ_LIMITS.maxQuestions} preguntas.`);
    const [result] = await connection.execute(
      'INSERT INTO quiz_questions (quiz_id, position, type, prompt, explanation, points) VALUES (?, ?, ?, ?, ?, ?)',
      [quiz.id, existing.length + 1, question.type, question.prompt, question.explanation, question.points],
    );
    const questionId = Number(result.insertId);
    await insertOptions(connection, questionId, question.options);
    const ids = existing.map((row) => Number(row.id));
    const at = index !== undefined && index <= ids.length ? index : ids.length;
    ids.splice(at, 0, questionId);
    await renumberQuestions(connection, quiz.id, ids);
    return loadAdminQuestion(connection, Number(quiz.id), questionId);
  });
  response.status(201).json({ question: created });
});

// Declarada ANTES de PUT .../questions/:questionId para que "order" no se interprete como un id.
quizzesAdminRouter.put('/courses/:courseId/quizzes/:quizId/questions/order', async (request, response) => {
  const { quiz } = await managedQuiz(request.user, request.params.courseId, request.params.quizId);
  const plan = await inTransaction(async (connection) => {
    const [rows] = await connection.execute('SELECT id FROM quiz_questions WHERE quiz_id = ? ORDER BY position, id FOR UPDATE', [quiz.id]);
    const ordered = planOrder(rows.map((row) => Number(row.id)), request.body?.questionIds, 'La lista de preguntas');
    for (const item of ordered) await connection.execute('UPDATE quiz_questions SET position = ? WHERE id = ? AND quiz_id = ?', [item.position, item.id, quiz.id]);
    return ordered;
  });
  response.json({ questions: plan });
});

quizzesAdminRouter.put('/courses/:courseId/quizzes/:quizId/questions/:questionId', async (request, response) => {
  const { quiz } = await managedQuiz(request.user, request.params.courseId, request.params.quizId);
  const questionId = idOf(request.params.questionId, 'Pregunta');
  const question = normalizeQuestion(request.body);
  const updated = await inTransaction(async (connection) => {
    await questionOfQuiz(connection, quiz.id, questionId);
    await connection.execute('UPDATE quiz_questions SET type = ?, prompt = ?, explanation = ?, points = ? WHERE id = ? AND quiz_id = ?', [question.type, question.prompt, question.explanation, question.points, questionId, quiz.id]);
    await connection.execute('DELETE FROM quiz_options WHERE question_id = ?', [questionId]);
    await insertOptions(connection, questionId, question.options);
    return loadAdminQuestion(connection, Number(quiz.id), questionId);
  });
  response.json({ question: updated });
});

quizzesAdminRouter.delete('/courses/:courseId/quizzes/:quizId/questions/:questionId', async (request, response) => {
  const { quiz } = await managedQuiz(request.user, request.params.courseId, request.params.quizId);
  const questionId = idOf(request.params.questionId, 'Pregunta');
  await inTransaction(async (connection) => {
    await connection.execute('SELECT lesson_id FROM quizzes WHERE lesson_id = ? FOR UPDATE', [quiz.id]);
    await questionOfQuiz(connection, quiz.id, questionId);
    await connection.execute('DELETE FROM quiz_questions WHERE id = ? AND quiz_id = ?', [questionId, quiz.id]);
    const [rest] = await connection.execute('SELECT id FROM quiz_questions WHERE quiz_id = ? ORDER BY position, id', [quiz.id]);
    await renumberQuestions(connection, quiz.id, rest.map((row) => Number(row.id)));
  });
  response.status(204).end();
});

function pageParam(value, label, fallback, min, max) {
  if (value === undefined) return fallback;
  const text = String(value);
  assert(/^\d{1,6}$/.test(text), 400, `${label} no es válido.`);
  const number = Number(text);
  assert(number >= min && number <= max, 400, `${label} debe estar entre ${min} y ${max}.`);
  return number;
}

quizzesAdminRouter.get('/courses/:courseId/quizzes/:quizId/results', async (request, response) => {
  const { quiz } = await managedQuiz(request.user, request.params.courseId, request.params.quizId);
  const page = pageParam(request.query.page, 'La página', 1, 1, 100000);
  const pageSize = pageParam(request.query.pageSize, 'El tamaño de página', 20, 1, 50);
  const [[summary]] = await pool.execute(
    `SELECT COUNT(DISTINCT user_id) AS students, COUNT(*) AS attempts,
      COUNT(DISTINCT CASE WHEN passed = 1 THEN user_id END) AS passed_students, AVG(score_percent) AS average_score
     FROM quiz_attempts WHERE quiz_id = ?`,
    [quiz.id],
  );
  const [rows] = await pool.query(
    `SELECT a.user_id, u.full_name, u.email, a.attempt_no, a.score_percent, a.passed, a.submitted_at
     FROM quiz_attempts a JOIN users u ON u.id = a.user_id
     WHERE a.quiz_id = ? ORDER BY a.submitted_at DESC, a.id DESC LIMIT ? OFFSET ?`,
    [Number(quiz.id), pageSize, (page - 1) * pageSize],
  );
  response.json({
    summary: {
      students: Number(summary.students),
      attempts: Number(summary.attempts),
      passedStudents: Number(summary.passed_students),
      averageScore: summary.average_score === null ? null : Math.round(Number(summary.average_score) * 100) / 100,
    },
    page,
    pageSize,
    totalAttempts: Number(summary.attempts),
    attempts: rows.map((row) => ({
      userId: Number(row.user_id),
      fullName: row.full_name,
      email: row.email,
      attemptNo: Number(row.attempt_no),
      scorePercent: Number(row.score_percent),
      passed: Boolean(row.passed),
      submittedAt: row.submitted_at,
    })),
  });
});

// ---------------------------------------------------------------------------------------------
// Alumno
// ---------------------------------------------------------------------------------------------

const attemptLimiter = createRateLimiter({ windowMs: 60000, max: 10, keyFn: (request) => `quiz:${request.user.id}` });

async function attemptSummary(executor, quizId, userId, maxAttempts) {
  const [[stats]] = await executor.execute(
    'SELECT COUNT(*) AS used, MAX(score_percent) AS best, COALESCE(MAX(passed), 0) AS passed FROM quiz_attempts WHERE quiz_id = ? AND user_id = ?',
    [quizId, userId],
  );
  const used = Number(stats.used);
  return {
    attemptsUsed: used,
    attemptsLeft: attemptsLeft(maxAttempts, used),
    bestScorePercent: stats.best === null ? null : Number(stats.best),
    passed: Boolean(Number(stats.passed)),
  };
}

// Evaluación visible para quien consulta: los alumnos no ven evaluaciones sin preguntas.
async function learnerQuiz(courseId, quizId, manager) {
  const quiz = await findQuiz(pool, courseId, quizId);
  if (!quiz || (!manager && Number(quiz.question_count) === 0)) throw httpError(404, 'Evaluación no encontrada.');
  return quiz;
}

quizzesLearnerRouter.get('/:courseId/quizzes/:quizId', requireAuth, async (request, response) => {
  const courseId = idOf(request.params.courseId, 'Curso');
  const quizId = idOf(request.params.quizId, 'Evaluación');
  const { course, manager } = await assertLearnerCourseAccess(request.user, courseId);
  const quiz = await learnerQuiz(course.id, quizId, manager);
  await assertItemUnlocked({ user: request.user, course, manager, itemId: quizId });
  const questions = await loadQuizModel(pool, quizId, { includeCorrect: false });
  const summary = await attemptSummary(pool, quizId, request.user.id, quiz.max_attempts === null ? null : Number(quiz.max_attempts));
  const serialized = serializeQuiz(quiz);
  response.json({
    quiz: {
      id: serialized.id,
      sectionId: serialized.sectionId,
      title: serialized.title,
      description: serialized.description,
      label: serialized.label,
      passingPercent: serialized.passingPercent,
      isRequired: serialized.isEffectiveRequired,
      maxAttempts: serialized.maxAttempts,
      showAnswers: serialized.showAnswers,
      questionCount: serialized.questionCount,
      totalPoints: questions.reduce((sum, question) => sum + question.points, 0),
      ...summary,
      questions: questions.map((question) => ({
        id: question.id,
        position: question.position,
        type: question.type,
        prompt: question.prompt,
        points: question.points,
        options: question.options.map((option) => ({ id: option.id, position: option.position, text: option.text })),
      })),
    },
  });
});

function attemptResponse(graded, { quiz, attemptNo, left, showAnswers }) {
  return {
    attemptNo,
    scorePercent: graded.scorePercent,
    passed: graded.passed,
    correctCount: graded.correctCount,
    totalCount: graded.totalCount,
    passingPercent: Number(quiz.passing_percent),
    attemptsLeft: left,
    unlocked: graded.passed,
    results: revealResults(graded, { showAnswers }),
  };
}

quizzesLearnerRouter.post('/:courseId/quizzes/:quizId/attempts', requireAuth, attemptLimiter, async (request, response) => {
  const courseId = idOf(request.params.courseId, 'Curso');
  const quizId = idOf(request.params.quizId, 'Evaluación');
  const { course, manager } = await assertLearnerCourseAccess(request.user, courseId);
  const rawPreview = request.body?.preview;
  assert(rawPreview === undefined || typeof rawPreview === 'boolean', 400, 'La vista previa debe ser verdadero o falso.');
  const preview = rawPreview === true;
  if (preview && !manager) throw httpError(403, 'Solo quien administra el curso puede probar la evaluación sin guardar.');

  if (preview) {
    const quiz = await learnerQuiz(course.id, quizId, manager);
    const questions = await loadQuizModel(pool, quizId, { includeCorrect: true });
    assert(questions.length > 0, 400, 'La evaluación todavía no tiene preguntas.');
    const answers = normalizeAnswers(request.body?.answers, questions);
    const graded = gradeAttempt({ questions, answers, passingPercent: Number(quiz.passing_percent) });
    response.json({ ...attemptResponse(graded, { quiz, attemptNo: null, left: null, showAnswers: quiz.show_answers }), preview: true });
    return;
  }

  const outcome = await inTransaction(async (connection) => {
    // Serializa los intentos del mismo usuario; UNIQUE (quiz_id, user_id, attempt_no) es el respaldo.
    await connection.execute('SELECT id FROM users WHERE id = ? FOR UPDATE', [request.user.id]);
    const quiz = await findQuiz(connection, course.id, quizId);
    if (!quiz || (!manager && Number(quiz.question_count) === 0)) throw httpError(404, 'Evaluación no encontrada.');
    await assertItemUnlocked({ user: request.user, course, manager, itemId: quizId, executor: connection });
    const [attempts] = await connection.execute('SELECT attempt_no, passed FROM quiz_attempts WHERE quiz_id = ? AND user_id = ?', [quizId, request.user.id]);
    if (attempts.some((attempt) => attempt.passed)) throw httpError(409, 'Ya aprobaste esta evaluación.', true, 'QUIZ_ALREADY_PASSED');
    const maxAttempts = quiz.max_attempts === null ? null : Number(quiz.max_attempts);
    if (maxAttempts !== null && attempts.length >= maxAttempts) throw httpError(403, 'Agotaste los intentos disponibles de esta evaluación.', true, 'ATTEMPTS_EXHAUSTED');
    // Las preguntas se leen dentro de la transacción: se califica contra lo vigente al guardar.
    const questions = await loadQuizModel(connection, quizId, { includeCorrect: true });
    assert(questions.length > 0, 400, 'La evaluación todavía no tiene preguntas.');
    const answers = normalizeAnswers(request.body?.answers, questions);
    const graded = gradeAttempt({ questions, answers, passingPercent: Number(quiz.passing_percent) });
    const attemptNo = attempts.reduce((max, attempt) => Math.max(max, Number(attempt.attempt_no)), 0) + 1;
    await connection.execute(
      `INSERT INTO quiz_attempts (quiz_id, user_id, attempt_no, earned_points, total_points, score_percent, correct_count, total_count, passed, answers)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [quizId, request.user.id, attemptNo, graded.earnedPoints, graded.totalPoints, graded.scorePercent, graded.correctCount, graded.totalCount, graded.passed ? 1 : 0, JSON.stringify(answers)],
    );
    if (graded.passed) {
      await connection.execute(
        `INSERT INTO lesson_progress (user_id, lesson_id, completed_at, last_position_seconds) VALUES (?, ?, ?, 0)
         ON DUPLICATE KEY UPDATE completed_at = COALESCE(completed_at, VALUES(completed_at))`,
        [request.user.id, quizId, new Date()],
      );
    }
    return attemptResponse(graded, { quiz, attemptNo, left: attemptsLeft(maxAttempts, attempts.length + 1), showAnswers: quiz.show_answers });
  });
  response.status(201).json(outcome);
});

quizzesLearnerRouter.get('/:courseId/quizzes/:quizId/attempts/mine', requireAuth, async (request, response) => {
  const courseId = idOf(request.params.courseId, 'Curso');
  const quizId = idOf(request.params.quizId, 'Evaluación');
  const { course, manager } = await assertLearnerCourseAccess(request.user, courseId);
  const quiz = await learnerQuiz(course.id, quizId, manager);
  const [rows] = await pool.execute(
    `SELECT attempt_no, earned_points, total_points, score_percent, correct_count, total_count, passed, submitted_at
     FROM quiz_attempts WHERE quiz_id = ? AND user_id = ? ORDER BY attempt_no`,
    [quizId, request.user.id],
  );
  const summary = await attemptSummary(pool, quizId, request.user.id, quiz.max_attempts === null ? null : Number(quiz.max_attempts));
  response.json({
    ...summary,
    attempts: rows.map((row) => ({
      attemptNo: Number(row.attempt_no),
      earnedPoints: Number(row.earned_points),
      totalPoints: Number(row.total_points),
      scorePercent: Number(row.score_percent),
      correctCount: Number(row.correct_count),
      totalCount: Number(row.total_count),
      passed: Boolean(row.passed),
      submittedAt: row.submitted_at,
    })),
  });
});
