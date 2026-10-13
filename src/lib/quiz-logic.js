import { httpError } from './http-error.js';

// Lógica pura de evaluaciones (validación, calificación, bloqueos, progreso e inserción en posición).
// No importar env ni base de datos: las pruebas unitarias cargan este archivo sin .env.

export const QUIZ_LABELS = Object.freeze(['diagnostica', 'repaso', 'final', 'otro']);
export const SHOW_ANSWERS_MODES = Object.freeze(['never', 'after_submit', 'after_pass']);
export const QUESTION_TYPES = Object.freeze(['single', 'multiple', 'true_false']);
export const QUIZ_LIMITS = Object.freeze({
  titleMin: 1,
  titleMax: 180,
  descriptionMax: 10000,
  minQuestions: 1,
  maxQuestions: 100,
  minOptions: 2,
  maxOptions: 8,
  promptMin: 1,
  promptMax: 2000,
  explanationMax: 2000,
  optionTextMin: 1,
  optionTextMax: 500,
  pointsMin: 1,
  pointsMax: 10,
  pointsDefault: 1,
  passingMin: 1,
  passingMax: 100,
  passingDefault: 70,
  attemptsMin: 1,
  attemptsMax: 99,
});

const TRUE_TEXT = 'Verdadero';
const FALSE_TEXT = 'Falso';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireText(value, label, { min = 1, max }) {
  if (typeof value !== 'string') throw httpError(400, `${label} debe ser texto.`);
  const text = value.trim();
  if (text.length < min) throw httpError(400, `${label} es obligatorio.`);
  if (text.length > max) throw httpError(400, `${label} no puede superar ${max} caracteres.`);
  return text;
}

function optionalText(value, label, max) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw httpError(400, `${label} debe ser texto.`);
  const text = value.trim();
  if (text.length > max) throw httpError(400, `${label} no puede superar ${max} caracteres.`);
  return text;
}

function boundedInteger(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw httpError(400, `${label} debe ser un entero entre ${min} y ${max}.`);
  }
  return value;
}

// Ajustes de la evaluación. Con { partial: true } solo valida y devuelve las claves enviadas (PATCH).
export function normalizeQuizSettings(body, { partial = false } = {}) {
  if (!isPlainObject(body)) throw httpError(400, 'Los datos de la evaluación no son válidos.');
  const has = (key) => Object.hasOwn(body, key) && body[key] !== undefined;
  const result = {};

  if (has('title') || !partial) result.title = requireText(body.title, 'El título', { min: QUIZ_LIMITS.titleMin, max: QUIZ_LIMITS.titleMax });
  if (has('description') || !partial) result.description = optionalText(body.description, 'La descripción', QUIZ_LIMITS.descriptionMax);

  if (has('label') || !partial) {
    const label = has('label') ? body.label : 'otro';
    if (typeof label !== 'string' || !QUIZ_LABELS.includes(label)) throw httpError(400, 'El tipo de evaluación no es válido.');
    result.label = label;
  }

  if (has('passingPercent') || !partial) {
    const value = has('passingPercent') ? body.passingPercent : QUIZ_LIMITS.passingDefault;
    result.passingPercent = boundedInteger(value, 'El porcentaje para aprobar', QUIZ_LIMITS.passingMin, QUIZ_LIMITS.passingMax);
  }

  if (has('isRequired') || !partial) {
    const value = has('isRequired') ? body.isRequired : false;
    if (typeof value !== 'boolean') throw httpError(400, 'Indica con verdadero o falso si la evaluación es obligatoria.');
    result.isRequired = value;
  }

  if (has('maxAttempts') || !partial) {
    const value = has('maxAttempts') ? body.maxAttempts : null;
    result.maxAttempts = value === null ? null : boundedInteger(value, 'El máximo de intentos', QUIZ_LIMITS.attemptsMin, QUIZ_LIMITS.attemptsMax);
  }

  if (has('showAnswers') || !partial) {
    const value = has('showAnswers') ? body.showAnswers : 'after_submit';
    if (typeof value !== 'string' || !SHOW_ANSWERS_MODES.includes(value)) throw httpError(400, 'La opción para mostrar respuestas no es válida.');
    result.showAnswers = value;
  }

  if (partial && Object.keys(result).length === 0) throw httpError(400, 'No hay cambios que guardar.');
  return result;
}

function optionKey(text) {
  return text.normalize('NFC').toLocaleLowerCase('es');
}

function trueFalseValue(body) {
  if (typeof body.correct === 'boolean') return body.correct;
  if (body.correct !== undefined && body.correct !== null) throw httpError(400, 'La respuesta correcta de verdadero/falso debe ser verdadero o falso.');
  const options = body.options;
  if (!Array.isArray(options) || options.length !== 2) throw httpError(400, 'Una pregunta de verdadero/falso necesita indicar la respuesta correcta.');
  if (!options.every((option) => isPlainObject(option) && typeof option.isCorrect === 'boolean')) {
    throw httpError(400, 'Cada opción debe indicar si es correcta.');
  }
  const correct = options.filter((option) => option.isCorrect);
  if (correct.length !== 1) throw httpError(400, 'Una pregunta de verdadero/falso debe tener exactamente una respuesta correcta.');
  const texts = options.map((option) => (typeof option.text === 'string' ? optionKey(option.text.trim()) : ''));
  const named = texts.some((text) => text === optionKey(TRUE_TEXT) || text === optionKey(FALSE_TEXT));
  if (named) return texts[options.indexOf(correct[0])] === optionKey(TRUE_TEXT);
  return options.indexOf(correct[0]) === 0;
}

// Pregunta lista para guardar: { type, prompt, explanation, points, options: [{ text, isCorrect }] }.
export function normalizeQuestion(body) {
  if (!isPlainObject(body)) throw httpError(400, 'Los datos de la pregunta no son válidos.');
  if (typeof body.type !== 'string' || !QUESTION_TYPES.includes(body.type)) throw httpError(400, 'El tipo de pregunta no es válido.');
  const type = body.type;
  const prompt = requireText(body.prompt, 'El enunciado', { min: QUIZ_LIMITS.promptMin, max: QUIZ_LIMITS.promptMax });
  const explanation = optionalText(body.explanation, 'La explicación', QUIZ_LIMITS.explanationMax) || null;
  const points = body.points === undefined || body.points === null
    ? QUIZ_LIMITS.pointsDefault
    : boundedInteger(body.points, 'Los puntos', QUIZ_LIMITS.pointsMin, QUIZ_LIMITS.pointsMax);

  if (type === 'true_false') {
    const value = trueFalseValue(body);
    return { type, prompt, explanation, points, options: [{ text: TRUE_TEXT, isCorrect: value }, { text: FALSE_TEXT, isCorrect: !value }] };
  }

  const raw = body.options;
  if (!Array.isArray(raw)) throw httpError(400, 'Las opciones deben ser una lista.');
  if (raw.length < QUIZ_LIMITS.minOptions || raw.length > QUIZ_LIMITS.maxOptions) {
    throw httpError(400, `La pregunta debe tener entre ${QUIZ_LIMITS.minOptions} y ${QUIZ_LIMITS.maxOptions} opciones.`);
  }
  const seen = new Set();
  const options = raw.map((option) => {
    if (!isPlainObject(option)) throw httpError(400, 'Cada opción debe ser un objeto con texto y si es correcta.');
    const text = requireText(option.text, 'El texto de la opción', { min: QUIZ_LIMITS.optionTextMin, max: QUIZ_LIMITS.optionTextMax });
    if (option.isCorrect !== undefined && typeof option.isCorrect !== 'boolean') throw httpError(400, 'Cada opción debe indicar con verdadero o falso si es correcta.');
    const key = optionKey(text);
    if (seen.has(key)) throw httpError(400, 'Las opciones no pueden repetirse.');
    seen.add(key);
    return { text, isCorrect: option.isCorrect === true };
  });
  const correctCount = options.filter((option) => option.isCorrect).length;
  if (type === 'single' && correctCount !== 1) throw httpError(400, 'Una pregunta de opción única debe tener exactamente una respuesta correcta.');
  if (type === 'multiple' && correctCount < 1) throw httpError(400, 'Una pregunta de opción múltiple debe tener al menos una respuesta correcta.');
  return { type, prompt, explanation, points, options };
}

// questions: [{ id, type, options: [{ id }] }]. Devuelve { [questionId]: [optionId, ...] } solo con preguntas del quiz.
export function normalizeAnswers(raw, questions) {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) throw httpError(400, 'Las respuestas no son válidas.');
  const keys = Object.keys(raw);
  if (keys.length > QUIZ_LIMITS.maxQuestions) throw httpError(400, 'Las respuestas superan el máximo de preguntas permitido.');
  const byId = new Map(questions.map((question) => [String(question.id), question]));
  const answers = {};
  for (const key of keys) {
    const question = byId.get(key);
    if (!question) throw httpError(400, 'Las respuestas incluyen preguntas que no pertenecen a esta evaluación.');
    const value = raw[key];
    if (!Array.isArray(value)) throw httpError(400, 'Las respuestas de cada pregunta deben ser una lista de opciones.');
    const allowed = new Set(question.options.map((option) => Number(option.id)));
    const ids = value.map((item) => {
      const id = typeof item === 'number' ? item : NaN;
      if (!Number.isSafeInteger(id) || !allowed.has(id)) throw httpError(400, 'Las respuestas incluyen opciones que no pertenecen a la pregunta.');
      return id;
    });
    if (new Set(ids).size !== ids.length) throw httpError(400, 'Las respuestas contienen opciones repetidas.');
    if (question.type !== 'multiple' && ids.length > 1) throw httpError(400, 'Esta pregunta admite una sola opción.');
    answers[key] = ids;
  }
  return answers;
}

// questions: [{ id, points, explanation, options: [{ id, isCorrect }] }]. answers: salida de normalizeAnswers.
export function gradeAttempt({ questions, answers = {}, passingPercent }) {
  let earnedPoints = 0;
  let totalPoints = 0;
  let correctCount = 0;
  const results = questions.map((question) => {
    const points = Number(question.points);
    const correctOptionIds = question.options.filter((option) => option.isCorrect).map((option) => Number(option.id));
    const selectedOptionIds = [...(answers[question.id] ?? [])];
    const correct = new Set(correctOptionIds);
    const isCorrect = selectedOptionIds.length === correct.size && selectedOptionIds.every((id) => correct.has(id));
    totalPoints += points;
    if (isCorrect) {
      earnedPoints += points;
      correctCount += 1;
    }
    return { questionId: Number(question.id), isCorrect, selectedOptionIds, correctOptionIds, explanation: question.explanation ?? null };
  });
  const scorePercent = totalPoints > 0 ? Math.round((earnedPoints * 10000) / totalPoints) / 100 : 0;
  return {
    earnedPoints,
    totalPoints,
    scorePercent,
    correctCount,
    totalCount: questions.length,
    passed: totalPoints > 0 && earnedPoints * 100 >= Number(passingPercent) * totalPoints,
    results,
  };
}

// Resultados por pregunta para el alumno: isCorrect siempre; las respuestas correctas y la explicación según showAnswers.
export function revealResults(graded, { showAnswers }) {
  const reveal = showAnswers === 'after_submit' || (showAnswers === 'after_pass' && Boolean(graded.passed));
  return graded.results.map((result) => (reveal
    ? { ...result }
    : { questionId: result.questionId, isCorrect: result.isCorrect, selectedOptionIds: result.selectedOptionIds }));
}

export function isEffectiveRequired({ isRequired, questionCount }) {
  return Boolean(isRequired) && Number(questionCount) > 0;
}

// null = intentos ilimitados.
export function attemptsLeft(maxAttempts, used) {
  if (maxAttempts === null || maxAttempts === undefined) return null;
  return Math.max(0, Number(maxAttempts) - Number(used));
}

// items en orden de lectura: [{ id, kind, title, required, completed }] con `required` ya efectivo.
// El primer quiz obligatorio no aprobado bloquea todo lo posterior. Devuelve Map id -> { quizId, title } | null.
export function computeLocks(items) {
  const locks = new Map();
  let blocker = null;
  for (const item of items) {
    locks.set(item.id, blocker);
    if (!blocker && item.kind === 'quiz' && item.required && !item.completed) blocker = { quizId: item.id, title: item.title };
  }
  return locks;
}

// COUNTED = video, o evaluación obligatoria (efectiva). Mismo criterio que countedLessonSql.
export function computeProgress(items) {
  const counted = items.filter((item) => item.kind !== 'quiz' || item.required);
  const completed = counted.filter((item) => item.completed).length;
  const total = counted.length;
  return {
    completed,
    total,
    percent: total > 0 ? Math.round((completed * 100) / total) : 0,
    pendingRequired: counted.filter((item) => item.kind === 'quiz' && !item.completed).map((item) => ({ id: item.id, title: item.title })),
  };
}

// currentSections: [{ id, lessonIds }]. Devuelve el diseño para planLessonLayout con newId insertado en la
// sección en `index` (fuera de rango o ausente = final de la sección). No muta la entrada.
export function insertAtIndex(currentSections, sectionId, newId, index) {
  if (!currentSections.some((section) => Number(section.id) === Number(sectionId))) throw httpError(404, 'Sección no encontrada en este curso.');
  return currentSections.map((section) => {
    const lessonIds = section.lessonIds.map(Number).filter((id) => id !== Number(newId));
    if (Number(section.id) !== Number(sectionId)) return { id: Number(section.id), lessonIds };
    const at = Number.isInteger(index) && index >= 0 && index <= lessonIds.length ? index : lessonIds.length;
    return { id: Number(section.id), lessonIds: [...lessonIds.slice(0, at), Number(newId), ...lessonIds.slice(at)] };
  });
}

// Fragmento SQL: la clase cuenta para el avance (video, o evaluación obligatoria con al menos una pregunta).
export function countedLessonSql(alias = 'l') {
  if (typeof alias !== 'string' || !/^[a-z_][a-z0-9_]*$/i.test(alias) || ['cq', 'cqq'].includes(alias.toLowerCase())) {
    throw new Error('Alias de tabla no válido.');
  }
  return `(${alias}.kind = 'video' OR EXISTS (SELECT 1 FROM quizzes cq WHERE cq.lesson_id = ${alias}.id AND cq.is_required = 1 AND EXISTS (SELECT 1 FROM quiz_questions cqq WHERE cqq.quiz_id = cq.lesson_id)))`;
}
