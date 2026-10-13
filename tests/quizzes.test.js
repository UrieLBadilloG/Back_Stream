import assert from 'node:assert/strict';
import test from 'node:test';

import {
  QUESTION_TYPES,
  QUIZ_LABELS,
  QUIZ_LIMITS,
  SHOW_ANSWERS_MODES,
  attemptsLeft,
  computeLocks,
  computeProgress,
  countedLessonSql,
  gradeAttempt,
  insertAtIndex,
  isEffectiveRequired,
  normalizeAnswers,
  normalizeQuestion,
  normalizeQuizSettings,
  normalizeQuizSettings as settings,
  revealResults,
} from '../src/lib/quiz-logic.js';
import { planLessonLayout } from '../src/lib/course-structure.js';

const is400 = (error) => error.statusCode === 400 && error.expose === true;
const rejects400 = (fn) => assert.throws(fn, is400);
const opts = (...marks) => marks.map((isCorrect, index) => ({ text: `Opción ${index + 1}`, isCorrect }));

test('constantes expuestas', () => {
  assert.deepEqual([...QUIZ_LABELS], ['diagnostica', 'repaso', 'final', 'otro']);
  assert.deepEqual([...SHOW_ANSWERS_MODES], ['never', 'after_submit', 'after_pass']);
  assert.deepEqual([...QUESTION_TYPES], ['single', 'multiple', 'true_false']);
  assert.equal(QUIZ_LIMITS.maxQuestions, 100);
  assert.equal(QUIZ_LIMITS.passingDefault, 70);
});

// ---------- ajustes ----------

test('ajustes: valores por defecto al crear', () => {
  assert.deepEqual(normalizeQuizSettings({ title: '  Diagnóstico  ' }), {
    title: 'Diagnóstico', description: '', label: 'otro', passingPercent: 70, isRequired: false, maxAttempts: null, showAnswers: 'after_submit',
  });
});

test('ajustes: acepta todos los campos válidos', () => {
  const result = normalizeQuizSettings({ title: 'Final', description: 'Descripción', label: 'final', passingPercent: 100, isRequired: true, maxAttempts: 3, showAnswers: 'never' });
  assert.deepEqual(result, { title: 'Final', description: 'Descripción', label: 'final', passingPercent: 100, isRequired: true, maxAttempts: 3, showAnswers: 'never' });
});

test('ajustes: título obligatorio, texto y hasta 180 caracteres', () => {
  rejects400(() => normalizeQuizSettings({}));
  rejects400(() => normalizeQuizSettings({ title: '   ' }));
  rejects400(() => normalizeQuizSettings({ title: 42 }));
  rejects400(() => normalizeQuizSettings({ title: 'x'.repeat(181) }));
  assert.equal(normalizeQuizSettings({ title: 'x'.repeat(180) }).title.length, 180);
});

test('ajustes: descripción de hasta 10000 caracteres', () => {
  rejects400(() => normalizeQuizSettings({ title: 'A', description: 'x'.repeat(10001) }));
  rejects400(() => normalizeQuizSettings({ title: 'A', description: 5 }));
  assert.equal(normalizeQuizSettings({ title: 'A', description: null }).description, '');
  assert.equal(normalizeQuizSettings({ title: 'A', description: 'x'.repeat(10000) }).description.length, 10000);
});

test('ajustes: etiqueta y mostrar respuestas deben pertenecer a las listas', () => {
  rejects400(() => normalizeQuizSettings({ title: 'A', label: 'examen' }));
  rejects400(() => normalizeQuizSettings({ title: 'A', label: 1 }));
  rejects400(() => normalizeQuizSettings({ title: 'A', showAnswers: 'always' }));
  rejects400(() => normalizeQuizSettings({ title: 'A', showAnswers: true }));
  for (const label of QUIZ_LABELS) assert.equal(normalizeQuizSettings({ title: 'A', label }).label, label);
  for (const mode of SHOW_ANSWERS_MODES) assert.equal(normalizeQuizSettings({ title: 'A', showAnswers: mode }).showAnswers, mode);
});

test('ajustes: porcentaje para aprobar entero entre 1 y 100', () => {
  for (const bad of [0, 101, -5, 70.5, '70', null, NaN, true]) rejects400(() => normalizeQuizSettings({ title: 'A', passingPercent: bad }));
  assert.equal(normalizeQuizSettings({ title: 'A', passingPercent: 1 }).passingPercent, 1);
  assert.equal(normalizeQuizSettings({ title: 'A', passingPercent: 100 }).passingPercent, 100);
});

test('ajustes: obligatoria es booleano estricto', () => {
  for (const bad of ['true', 1, 0, null, 'si']) rejects400(() => normalizeQuizSettings({ title: 'A', isRequired: bad }));
  assert.equal(normalizeQuizSettings({ title: 'A', isRequired: true }).isRequired, true);
  assert.equal(normalizeQuizSettings({ title: 'A', isRequired: false }).isRequired, false);
});

test('ajustes: máximo de intentos entre 1 y 99 o null', () => {
  for (const bad of [0, 100, 1.5, '3', -1]) rejects400(() => normalizeQuizSettings({ title: 'A', maxAttempts: bad }));
  assert.equal(normalizeQuizSettings({ title: 'A', maxAttempts: null }).maxAttempts, null);
  assert.equal(normalizeQuizSettings({ title: 'A', maxAttempts: 1 }).maxAttempts, 1);
  assert.equal(normalizeQuizSettings({ title: 'A', maxAttempts: 99 }).maxAttempts, 99);
});

test('ajustes: cuerpos que no son objeto se rechazan', () => {
  for (const bad of [undefined, null, 'texto', [], 5]) rejects400(() => normalizeQuizSettings(bad));
});

test('ajustes parciales: solo valida y devuelve lo enviado', () => {
  assert.deepEqual(settings({ passingPercent: 80 }, { partial: true }), { passingPercent: 80 });
  assert.deepEqual(settings({ maxAttempts: null, isRequired: true }, { partial: true }), { maxAttempts: null, isRequired: true });
  rejects400(() => settings({}, { partial: true }));
  rejects400(() => settings({ title: '' }, { partial: true }));
  rejects400(() => settings({ isRequired: 'true' }, { partial: true }));
});

// ---------- preguntas ----------

test('pregunta single válida', () => {
  const question = normalizeQuestion({ type: 'single', prompt: ' ¿Cuál? ', options: opts(false, true, false) });
  assert.equal(question.prompt, '¿Cuál?');
  assert.equal(question.points, 1);
  assert.equal(question.explanation, null);
  assert.equal(question.options.filter((option) => option.isCorrect).length, 1);
});

test('pregunta: tipo, enunciado, explicación y puntos', () => {
  rejects400(() => normalizeQuestion(null));
  rejects400(() => normalizeQuestion({ prompt: 'A', options: opts(true, false) }));
  rejects400(() => normalizeQuestion({ type: 'open', prompt: 'A', options: opts(true, false) }));
  rejects400(() => normalizeQuestion({ type: 'single', prompt: '', options: opts(true, false) }));
  rejects400(() => normalizeQuestion({ type: 'single', prompt: 7, options: opts(true, false) }));
  rejects400(() => normalizeQuestion({ type: 'single', prompt: 'x'.repeat(2001), options: opts(true, false) }));
  assert.equal(normalizeQuestion({ type: 'single', prompt: 'x'.repeat(2000), options: opts(true, false) }).prompt.length, 2000);
  rejects400(() => normalizeQuestion({ type: 'single', prompt: 'A', explanation: 'x'.repeat(2001), options: opts(true, false) }));
  assert.equal(normalizeQuestion({ type: 'single', prompt: 'A', explanation: '  porque  ', options: opts(true, false) }).explanation, 'porque');
  for (const bad of [0, 11, 2.5, '3']) rejects400(() => normalizeQuestion({ type: 'single', prompt: 'A', points: bad, options: opts(true, false) }));
  assert.equal(normalizeQuestion({ type: 'single', prompt: 'A', points: 10, options: opts(true, false) }).points, 10);
  assert.equal(normalizeQuestion({ type: 'single', prompt: 'A', points: 1, options: opts(true, false) }).points, 1);
});

test('pregunta single: 2 a 8 opciones y exactamente una correcta', () => {
  rejects400(() => normalizeQuestion({ type: 'single', prompt: 'A', options: opts(true) }));
  rejects400(() => normalizeQuestion({ type: 'single', prompt: 'A', options: opts(true, false, false, false, false, false, false, false, false) }));
  assert.equal(normalizeQuestion({ type: 'single', prompt: 'A', options: opts(true, false, false, false, false, false, false, false) }).options.length, 8);
  rejects400(() => normalizeQuestion({ type: 'single', prompt: 'A', options: opts(false, false) }));
  rejects400(() => normalizeQuestion({ type: 'single', prompt: 'A', options: opts(true, true) }));
  rejects400(() => normalizeQuestion({ type: 'single', prompt: 'A', options: 'no' }));
});

test('pregunta multiple: al menos una correcta, permite varias', () => {
  assert.equal(normalizeQuestion({ type: 'multiple', prompt: 'A', options: opts(true, true, false) }).options.filter((option) => option.isCorrect).length, 2);
  assert.equal(normalizeQuestion({ type: 'multiple', prompt: 'A', options: opts(true, false) }).options.length, 2);
  rejects400(() => normalizeQuestion({ type: 'multiple', prompt: 'A', options: opts(false, false, false) }));
});

test('opciones: texto obligatorio, único, hasta 500 y booleano estricto', () => {
  rejects400(() => normalizeQuestion({ type: 'single', prompt: 'A', options: [{ text: '', isCorrect: true }, { text: 'B', isCorrect: false }] }));
  rejects400(() => normalizeQuestion({ type: 'single', prompt: 'A', options: [{ text: 5, isCorrect: true }, { text: 'B', isCorrect: false }] }));
  rejects400(() => normalizeQuestion({ type: 'single', prompt: 'A', options: [{ text: 'x'.repeat(501), isCorrect: true }, { text: 'B', isCorrect: false }] }));
  assert.equal(normalizeQuestion({ type: 'single', prompt: 'A', options: [{ text: 'x'.repeat(500), isCorrect: true }, { text: 'B', isCorrect: false }] }).options[0].text.length, 500);
  rejects400(() => normalizeQuestion({ type: 'single', prompt: 'A', options: [{ text: 'Sí', isCorrect: true }, { text: ' sí ', isCorrect: false }] }));
  rejects400(() => normalizeQuestion({ type: 'single', prompt: 'A', options: [{ text: 'A', isCorrect: 'true' }, { text: 'B', isCorrect: false }] }));
  rejects400(() => normalizeQuestion({ type: 'single', prompt: 'A', options: ['A', 'B'] }));
});

test('pregunta true_false: opciones construidas por el servidor desde correct', () => {
  const yes = normalizeQuestion({ type: 'true_false', prompt: 'A', correct: true });
  assert.deepEqual(yes.options, [{ text: 'Verdadero', isCorrect: true }, { text: 'Falso', isCorrect: false }]);
  const no = normalizeQuestion({ type: 'true_false', prompt: 'A', correct: false });
  assert.deepEqual(no.options, [{ text: 'Verdadero', isCorrect: false }, { text: 'Falso', isCorrect: true }]);
});

test('pregunta true_false: acepta options con textos Verdadero/Falso y los ignora al reconstruir', () => {
  const question = normalizeQuestion({ type: 'true_false', prompt: 'A', options: [{ text: 'Falso', isCorrect: true }, { text: 'Verdadero', isCorrect: false }] });
  assert.deepEqual(question.options, [{ text: 'Verdadero', isCorrect: false }, { text: 'Falso', isCorrect: true }]);
  const byOrder = normalizeQuestion({ type: 'true_false', prompt: 'A', options: [{ text: 'Sí', isCorrect: true }, { text: 'No', isCorrect: false }] });
  assert.equal(byOrder.options[0].isCorrect, true);
});

test('pregunta true_false: rechaza entradas inconsistentes', () => {
  rejects400(() => normalizeQuestion({ type: 'true_false', prompt: 'A' }));
  rejects400(() => normalizeQuestion({ type: 'true_false', prompt: 'A', correct: 'true' }));
  rejects400(() => normalizeQuestion({ type: 'true_false', prompt: 'A', options: opts(true, true) }));
  rejects400(() => normalizeQuestion({ type: 'true_false', prompt: 'A', options: opts(false, false) }));
  rejects400(() => normalizeQuestion({ type: 'true_false', prompt: 'A', options: opts(true, false, false) }));
});

// ---------- respuestas ----------

const QUESTIONS = [
  { id: 1, type: 'single', points: 1, explanation: 'Porque sí', options: [{ id: 11, isCorrect: false }, { id: 12, isCorrect: true }, { id: 13, isCorrect: false }] },
  { id: 2, type: 'multiple', points: 1, explanation: null, options: [{ id: 21, isCorrect: true }, { id: 22, isCorrect: true }, { id: 23, isCorrect: false }] },
  { id: 3, type: 'true_false', points: 1, explanation: null, options: [{ id: 31, isCorrect: true }, { id: 32, isCorrect: false }] },
];

test('respuestas: acepta ids válidos y trata las ausentes como sin responder', () => {
  assert.deepEqual(normalizeAnswers({ 1: [12], 2: [21, 22] }, QUESTIONS), { 1: [12], 2: [21, 22] });
  assert.deepEqual(normalizeAnswers(undefined, QUESTIONS), {});
  assert.deepEqual(normalizeAnswers({}, QUESTIONS), {});
  assert.deepEqual(normalizeAnswers({ 3: [] }, QUESTIONS), { 3: [] });
});

test('respuestas: ids ajenos, repetidos, sobrantes o de otro tipo se rechazan', () => {
  rejects400(() => normalizeAnswers({ 99: [11] }, QUESTIONS));
  rejects400(() => normalizeAnswers({ 1: [21] }, QUESTIONS));
  rejects400(() => normalizeAnswers({ 2: [21, 21] }, QUESTIONS));
  rejects400(() => normalizeAnswers({ 1: [11, 12] }, QUESTIONS));
  rejects400(() => normalizeAnswers({ 3: [31, 32] }, QUESTIONS));
  rejects400(() => normalizeAnswers({ 1: 12 }, QUESTIONS));
  rejects400(() => normalizeAnswers({ 1: ['12'] }, QUESTIONS));
  rejects400(() => normalizeAnswers([], QUESTIONS));
  rejects400(() => normalizeAnswers('x', QUESTIONS));
});

test('respuestas: máximo 100 claves', () => {
  const many = Array.from({ length: 101 }, (_, index) => ({ id: index + 1, type: 'single', options: [{ id: 1000 + index }] }));
  const raw = Object.fromEntries(many.map((question) => [question.id, []]));
  rejects400(() => normalizeAnswers(raw, many));
});

// ---------- calificación ----------

test('califica single, multiple y true_false', () => {
  const graded = gradeAttempt({ questions: QUESTIONS, answers: { 1: [12], 2: [21, 22], 3: [32] }, passingPercent: 70 });
  assert.equal(graded.correctCount, 2);
  assert.equal(graded.totalCount, 3);
  assert.equal(graded.earnedPoints, 2);
  assert.equal(graded.totalPoints, 3);
  assert.equal(graded.scorePercent, 66.67);
  assert.equal(graded.passed, false);
  assert.deepEqual(graded.results.map((result) => result.isCorrect), [true, true, false]);
  assert.deepEqual(graded.results[2].selectedOptionIds, [32]);
  assert.deepEqual(graded.results[2].correctOptionIds, [31]);
  assert.equal(graded.results[0].explanation, 'Porque sí');
});

test('multiple no da crédito parcial ni con sobrantes', () => {
  const partial = gradeAttempt({ questions: [QUESTIONS[1]], answers: { 2: [21] }, passingPercent: 1 });
  assert.equal(partial.results[0].isCorrect, false);
  assert.equal(partial.earnedPoints, 0);
  const extra = gradeAttempt({ questions: [QUESTIONS[1]], answers: { 2: [21, 22, 23] }, passingPercent: 1 });
  assert.equal(extra.results[0].isCorrect, false);
  const exact = gradeAttempt({ questions: [QUESTIONS[1]], answers: { 2: [22, 21] }, passingPercent: 100 });
  assert.equal(exact.results[0].isCorrect, true);
  assert.equal(exact.passed, true);
});

test('preguntas sin responder cuentan como incorrectas', () => {
  const graded = gradeAttempt({ questions: QUESTIONS, answers: {}, passingPercent: 70 });
  assert.equal(graded.earnedPoints, 0);
  assert.equal(graded.scorePercent, 0);
  assert.equal(graded.passed, false);
  assert.deepEqual(graded.results[0].selectedOptionIds, []);
});

test('ponderación por puntos', () => {
  const questions = [
    { id: 1, points: 5, options: [{ id: 1, isCorrect: true }, { id: 2, isCorrect: false }] },
    { id: 2, points: 1, options: [{ id: 3, isCorrect: true }, { id: 4, isCorrect: false }] },
  ];
  const onlyHeavy = gradeAttempt({ questions, answers: { 1: [1], 2: [4] }, passingPercent: 80 });
  assert.equal(onlyHeavy.earnedPoints, 5);
  assert.equal(onlyHeavy.totalPoints, 6);
  assert.equal(onlyHeavy.scorePercent, 83.33);
  assert.equal(onlyHeavy.correctCount, 1);
  assert.equal(onlyHeavy.passed, true);
  const onlyLight = gradeAttempt({ questions, answers: { 1: [2], 2: [3] }, passingPercent: 20 });
  assert.equal(onlyLight.scorePercent, 16.67);
  assert.equal(onlyLight.passed, false);
});

test('borde exacto de aprobación con enteros', () => {
  const ten = Array.from({ length: 10 }, (_, index) => ({ id: index + 1, points: 1, options: [{ id: 100 + index, isCorrect: true }, { id: 200 + index, isCorrect: false }] }));
  const answersWith = (right) => Object.fromEntries(ten.map((question, index) => [question.id, [index < right ? 100 + index : 200 + index]]));
  assert.equal(gradeAttempt({ questions: ten, answers: answersWith(7), passingPercent: 70 }).passed, true);
  assert.equal(gradeAttempt({ questions: ten, answers: answersWith(6), passingPercent: 70 }).passed, false);
  assert.equal(gradeAttempt({ questions: ten, answers: answersWith(10), passingPercent: 100 }).passed, true);
  assert.equal(gradeAttempt({ questions: ten, answers: answersWith(9), passingPercent: 100 }).passed, false);
  // 2/3 = 66.67 redondeado, pero 67% exige 3 de 3 en enteros: 2*100 < 67*3
  const three = ten.slice(0, 3);
  const graded = gradeAttempt({ questions: three, answers: { 1: [100], 2: [101], 3: [202] }, passingPercent: 67 });
  assert.equal(graded.scorePercent, 66.67);
  assert.equal(graded.passed, false);
  // 7/10 con 70 aprueba pero 69/100 con 70 no (aunque el redondeo a 2 decimales no oculte la diferencia)
  const hundred = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, points: 1, options: [{ id: 1000 + index, isCorrect: true }, { id: 2000 + index, isCorrect: false }] }));
  const hundredWith = (right) => Object.fromEntries(hundred.map((question, index) => [question.id, [index < right ? 1000 + index : 2000 + index]]));
  assert.equal(gradeAttempt({ questions: hundred, answers: hundredWith(69), passingPercent: 70 }).passed, false);
  assert.equal(gradeAttempt({ questions: hundred, answers: hundredWith(70), passingPercent: 70 }).passed, true);
});

test('aprobación decidida con enteros: 1 de 3 (33.33) aprueba con 33 y no con 34', () => {
  const three = Array.from({ length: 3 }, (_, index) => ({ id: index + 1, points: 1, options: [{ id: 10 + index, isCorrect: true }, { id: 20 + index, isCorrect: false }] }));
  const graded = gradeAttempt({ questions: three, answers: { 1: [10], 2: [21], 3: [22] }, passingPercent: 34 });
  assert.equal(graded.scorePercent, 33.33);
  assert.equal(graded.passed, false);
  assert.equal(gradeAttempt({ questions: three, answers: { 1: [10], 2: [21], 3: [22] }, passingPercent: 33 }).passed, true);
});

test('una evaluación sin preguntas nunca aprueba', () => {
  const graded = gradeAttempt({ questions: [], answers: {}, passingPercent: 70 });
  assert.equal(graded.totalPoints, 0);
  assert.equal(graded.scorePercent, 0);
  assert.equal(graded.passed, false);
});

// ---------- revealResults ----------

test('revealResults según show_answers', () => {
  const failed = gradeAttempt({ questions: QUESTIONS, answers: { 1: [11] }, passingPercent: 70 });
  const passed = gradeAttempt({ questions: QUESTIONS, answers: { 1: [12], 2: [21, 22], 3: [31] }, passingPercent: 70 });
  assert.equal(passed.passed, true);

  const hidden = revealResults(failed, { showAnswers: 'never' });
  assert.deepEqual(Object.keys(hidden[0]).sort(), ['isCorrect', 'questionId', 'selectedOptionIds']);
  assert.equal(hidden[0].isCorrect, false);

  const afterSubmit = revealResults(failed, { showAnswers: 'after_submit' });
  assert.deepEqual(afterSubmit[0].correctOptionIds, [12]);
  assert.equal(afterSubmit[0].explanation, 'Porque sí');

  const afterPassFailed = revealResults(failed, { showAnswers: 'after_pass' });
  assert.equal(Object.hasOwn(afterPassFailed[0], 'correctOptionIds'), false);
  assert.equal(Object.hasOwn(afterPassFailed[0], 'explanation'), false);
  const afterPassPassed = revealResults(passed, { showAnswers: 'after_pass' });
  assert.deepEqual(afterPassPassed[0].correctOptionIds, [12]);

  assert.equal(revealResults(passed, { showAnswers: 'never' })[0].isCorrect, true);
});

// ---------- requeridas, intentos, bloqueos, progreso ----------

test('isEffectiveRequired exige preguntas', () => {
  assert.equal(isEffectiveRequired({ isRequired: true, questionCount: 3 }), true);
  assert.equal(isEffectiveRequired({ isRequired: true, questionCount: 0 }), false);
  assert.equal(isEffectiveRequired({ isRequired: false, questionCount: 3 }), false);
  assert.equal(isEffectiveRequired({ isRequired: 1, questionCount: '2' }), true);
});

test('attemptsLeft: null es ilimitado', () => {
  assert.equal(attemptsLeft(null, 5), null);
  assert.equal(attemptsLeft(undefined, 0), null);
  assert.equal(attemptsLeft(3, 1), 2);
  assert.equal(attemptsLeft(3, 3), 0);
  assert.equal(attemptsLeft(3, 9), 0);
});

const video = (id, completed = false) => ({ id, kind: 'video', title: `V${id}`, required: false, completed });
const quiz = (id, { required = true, completed = false } = {}) => ({ id, kind: 'quiz', title: `Q${id}`, required, completed });
const lockOf = (items) => Object.fromEntries([...computeLocks(items)].map(([id, lock]) => [id, lock?.quizId ?? null]));

test('computeLocks: sin evaluaciones no hay bloqueos', () => {
  assert.deepEqual(lockOf([video(1), video(2), video(3)]), { 1: null, 2: null, 3: null });
  assert.equal(computeLocks([]).size, 0);
});

test('computeLocks: obligatoria pendiente bloquea lo posterior, incluida otra evaluación', () => {
  const locks = computeLocks([video(1), quiz(2), video(3), quiz(4, { required: false })]);
  assert.equal(locks.get(1), null);
  assert.equal(locks.get(2), null);
  assert.deepEqual(locks.get(3), { quizId: 2, title: 'Q2' });
  assert.deepEqual(locks.get(4), { quizId: 2, title: 'Q2' });
});

test('computeLocks: opcional no bloquea y aprobada desbloquea', () => {
  assert.deepEqual(lockOf([video(1), quiz(2, { required: false }), video(3)]), { 1: null, 2: null, 3: null });
  assert.deepEqual(lockOf([video(1), quiz(2, { completed: true }), video(3)]), { 1: null, 2: null, 3: null });
});

test('computeLocks: con dos obligatorias el primer pendiente manda', () => {
  const items = [video(1), quiz(2), video(3), quiz(4), video(5)];
  assert.deepEqual(lockOf(items), { 1: null, 2: null, 3: 2, 4: 2, 5: 2 });
  const firstPassed = [video(1), quiz(2, { completed: true }), video(3), quiz(4), video(5)];
  assert.deepEqual(lockOf(firstPassed), { 1: null, 2: null, 3: null, 4: null, 5: 4 });
});

test('computeProgress: opcionales cuentan solo cuando son obligatorias y los vacíos no cuentan', () => {
  const progress = computeProgress([video(1, true), video(2), quiz(3, { required: false }), quiz(4, { required: true, completed: true }), quiz(5, { required: true })]);
  assert.equal(progress.total, 4);
  assert.equal(progress.completed, 2);
  assert.equal(progress.percent, 50);
  assert.deepEqual(progress.pendingRequired, [{ id: 5, title: 'Q5' }]);
});

test('computeProgress: sin elementos contados da 0 y los redondeos son enteros', () => {
  assert.deepEqual(computeProgress([]), { completed: 0, total: 0, percent: 0, pendingRequired: [] });
  assert.equal(computeProgress([quiz(1, { required: false })]).percent, 0);
  assert.equal(computeProgress([video(1, true), video(2), video(3)]).percent, 33);
  assert.equal(computeProgress([video(1, true), video(2, true), video(3)]).percent, 67);
  assert.equal(computeProgress([video(1, true)]).percent, 100);
});

// ---------- insertAtIndex ----------

const SECTIONS = [{ id: 10, lessonIds: [1, 2, 3] }, { id: 20, lessonIds: [4] }, { id: 30, lessonIds: [] }];

test('insertAtIndex: inicio, medio, final y fuera de rango', () => {
  assert.deepEqual(insertAtIndex(SECTIONS, 10, 99, 0)[0].lessonIds, [99, 1, 2, 3]);
  assert.deepEqual(insertAtIndex(SECTIONS, 10, 99, 2)[0].lessonIds, [1, 2, 99, 3]);
  assert.deepEqual(insertAtIndex(SECTIONS, 10, 99, 3)[0].lessonIds, [1, 2, 3, 99]);
  assert.deepEqual(insertAtIndex(SECTIONS, 10, 99, 50)[0].lessonIds, [1, 2, 3, 99]);
  assert.deepEqual(insertAtIndex(SECTIONS, 10, 99, -1)[0].lessonIds, [1, 2, 3, 99]);
  assert.deepEqual(insertAtIndex(SECTIONS, 10, 99)[0].lessonIds, [1, 2, 3, 99]);
  assert.deepEqual(insertAtIndex(SECTIONS, 10, 99, 1.5)[0].lessonIds, [1, 2, 3, 99]);
});

test('insertAtIndex: sección vacía, otras secciones intactas y entrada sin mutar', () => {
  const result = insertAtIndex(SECTIONS, 30, 99, 0);
  assert.deepEqual(result[2].lessonIds, [99]);
  assert.deepEqual(result[0].lessonIds, [1, 2, 3]);
  assert.deepEqual(SECTIONS[2].lessonIds, []);
  assert.throws(() => insertAtIndex(SECTIONS, 77, 99, 0), (error) => error.statusCode === 404);
});

test('insertAtIndex: si el id ya estaba en la sección (ya insertado al final) se reubica sin duplicar', () => {
  const current = [{ id: 10, lessonIds: [1, 2, 99] }, { id: 20, lessonIds: [4] }];
  assert.deepEqual(insertAtIndex(current, 10, 99, 0)[0].lessonIds, [99, 1, 2]);
  const plan = planLessonLayout(current, insertAtIndex(current, 10, 99, 1));
  assert.deepEqual(plan.map((item) => [item.lessonId, item.position]), [[1, 1], [99, 2], [2, 3], [4, 4]]);
});

// ---------- countedLessonSql ----------

test('countedLessonSql valida el alias y arma el fragmento', () => {
  const sql = countedLessonSql();
  assert.match(sql, /^\(l\.kind = 'video' OR EXISTS/);
  assert.match(sql, /cq\.lesson_id = l\.id AND cq\.is_required = 1/);
  assert.match(sql, /cqq\.quiz_id = cq\.lesson_id/);
  assert.match(countedLessonSql('lx_1'), /^\(lx_1\.kind = 'video'/);
  for (const bad of ['', '1a', 'l; DROP', 'l.x', 'a b', "l'", 'cq', 'cqq', null, 5]) {
    assert.throws(() => countedLessonSql(bad), /Alias/);
  }
});
