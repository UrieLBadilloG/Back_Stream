import { spawn } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import bcrypt from 'bcryptjs';

import { pool } from '../src/config/database.js';
import { createAccessToken } from '../src/middleware/auth.js';

// Verificación de punta a punta (API) de las evaluaciones intercaladas en el programa del curso.
// Levanta un backend temporal (:3100), crea datos temporales con prefijo "e2e-quiz-" en la base REAL,
// ejecuta los escenarios por HTTP real y limpia al final comparando los conteos con los iniciales.
//   E2E_CONFIRM=yes npm run test:quizzes:e2e
//   E2E_CONFIRM=yes npm run test:quizzes:e2e -- --hold   (para la corrida del navegador)
// Con --hold escribe %TEMP%/quizzes-fixtures.json, imprime READY y espera %TEMP%/quizzes-release.flag
// (tope de 20 min) antes del escenario del limitador y de la limpieza.
if (process.env.E2E_CONFIRM !== 'yes') {
  console.error('Estas pruebas escriben en la base de datos REAL (usuarios y cursos temporales con prefijo e2e-quiz-).\nSi quieres ejecutarlas: E2E_CONFIRM=yes npm run test:quizzes:e2e');
  process.exit(2);
}

const HOLD = process.argv.includes('--hold');
const API_PORT = Number(process.env.E2E_API_PORT ?? 3100);
if ([3000, 5173].includes(API_PORT)) {
  console.error('Los puertos 3000 y 5173 están reservados al backend y al frontend de desarrollo.');
  process.exit(2);
}
const API = `http://127.0.0.1:${API_PORT}`;
const PASSWORD = 'E2e-Quiz-2026!';
const TAG = Date.now().toString(36);
const PREFIX = 'e2e-quiz-';
const EMAIL_LIKE = `${PREFIX}%@streamly.test`;
const SLUG_LIKE = `${PREFIX}%`;
const REAL_COURSE_ID = 83;
const EXPLAIN = 'EXPLICACION-SECRETA-E2E';
const TMP = tmpdir();
const FIXTURES_FILE = path.join(TMP, 'quizzes-fixtures.json');
const FLAG_FILE = path.join(TMP, 'quizzes-release.flag');
const BACK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let backend = null;
let backendLog = '';
let passwordHash = null;
const results = [];
const fx = {};

const sql = async (statement, params = []) => (await pool.query(statement, params))[0];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function http(method, route, token, body) {
  const response = await fetch(`${API}${route}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = Buffer.from(await response.arrayBuffer()).toString('utf8');
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, body: json, text, headers: response.headers };
}

// ---------- utilidades de pruebas ----------
async function scenario(id, title, run) {
  const lines = [];
  const check = (condition, message) => {
    if (!condition) throw new Error(`FALLÓ: ${message}`);
    lines.push(message);
  };
  const equal = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected), `${message} (esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)})`);
  const status = (response, expected, message) => check(response.status === expected, `${message} -> ${expected} (obtenido ${response.status}: ${String(response.text).slice(0, 160)})`);
  const code = (response, expectedStatus, expectedCode, message) => check(response.status === expectedStatus && response.body?.code === expectedCode, `${message} -> ${expectedStatus} ${expectedCode} (obtenido ${response.status} ${response.body?.code}: ${String(response.text).slice(0, 160)})`);
  try {
    await run({ check, equal, status, code });
    results.push({ id, title, pass: true });
    console.log(`PASS  ${id}  ${title}  (${lines.length} verificaciones)`);
    for (const line of lines) console.log(`        ok  ${line}`);
  } catch (error) {
    results.push({ id, title, pass: false, error: error.message });
    console.log(`FAIL  ${id}  ${title}\n        ${error.message}`);
    for (const line of lines.slice(-3)) console.log(`        ok  ${line}`);
  }
}

// ---------- datos ----------
const tokens = {};
const tokenOf = (user) => createAccessToken({ id: user.id, role: user.role });

async function createUser(role, label, fullName) {
  const email = `${PREFIX}${TAG}-${label}@streamly.test`;
  const result = await sql('INSERT INTO users (full_name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, 1)', [fullName, email, passwordHash, role]);
  const user = { id: Number(result.insertId), email, role, fullName };
  user.token = tokenOf(user);
  return user;
}

async function newStudent(label, courses, { expiresAt = null } = {}) {
  const user = await createUser('student', label, `E2E Alumno ${label}`);
  for (const course of courses) {
    await sql('INSERT INTO enrollments (user_id, course_id, enrolled_by_id, expires_at) VALUES (?, ?, ?, ?)', [user.id, course.id, user.id, expiresAt]);
  }
  return user;
}

let courseCounter = 0;
// sections: número de videos por sección. Devuelve ids de secciones, videos y materiales.
async function makeCourse({ label, sections = [2], status = 'published', template = null, ownerId = fx.owner.id, price = 0 }) {
  courseCounter += 1;
  const slug = `${PREFIX}${TAG}-${label}`;
  const result = await sql(
    `INSERT INTO courses (owner_id, slug, title, subtitle, description, category, level, price_cents, access_days, thumbnail_url, certificate_template, status, published_at)
     VALUES (?, ?, ?, 'Subtítulo de prueba', 'Descripción de prueba del curso temporal.', 'Pruebas', 'beginner', ?, NULL, NULL, ?, ?, ${status === 'published' ? 'CURRENT_TIMESTAMP' : 'NULL'})`,
    [ownerId, slug, `E2E Quiz ${label}`, price, template, status],
  );
  const course = { id: Number(result.insertId), slug, sections: [], videos: [] };
  let position = 0;
  for (const [sectionIndex, videoCount] of sections.entries()) {
    const section = await sql('INSERT INTO course_sections (course_id, title, description, position) VALUES (?, ?, ?, ?)', [course.id, `Módulo ${sectionIndex + 1}`, `Descripción ${sectionIndex + 1}`, sectionIndex + 1]);
    const entry = { id: Number(section.insertId), videos: [] };
    for (let index = 0; index < videoCount; index += 1) {
      position += 1;
      const lesson = await sql(
        "INSERT INTO lessons (course_id, section_id, title, description, video_url, duration_seconds, position) VALUES (?, ?, ?, 'Clase de prueba', ?, 600, ?)",
        [course.id, entry.id, `Video ${position}`, `https://res.cloudinary.com/e2e-quiz/video/upload/v1/e2e-quiz-${courseCounter}-${position}.mp4`, position],
      );
      const lessonId = Number(lesson.insertId);
      const material = await sql("INSERT INTO lesson_materials (lesson_id, type, title, description, url) VALUES (?, 'link', ?, '', 'https://example.com/e2e-quiz-recurso')", [lessonId, `Recurso ${position}`]);
      const video = { id: lessonId, sectionId: entry.id, materialId: Number(material.insertId) };
      entry.videos.push(video);
      course.videos.push(video);
    }
    course.sections.push(entry);
  }
  const doc = await sql("INSERT INTO course_materials (course_id, type, title, description, url) VALUES (?, 'link', 'Documento del curso', '', 'https://example.com/e2e-quiz-documento')", [course.id]);
  course.docId = Number(doc.insertId);
  return course;
}

// ---------- constructores de preguntas ----------
const options = (texts, correct) => texts.map((text, index) => ({ text, isCorrect: correct.includes(index) }));
const single = (prompt, correct = 0) => ({ type: 'single', prompt, explanation: EXPLAIN, points: 1, options: options(['Opción A', 'Opción B', 'Opción C'], [correct]) });
const multiple = (prompt, correct = [0, 2]) => ({ type: 'multiple', prompt, explanation: EXPLAIN, points: 1, options: options(['Opción A', 'Opción B', 'Opción C', 'Opción D'], correct) });
const trueFalse = (prompt, correct = true) => ({ type: 'true_false', prompt, explanation: EXPLAIN, correct });
const twoSingles = () => [single('Pregunta uno', 0), single('Pregunta dos', 1)];

// Crea la evaluación por API y le agrega preguntas. Devuelve {id, questions (con isCorrect)}.
async function makeQuiz(course, { section = 0, index, title = 'Evaluación E2E', isRequired = false, maxAttempts = null, showAnswers = 'after_submit', passingPercent = 70, questions = twoSingles() } = {}) {
  const body = { sectionId: course.sections[section].id, title, isRequired, maxAttempts, showAnswers, passingPercent, ...(index === undefined ? {} : { index }) };
  const created = await http('POST', `/api/admin/courses/${course.id}/quizzes`, fx.owner.token, body);
  if (created.status !== 201) throw new Error(`No se pudo crear la evaluación (${created.status}): ${created.text}`);
  const id = created.body.quiz.id;
  for (const question of questions) {
    const added = await http('POST', `/api/admin/courses/${course.id}/quizzes/${id}/questions`, fx.owner.token, question);
    if (added.status !== 201) throw new Error(`No se pudo crear la pregunta (${added.status}): ${added.text}`);
  }
  return { id, questions: await adminQuestions(course, id) };
}

async function adminQuestions(course, quizId) {
  const detail = await http('GET', `/api/admin/courses/${course.id}/quizzes/${quizId}`, fx.owner.token);
  return detail.body.quiz.questions;
}

// mode: 'correct' (todo bien), 'wrong' (todo mal), 'half' (solo la primera bien).
function answersFor(questions, mode) {
  const answers = {};
  for (const [index, question] of questions.entries()) {
    const correct = question.options.filter((option) => option.isCorrect).map((option) => option.id);
    const wrong = question.options.filter((option) => !option.isCorrect).map((option) => option.id).slice(0, 1);
    answers[question.id] = mode === 'correct' || (mode === 'half' && index === 0) ? correct : wrong;
  }
  return answers;
}

const attempt = (course, quizId, user, answers, extra = {}) => http('POST', `/api/courses/${course.id}/quizzes/${quizId}/attempts`, user.token, { answers, ...extra });
const learn = (course, user) => http('GET', `/api/courses/${course.id}/learn`, user.token);
const itemOf = (response, id) => response.body.lessons.find((lesson) => lesson.id === id);
const setProgress = (user, lessonId, completed = true) => http('PUT', `/api/courses/lessons/${lessonId}/progress`, user.token, { completed, lastPositionSeconds: 30 });
const patchQuiz = (course, quizId, body) => http('PATCH', `/api/admin/courses/${course.id}/quizzes/${quizId}`, fx.owner.token, body);
const editor = (course) => http('GET', `/api/admin/courses/${course.id}/editor`, fx.owner.token);

async function cleanup() {
  const users = (await sql('SELECT id FROM users WHERE email LIKE ?', [EMAIL_LIKE])).map((row) => Number(row.id));
  const courses = (await sql('SELECT id FROM courses WHERE slug LIKE ?', [SLUG_LIKE])).map((row) => Number(row.id));
  if (courses.length) {
    await sql('DELETE FROM quiz_attempts WHERE quiz_id IN (SELECT id FROM lessons WHERE course_id IN (?))', [courses]);
    await sql('DELETE FROM certificates WHERE course_id IN (?)', [courses]);
    await sql('DELETE FROM payments WHERE course_id IN (?)', [courses]);
    await sql('DELETE FROM enrollments WHERE course_id IN (?)', [courses]);
    await sql('DELETE FROM lesson_progress WHERE lesson_id IN (SELECT id FROM lessons WHERE course_id IN (?))', [courses]);
    await sql('DELETE FROM lessons WHERE course_id IN (?)', [courses]);
    await sql('DELETE FROM course_materials WHERE course_id IN (?)', [courses]);
    await sql('DELETE FROM course_sections WHERE course_id IN (?)', [courses]);
    await sql('DELETE FROM courses WHERE id IN (?)', [courses]);
  }
  if (users.length) {
    await sql('DELETE FROM quiz_attempts WHERE user_id IN (?)', [users]);
    await sql('DELETE FROM certificates WHERE user_id IN (?)', [users]);
    await sql('DELETE FROM payments WHERE user_id IN (?)', [users]);
    await sql('DELETE FROM lesson_progress WHERE user_id IN (?)', [users]);
    await sql('DELETE FROM enrollments WHERE user_id IN (?)', [users]);
    await sql('DELETE FROM users WHERE id IN (?)', [users]);
  }
  return { users: users.length, courses: courses.length };
}

async function remainingRows() {
  const [row] = await sql('SELECT (SELECT COUNT(*) FROM users WHERE email LIKE ?) AS users, (SELECT COUNT(*) FROM courses WHERE slug LIKE ?) AS courses', [EMAIL_LIKE, SLUG_LIKE]);
  return Number(row.users) + Number(row.courses);
}

async function snapshot() {
  const [totals] = await sql(
    `SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM courses) AS courses, (SELECT COUNT(*) FROM lessons) AS lessons,
            (SELECT COUNT(*) FROM course_sections) AS sections, (SELECT COUNT(*) FROM enrollments) AS enrollments,
            (SELECT COUNT(*) FROM lesson_progress) AS lesson_progress, (SELECT COUNT(*) FROM lesson_materials) AS lesson_materials,
            (SELECT COUNT(*) FROM course_materials) AS course_materials, (SELECT COUNT(*) FROM payments) AS payments,
            (SELECT COUNT(*) FROM certificates) AS certificates, (SELECT COUNT(*) FROM quizzes) AS quizzes,
            (SELECT COUNT(*) FROM quiz_questions) AS quiz_questions, (SELECT COUNT(*) FROM quiz_options) AS quiz_options,
            (SELECT COUNT(*) FROM quiz_attempts) AS quiz_attempts`,
  );
  const [real] = await sql(
    `SELECT (SELECT COUNT(*) FROM lessons WHERE course_id = ?) AS lessons, (SELECT COUNT(*) FROM course_sections WHERE course_id = ?) AS sections,
            (SELECT COUNT(*) FROM enrollments WHERE course_id = ?) AS enrollments, (SELECT COUNT(*) FROM certificates WHERE course_id = ?) AS certificates`,
    [REAL_COURSE_ID, REAL_COURSE_ID, REAL_COURSE_ID, REAL_COURSE_ID],
  );
  return { totals, course83: real };
}

// ---------- backend hijo ----------
async function startBackend() {
  backend = spawn(process.execPath, ['src/server.js'], {
    cwd: BACK_ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(API_PORT) },
  });
  backend.stdout.on('data', (chunk) => { backendLog += chunk; });
  backend.stderr.on('data', (chunk) => { backendLog += chunk; });
  for (let tries = 0; tries < 40; tries += 1) {
    if (backend.exitCode !== null) throw new Error(`El backend temporal terminó al arrancar:\n${backendLog.slice(-1500)}`);
    try {
      const response = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
    } catch {
      // Aún no escucha.
    }
    await wait(500);
  }
  throw new Error('El backend temporal no respondió a tiempo.');
}

async function stopBackend() {
  if (!backend || backend.exitCode !== null) return;
  const exited = new Promise((resolve) => backend.once('exit', resolve));
  backend.kill();
  await Promise.race([exited, wait(5000)]);
  if (backend.exitCode === null) backend.kill('SIGKILL');
}

// ---------- escenarios ----------
async function createFixtures() {
  fx.owner = await createUser('admin', 'owner', 'E2E Docente Dueño');
  fx.other = await createUser('admin', 'otro', 'E2E Docente Ajeno');
  fx.superAdmin = await createUser('super_admin', 'super', 'E2E Super Admin');
  fx.outsider = await newStudent('sin-inscripcion', []);
}

async function runScenarios() {
  const { owner, other, superAdmin } = fx;

  // ---- C1: orden mixto ----
  const c1 = await makeCourse({ label: 'orden', sections: [2, 2] });
  let c1Quizzes;
  await scenario('S01', 'crear evaluaciones en posiciones concretas: orden mixto, positions únicas y lessonNumber saltando quizzes', async (t) => {
    const qa = await http('POST', `/api/admin/courses/${c1.id}/quizzes`, owner.token, { sectionId: c1.sections[0].id, index: 0, title: 'Diagnóstica inicial', label: 'diagnostica' });
    t.status(qa, 201, 'crear evaluación al inicio de la sección 1');
    t.equal(qa.body.quiz.sectionId, c1.sections[0].id, 'sectionId de la evaluación');
    t.equal([qa.body.quiz.questionCount, qa.body.quiz.isRequired, qa.body.quiz.passingPercent, qa.body.quiz.label], [0, false, 70, 'diagnostica'], 'valores por defecto');
    const qb = await http('POST', `/api/admin/courses/${c1.id}/quizzes`, owner.token, { sectionId: c1.sections[0].id, index: 2, title: 'Repaso entre V1 y V2', label: 'repaso' });
    t.status(qb, 201, 'crear evaluación entre el video 1 y el 2');
    const qc = await http('POST', `/api/admin/courses/${c1.id}/quizzes`, owner.token, { sectionId: c1.sections[1].id, title: 'Examen final', label: 'final' });
    t.status(qc, 201, 'crear evaluación al final de la sección 2');
    c1Quizzes = [qa.body.quiz.id, qb.body.quiz.id, qc.body.quiz.id];
    const view = await editor(c1);
    t.status(view, 200, 'GET editor');
    const [s1, s2] = view.body.sections;
    t.equal(s1.lessons.map((lesson) => lesson.kind), ['quiz', 'video', 'quiz', 'video'], 'sección 1: quiz, video, quiz, video');
    t.equal(s2.lessons.map((lesson) => lesson.kind), ['video', 'video', 'quiz'], 'sección 2: video, video, quiz');
    t.equal(s1.lessons.map((lesson) => lesson.id), [c1Quizzes[0], c1.videos[0].id, c1Quizzes[1], c1.videos[1].id], 'ids de la sección 1 en el orden pedido');
    t.equal([...s1.lessons, ...s2.lessons].map((lesson) => lesson.lessonNumber), [null, 1, null, 2, 3, 4, null], 'lessonNumber salta las evaluaciones');
    const positions = [...s1.lessons, ...s2.lessons].map((lesson) => lesson.position);
    t.equal(positions, [1, 2, 3, 4, 5, 6, 7], 'positions globales únicas y contiguas');
    const quiz = s1.lessons[0];
    t.equal([quiz.videoUrl, quiz.materials, quiz.quiz.questionCount, quiz.quiz.label, quiz.quiz.showAnswers], [null, [], 0, 'diagnostica', 'after_submit'], 'campos de la evaluación en el editor');
    t.check(s1.lessons[1].videoUrl && s1.lessons[1].materials.length === 1, 'el video conserva videoUrl y materiales');
    const patch = await http('PATCH', `/api/admin/sections/${c1.sections[0].id}/lessons/${c1Quizzes[0]}`, owner.token, { title: 'Intento de editar como clase' });
    t.status(patch, 400, 'PATCH de clase sobre una evaluación');
    const material = await http('POST', `/api/admin/sections/${c1.sections[0].id}/lessons/${c1Quizzes[0]}/materials`, owner.token, { type: 'link', title: 'Material', url: 'https://example.com/x' });
    t.status(material, 404, 'material de clase sobre una evaluación');
    const control = await http('POST', `/api/admin/sections/${c1.sections[0].id}/lessons/${c1.videos[0].id}/materials`, owner.token, { type: 'link', title: 'Material extra', url: 'https://example.com/y' });
    t.status(control, 201, 'material de clase sobre un video sigue funcionando');
    const reorder = await http('PUT', `/api/admin/courses/${c1.id}/lessons/order`, owner.token, {
      sections: [
        { id: c1.sections[0].id, lessonIds: [c1.videos[0].id, c1.videos[1].id] },
        { id: c1.sections[1].id, lessonIds: [c1Quizzes[0], c1.videos[2].id, c1.videos[3].id, c1Quizzes[1], c1Quizzes[2]] },
      ],
    });
    t.status(reorder, 200, 'PUT lessons/order moviendo evaluaciones entre secciones');
    const numbers = reorder.body.sections.flatMap((section) => section.lessons.map((lesson) => lesson.lessonNumber));
    t.equal(numbers, [1, 2, null, 3, 4, null, null], 'la respuesta del reordenamiento numera sin contar evaluaciones');
  });

  // ---- S02: validaciones ----
  await scenario('S02', 'validaciones 400 de cada regla de ajustes y preguntas', async (t) => {
    const lessonsBefore = Number((await sql('SELECT COUNT(*) AS n FROM lessons WHERE course_id = ?', [c1.id]))[0].n);
    const create = (body) => http('POST', `/api/admin/courses/${c1.id}/quizzes`, owner.token, { sectionId: c1.sections[0].id, title: 'Válida', ...body });
    t.status(await create({ title: '' }), 400, 'título vacío');
    t.status(await create({ title: 'x'.repeat(181) }), 400, 'título de 181 caracteres');
    t.status(await create({ passingPercent: 0 }), 400, 'passingPercent 0');
    t.status(await create({ passingPercent: 101 }), 400, 'passingPercent 101');
    t.status(await create({ maxAttempts: 0 }), 400, 'maxAttempts 0');
    t.status(await create({ maxAttempts: 100 }), 400, 'maxAttempts 100');
    t.status(await create({ isRequired: 'si' }), 400, 'isRequired no booleano');
    t.status(await create({ showAnswers: 'siempre' }), 400, 'showAnswers desconocido');
    t.status(await create({ label: 'otra' }), 400, 'label desconocido');
    const foreign = await http('POST', `/api/admin/courses/${c1.id}/quizzes`, owner.token, { sectionId: 999999999, title: 'Sección ajena' });
    t.status(foreign, 404, 'sección inexistente');
    const lessonsAfter = Number((await sql('SELECT COUNT(*) AS n FROM lessons WHERE course_id = ?', [c1.id]))[0].n);
    t.equal(lessonsAfter, lessonsBefore, 'ninguna petición inválida creó una fila');

    const quizId = c1Quizzes[0];
    const add = (body) => http('POST', `/api/admin/courses/${c1.id}/quizzes/${quizId}/questions`, owner.token, body);
    t.status(await add({ ...single('Sin enunciado'), prompt: '' }), 400, 'enunciado vacío');
    t.status(await add({ ...single('Puntos altos'), points: 11 }), 400, 'puntos 11');
    t.status(await add({ ...single('Una opción'), options: options(['Solo una'], [0]) }), 400, 'una sola opción');
    t.status(await add({ ...single('Nueve opciones'), options: options(Array.from({ length: 9 }, (_, i) => `Op ${i}`), [0]) }), 400, 'nueve opciones');
    t.status(await add({ ...single('Dos correctas'), options: options(['A', 'B', 'C'], [0, 1]) }), 400, 'single con 2 correctas');
    t.status(await add({ ...single('Cero correctas'), options: options(['A', 'B', 'C'], []) }), 400, 'single sin correcta');
    t.status(await add({ ...multiple('Sin correctas'), options: options(['A', 'B', 'C'], []) }), 400, 'multiple con 0 correctas');
    t.status(await add({ ...single('Repetidas'), options: options(['A', 'a', 'C'], [0]) }), 400, 'opciones repetidas');
    t.status(await add({ type: 'true_false', prompt: 'Sin respuesta' }), 400, 'true_false sin correct ni opciones');
    t.status(await add({ type: 'true_false', prompt: 'Mal formado', correct: 'si' }), 400, 'true_false con correct no booleano');
    t.status(await add({ type: 'true_false', prompt: 'Tres opciones', options: options(['Verdadero', 'Falso', 'Quizá'], [0]) }), 400, 'true_false con 3 opciones');
    t.status(await add({ type: 'abierta', prompt: 'Tipo raro', options: options(['A', 'B'], [0]) }), 400, 'tipo de pregunta desconocido');
    t.equal((await adminQuestions(c1, quizId)).length, 0, 'ninguna pregunta inválida se guardó');
    const okSingle = await add(single('Single válida'));
    const okMultiple = await add(multiple('Multiple válida'));
    const okTf = await add(trueFalse('Verdadero o falso', false));
    t.equal([okSingle.status, okMultiple.status, okTf.status], [201, 201, 201], 'single, multiple y true_false válidas -> 201');
    t.equal(okTf.body.question.options.map((option) => option.text), ['Verdadero', 'Falso'], 'true_false reconstruida por el servidor');
    t.equal(okTf.body.question.options.map((option) => option.isCorrect), [false, true], 'true_false con correct:false marca "Falso"');
    // Límite superior: 100 preguntas por evaluación (se llena por SQL y se prueba la 101 por API).
    const full = await http('POST', `/api/admin/courses/${c1.id}/quizzes`, owner.token, { sectionId: c1.sections[1].id, title: 'Llena' });
    for (let index = 0; index < 100; index += 1) await sql("INSERT INTO quiz_questions (quiz_id, position, type, prompt, points) VALUES (?, ?, 'single', ?, 1)", [full.body.quiz.id, index + 1, `P${index}`]);
    const over = await http('POST', `/api/admin/courses/${c1.id}/quizzes/${full.body.quiz.id}/questions`, owner.token, single('Pregunta 101'));
    t.status(over, 409, 'la pregunta 101 se rechaza');
    const del = await http('DELETE', `/api/admin/courses/${c1.id}/quizzes/${full.body.quiz.id}`, owner.token);
    t.equal(del.body?.deleted?.questions, 100, 'borrar la evaluación llena reporta 100 preguntas');
  });

  // ---- C3: curso principal con evaluación obligatoria ----
  const c3 = await makeCourse({ label: 'bloqueo', sections: [2, 2], template: 'mujer-legaltech' });
  const qr = await makeQuiz(c3, { section: 0, index: 1, title: 'Evaluación obligatoria', isRequired: true, maxAttempts: 2, label: 'diagnostica' });
  fx.A = await newStudent('a', [c3]);
  fx.B = await newStudent('b', [c3]);
  fx.c3 = c3;
  fx.qr = qr;
  const [v1, v2, v3, v4] = c3.videos;

  await scenario('S03', 'alumno A: V1 libre, V2+ bloqueados (sin videoUrl ni materiales), 403 QUIZ_REQUIRED, documento del curso abierto', async (t) => {
    const view = await learn(c3, fx.A);
    t.status(view, 200, 'GET learn');
    t.equal(view.body.lessons.map((lesson) => lesson.id), [v1.id, qr.id, v2.id, v3.id, v4.id], 'orden mixto en learn');
    t.equal(view.body.lessons.map((lesson) => lesson.kind), ['video', 'quiz', 'video', 'video', 'video'], 'kind de cada ítem');
    t.equal(view.body.lessons.map((lesson) => lesson.lessonNumber), [1, null, 2, 3, 4], 'lessonNumber solo para videos');
    t.equal(view.body.lessons.map((lesson) => lesson.locked), [false, false, true, true, true], 'V1 y la evaluación libres; el resto bloqueado');
    t.check(itemOf(view, v1.id).videoUrl && itemOf(view, v1.id).materials.length === 1, 'V1 conserva videoUrl y materiales');
    for (const video of [v2, v3, v4]) {
      const item = itemOf(view, video.id);
      t.equal([item.videoUrl, item.materials, item.lastPositionSeconds, item.lockedBy], [null, [], 0, { quizId: qr.id, title: 'Evaluación obligatoria' }], `video ${video.id} bloqueado sin videoUrl ni materiales`);
    }
    t.equal(view.body.lessons.map((lesson) => lesson.counts), [true, true, true, true, true], 'counts: videos y obligatoria efectiva');
    const quizItem = itemOf(view, qr.id);
    t.equal([quizItem.videoUrl, quizItem.materials, quizItem.quiz.questionCount, quizItem.quiz.attemptsUsed, quizItem.quiz.attemptsLeft, quizItem.quiz.bestScorePercent, quizItem.quiz.passed, quizItem.quiz.isRequired, quizItem.quiz.passingPercent, quizItem.quiz.maxAttempts], [null, [], 2, 0, 2, null, false, true, 70, 2], 'resumen de la evaluación en learn');
    t.equal(view.body.progress, { completed: 0, total: 5, percent: 0, pendingRequired: [{ id: qr.id, title: 'Evaluación obligatoria' }] }, 'progress inicial');
    t.status(await setProgress(fx.A, v1.id), 200, 'PUT progress en V1');
    t.code(await setProgress(fx.A, v2.id), 403, 'QUIZ_REQUIRED', 'PUT progress en V2 bloqueado');
    t.code(await http('POST', `/api/courses/${c3.id}/lessons/${v2.id}/materials/${v2.materialId}/access`, fx.A.token), 403, 'QUIZ_REQUIRED', 'material de clase bloqueada');
    const open = await http('POST', `/api/courses/${c3.id}/lessons/${v1.id}/materials/${v1.materialId}/access`, fx.A.token);
    t.check(open.status === 200 && open.body.access.url === 'https://example.com/e2e-quiz-recurso', 'material de V1 se abre');
    t.status(await http('POST', `/api/courses/${c3.id}/materials/${c3.docId}/access`, fx.A.token), 200, 'documento del curso NO se bloquea');
    t.code(await setProgress(fx.A, qr.id), 400, 'QUIZ_PROGRESS_FORBIDDEN', 'PUT progress sobre la evaluación');
    const after = await learn(c3, fx.A);
    t.equal([itemOf(after, v1.id).completedAt !== null, itemOf(after, v1.id).lastPositionSeconds, after.body.progress.completed, after.body.progress.percent], [true, 30, 1, 20], 'V1 completado: 1/5 = 20 %');
    t.status(await http('GET', '/api/courses/me/enrollments', fx.A.token), 200, 'me/enrollments responde');
    const enrollments = await http('GET', '/api/courses/me/enrollments', fx.A.token);
    const mine = enrollments.body.courses.find((course) => course.id === c3.id);
    t.equal([mine.lessonCount, mine.completedLessons], [5, 1], 'me/enrollments usa el total contado (videos + obligatoria)');
  });

  await scenario('S04', 'GET de la evaluación como alumno no contiene respuestas correctas ni explicaciones', async (t) => {
    const quiz = await http('GET', `/api/courses/${c3.id}/quizzes/${qr.id}`, fx.A.token);
    t.status(quiz, 200, 'GET quiz del alumno');
    t.check(!/is_?correct/i.test(quiz.text), 'sin is_correct/isCorrect en el JSON serializado');
    t.check(!/explanation/i.test(quiz.text) && !quiz.text.includes(EXPLAIN), 'sin explanation ni su texto');
    t.equal([quiz.body.quiz.questions.length, quiz.body.quiz.totalPoints, quiz.body.quiz.isRequired], [2, 2, true], 'preguntas y puntos');
    t.equal(Object.keys(quiz.body.quiz.questions[0].options[0]).sort(), ['id', 'position', 'text'], 'cada opción solo trae id, position y text');
    const view = await learn(c3, fx.A);
    t.check(!/is_?correct/i.test(view.text) && !/explanation/i.test(view.text) && !view.text.includes(EXPLAIN), 'learn tampoco filtra respuestas');
    t.check(!Object.hasOwn(itemOf(view, qr.id), 'questions'), 'learn no incluye preguntas');
  });

  // ---- S05: show_answers ----
  const c5 = await makeCourse({ label: 'mostrar', sections: [1] });
  const qs = await makeQuiz(c5, { section: 0, title: 'Mostrar respuestas', maxAttempts: 5, showAnswers: 'never', questions: [single('Single', 0), multiple('Multiple', [0, 2])] });
  fx.D = await newStudent('d', [c5]);
  await scenario('S05', 'intento reprobado: passed false, unlocked false, attemptsLeft y correctOptionIds según show_answers', async (t) => {
    const correctIds = (questions) => questions.map((question) => question.options.filter((option) => option.isCorrect).map((option) => option.id));
    const never = await attempt(c5, qs.id, fx.D, answersFor(qs.questions, 'wrong'));
    t.status(never, 201, 'intento 1 (never)');
    t.equal([never.body.attemptNo, never.body.passed, never.body.unlocked, never.body.attemptsLeft, never.body.scorePercent, never.body.correctCount, never.body.totalCount], [1, false, false, 4, 0, 0, 2], 'resultado reprobado');
    t.check(never.body.results.every((result) => result.isCorrect === false && !Object.hasOwn(result, 'correctOptionIds') && !Object.hasOwn(result, 'explanation')), 'never: solo isCorrect por pregunta');
    t.check(!never.text.includes(EXPLAIN), 'never: la explicación no viaja');
    t.status(await patchQuiz(c5, qs.id, { showAnswers: 'after_submit' }), 200, 'PATCH showAnswers after_submit');
    const submit = await attempt(c5, qs.id, fx.D, answersFor(qs.questions, 'half'));
    t.equal([submit.body.attemptNo, submit.body.scorePercent, submit.body.passed, submit.body.attemptsLeft, submit.body.correctCount], [2, 50, false, 3, 1], 'intento 2 con la mitad bien = 50 %');
    t.equal(submit.body.results.map((result) => result.correctOptionIds), correctIds(qs.questions), 'after_submit: correctOptionIds de cada pregunta');
    t.check(submit.body.results.every((result) => result.explanation === EXPLAIN), 'after_submit: explicación presente');
    t.equal(submit.body.results.map((result) => result.isCorrect), [true, false], 'isCorrect por pregunta');
    t.status(await patchQuiz(c5, qs.id, { showAnswers: 'after_pass' }), 200, 'PATCH showAnswers after_pass');
    const failed = await attempt(c5, qs.id, fx.D, answersFor(qs.questions, 'wrong'));
    t.check(failed.body.results.every((result) => !Object.hasOwn(result, 'correctOptionIds') && !Object.hasOwn(result, 'explanation')), 'after_pass reprobado: sin respuestas');
    t.equal(failed.body.attemptsLeft, 2, 'attemptsLeft tras el intento 3');
    const passed = await attempt(c5, qs.id, fx.D, answersFor(qs.questions, 'correct'));
    t.equal([passed.body.passed, passed.body.unlocked, passed.body.scorePercent, passed.body.attemptsLeft, passed.body.attemptNo], [true, true, 100, 1, 4], 'after_pass aprobado');
    t.equal(passed.body.results.map((result) => result.correctOptionIds), correctIds(qs.questions), 'after_pass aprobado: se revelan las correctas');
    const mine = await http('GET', `/api/courses/${c5.id}/quizzes/${qs.id}/attempts/mine`, fx.D.token);
    t.status(mine, 200, 'attempts/mine');
    t.equal([mine.body.attemptsUsed, mine.body.attemptsLeft, mine.body.bestScorePercent, mine.body.passed, mine.body.attempts.length], [4, 1, 100, true, 4], 'historial del alumno');
    t.check(!/answers|correctOptionIds|is_?correct/i.test(mine.text), 'el historial no incluye respuestas');
  });

  await scenario('S06', 'max_attempts agotado: 403 ATTEMPTS_EXHAUSTED y el bloqueo persiste', async (t) => {
    const first = await attempt(c3, qr.id, fx.A, answersFor(qr.questions, 'wrong'));
    t.status(first, 201, 'intento 1');
    t.equal([first.body.passed, first.body.unlocked, first.body.attemptsLeft, first.body.scorePercent], [false, false, 1, 0], 'reprobado, quedan 1');
    const second = await attempt(c3, qr.id, fx.A, answersFor(qr.questions, 'half'));
    t.equal([second.body.attemptNo, second.body.scorePercent, second.body.attemptsLeft], [2, 50, 0], 'intento 2 al 50 %, quedan 0');
    t.code(await attempt(c3, qr.id, fx.A, answersFor(qr.questions, 'correct')), 403, 'ATTEMPTS_EXHAUSTED', 'intento 3');
    const view = await learn(c3, fx.A);
    t.equal([itemOf(view, v2.id).locked, itemOf(view, qr.id).quiz.attemptsLeft, itemOf(view, qr.id).quiz.attemptsUsed, itemOf(view, qr.id).quiz.bestScorePercent], [true, 0, 2, 50], 'V2 sigue bloqueado y el resumen refleja los intentos');
    const rows = await sql('SELECT COUNT(*) AS n FROM lesson_progress WHERE user_id = ? AND lesson_id = ? AND completed_at IS NOT NULL', [fx.A.id, qr.id]);
    t.equal(Number(rows[0].n), 0, 'reprobar no escribe lesson_progress de la evaluación');
  });

  await scenario('S07', 'aprobado: unlocked, lesson_progress escrito, V2 desbloqueado, progress correcto y 409 QUIZ_ALREADY_PASSED', async (t) => {
    t.status(await setProgress(fx.B, v1.id), 200, 'B completa V1');
    const pass = await attempt(c3, qr.id, fx.B, answersFor(qr.questions, 'correct'));
    t.status(pass, 201, 'intento aprobado');
    t.equal([pass.body.passed, pass.body.unlocked, pass.body.scorePercent, pass.body.attemptNo, pass.body.attemptsLeft, pass.body.passingPercent], [true, true, 100, 1, 1, 70], 'resultado aprobado');
    const rows = await sql('SELECT completed_at FROM lesson_progress WHERE user_id = ? AND lesson_id = ?', [fx.B.id, qr.id]);
    t.check(rows.length === 1 && rows[0].completed_at !== null, 'lesson_progress de la evaluación con completed_at');
    const view = await learn(c3, fx.B);
    t.equal(view.body.lessons.map((lesson) => lesson.locked), [false, false, false, false, false], 'nada bloqueado tras aprobar');
    t.check(itemOf(view, v2.id).videoUrl && itemOf(view, v2.id).materials.length === 1, 'V2 recupera videoUrl y materiales');
    t.equal(view.body.progress, { completed: 2, total: 5, percent: 40, pendingRequired: [] }, 'progress 2/5 = 40 %');
    t.equal([itemOf(view, qr.id).quiz.passed, itemOf(view, qr.id).quiz.bestScorePercent, itemOf(view, qr.id).completedAt !== null], [true, 100, true], 'la evaluación aparece aprobada');
    t.code(await attempt(c3, qr.id, fx.B, answersFor(qr.questions, 'correct')), 409, 'QUIZ_ALREADY_PASSED', 'otro intento tras aprobar');
    t.status(await setProgress(fx.B, v2.id), 200, 'PUT progress en V2 ya permitido');
  });

  // ---- S08: concurrencia ----
  const c8 = await makeCourse({ label: 'concurrencia', sections: [1] });
  const qc1 = await makeQuiz(c8, { title: 'Un solo intento', maxAttempts: 1 });
  const qc2 = await makeQuiz(c8, { title: 'Ilimitada', maxAttempts: null });
  fx.E1 = await newStudent('e1', [c8]);
  fx.E2 = await newStudent('e2', [c8]);
  await scenario('S08', '5 envíos simultáneos: exactamente un 201 y attempt_no únicos', async (t) => {
    const wrongRuns = await Promise.all(Array.from({ length: 5 }, () => attempt(c8, qc1.id, fx.E1, answersFor(qc1.questions, 'wrong'))));
    t.equal(wrongRuns.filter((run) => run.status === 201).length, 1, 'max_attempts 1 con reprobado: un solo 201');
    t.check(wrongRuns.filter((run) => run.status !== 201).every((run) => run.status === 403 && run.body.code === 'ATTEMPTS_EXHAUSTED'), 'el resto: 403 ATTEMPTS_EXHAUSTED');
    const rows = await sql('SELECT attempt_no FROM quiz_attempts WHERE quiz_id = ? AND user_id = ?', [qc1.id, fx.E1.id]);
    t.equal(rows.map((row) => Number(row.attempt_no)), [1], 'una sola fila con attempt_no 1');
    const passRuns = await Promise.all(Array.from({ length: 5 }, () => attempt(c8, qc2.id, fx.E2, answersFor(qc2.questions, 'correct'))));
    t.equal(passRuns.filter((run) => run.status === 201).length, 1, 'sin límite pero aprobando: un solo 201');
    t.check(passRuns.filter((run) => run.status !== 201).every((run) => run.status === 409 && run.body.code === 'QUIZ_ALREADY_PASSED'), 'el resto: 409 QUIZ_ALREADY_PASSED');
    const passed = await sql('SELECT attempt_no, passed FROM quiz_attempts WHERE quiz_id = ? AND user_id = ?', [qc2.id, fx.E2.id]);
    t.equal([passed.length, Number(passed[0].attempt_no), Number(passed[0].passed)], [1, 1, 1], 'una sola aprobación guardada');
  });

  // ---- C9: opcional que no bloquea ni cuenta; cambio de obligatoriedad y reordenamiento ----
  const c9 = await makeCourse({ label: 'opcional', sections: [2, 1] });
  const qo = await makeQuiz(c9, { section: 0, index: 1, title: 'Práctica opcional', isRequired: false, maxAttempts: null });
  fx.F = await newStudent('f', [c9]);
  fx.G = await newStudent('g', [c9]);
  const [w1, w2, w3] = c9.videos;
  await scenario('S09', 'evaluación opcional reprobada: no bloquea ni cuenta en progress, overview ni estudiantes', async (t) => {
    const first = await learn(c9, fx.F);
    t.equal(first.body.lessons.map((lesson) => lesson.locked), [false, false, false, false], 'sin bloqueos');
    t.equal([itemOf(first, qo.id).counts, itemOf(first, qo.id).quiz.isRequired], [false, false], 'la opcional no cuenta');
    t.equal(first.body.progress, { completed: 0, total: 3, percent: 0, pendingRequired: [] }, 'total = solo videos');
    const failed = await attempt(c9, qo.id, fx.F, answersFor(qo.questions, 'wrong'));
    t.equal([failed.status, failed.body.passed], [201, false], 'reprobar la opcional');
    t.status(await setProgress(fx.F, w2.id), 200, 'V2 se puede completar sin aprobar la opcional');
    t.status(await setProgress(fx.F, w1.id), 200, 'V1 completado');
    const mid = await learn(c9, fx.F);
    t.equal(mid.body.progress, { completed: 2, total: 3, percent: 67, pendingRequired: [] }, 'progress 2/3');
    const overview = await http('GET', '/api/account/overview', fx.F.token);
    const row = overview.body.enrollments.find((item) => item.course.id === c9.id);
    t.equal([row.lessonCount, row.completedLessons, row.progressPercent], [3, 2, 67], 'overview cuenta solo videos');
    t.equal([row.nextLesson.id, row.nextLesson.lessonNumber, row.nextLesson.kind, row.nextLesson.title], [w3.id, 3, 'video', 'Video 3'], 'nextLesson es el siguiente video');
    t.status(await setProgress(fx.F, w3.id), 200, 'V3 completado');
    const students = await http('GET', `/api/admin/courses/${c9.id}/students`, owner.token);
    t.status(students, 200, 'GET estudiantes');
    const student = students.body.students.find((item) => item.id === fx.F.id);
    t.equal([students.body.course.lessonCount, student.lessonCount, student.completedLessons, student.progressPercent], [3, 3, 3, 100], 'estudiantes del docente cuentan solo videos');
    const pass = await attempt(c9, qo.id, fx.F, answersFor(qo.questions, 'correct'));
    t.equal([pass.status, pass.body.passed], [201, true], 'aprobar la opcional');
    const done = await http('GET', '/api/account/overview', fx.F.token);
    const doneRow = done.body.enrollments.find((item) => item.course.id === c9.id);
    t.equal([doneRow.lessonCount, doneRow.completedLessons, doneRow.progressPercent, doneRow.nextLesson], [3, 3, 100, null], 'aprobar una opcional no altera los totales');
    const mine = await http('GET', '/api/courses/me/enrollments', fx.F.token);
    const mineRow = mine.body.courses.find((course) => course.id === c9.id);
    t.equal([mineRow.lessonCount, mineRow.completedLessons], [3, 3], 'me/enrollments tampoco la cuenta');
    const detail = await http('GET', `/api/admin/courses/${c9.id}/students/${fx.F.id}/progress`, owner.token);
    t.status(detail, 200, 'detalle por alumno');
    const quizRow = detail.body.lessons.find((lesson) => lesson.id === qo.id);
    t.equal([quizRow.kind, quizRow.lessonNumber, quizRow.quiz.attempts, quizRow.quiz.passed, quizRow.quiz.bestScorePercent, quizRow.quiz.isRequired], ['quiz', null, 2, true, 100, false], 'detalle incluye la evaluación con sus intentos');
    t.check(quizRow.quiz.lastAttemptAt, 'lastAttemptAt presente');
    t.equal(detail.body.lessons.filter((lesson) => lesson.kind === 'video').map((lesson) => lesson.lessonNumber), [1, 2, 3], 'videos numerados 1..3');
  });

  await scenario('S10', 'cambiar isRequired y reordenar con PUT lessons/order cambia el bloqueo en el siguiente /learn', async (t) => {
    const before = await learn(c9, fx.G);
    t.equal(before.body.lessons.map((lesson) => lesson.locked), [false, false, false, false], 'opcional: sin bloqueos');
    t.status(await patchQuiz(c9, qo.id, { isRequired: true }), 200, 'PATCH isRequired true');
    const required = await learn(c9, fx.G);
    t.equal(required.body.lessons.map((lesson) => lesson.id), [w1.id, qo.id, w2.id, w3.id], 'orden V1, evaluación, V2, V3');
    t.equal(required.body.lessons.map((lesson) => lesson.locked), [false, false, true, true], 'obligatoria: V2 y V3 bloqueados al instante');
    t.equal(required.body.progress.total, 4, 'el total pasa a 4');
    t.code(await setProgress(fx.G, w2.id), 403, 'QUIZ_REQUIRED', 'progress en V2 ahora bloqueado');
    t.status(await patchQuiz(c9, qo.id, { isRequired: false }), 200, 'PATCH isRequired false');
    const optional = await learn(c9, fx.G);
    t.equal([optional.body.lessons.some((lesson) => lesson.locked), optional.body.progress.total], [false, 3], 'vuelve a no bloquear');
    t.status(await patchQuiz(c9, qo.id, { isRequired: true }), 200, 'PATCH isRequired true otra vez');
    const reorder = await http('PUT', `/api/admin/courses/${c9.id}/lessons/order`, owner.token, {
      sections: [{ id: c9.sections[0].id, lessonIds: [w1.id, w2.id] }, { id: c9.sections[1].id, lessonIds: [qo.id, w3.id] }],
    });
    t.status(reorder, 200, 'mover la evaluación a la sección 2');
    t.equal(reorder.body.sections.flatMap((section) => section.lessons.map((lesson) => lesson.lessonNumber)), [1, 2, null, 3], 'lessonNumber tras mover');
    const moved = await learn(c9, fx.G);
    t.equal(moved.body.lessons.map((lesson) => lesson.id), [w1.id, w2.id, qo.id, w3.id], 'nuevo orden en learn');
    t.equal(moved.body.lessons.map((lesson) => lesson.locked), [false, false, false, true], 'el bloqueo sigue el nuevo orden: solo V3');
    t.status(await setProgress(fx.G, w2.id), 200, 'V2 ya no está bloqueado');
    t.equal([moved.body.progress.total, moved.body.progress.pendingRequired.length], [4, 1], 'progress con 1 obligatoria pendiente');
  });

  // ---- S11: constancia ----
  const c11 = await makeCourse({ label: 'constancia', sections: [2], template: 'mujer-legaltech' });
  const qf = await makeQuiz(c11, { title: 'Examen final', isRequired: true, passingPercent: 100, questions: [trueFalse('El cielo es azul', true)] });
  fx.H = await newStudent('h', [c11]);
  await scenario('S11', 'constancia: pendingRequiredQuizzes hasta aprobar todo y completar videos', async (t) => {
    const first = await http('GET', `/api/courses/${c11.id}/certificate`, fx.H.token);
    t.status(first, 200, 'GET certificate');
    t.equal([first.body.available, first.body.eligible, first.body.enrolled, first.body.totalLessons, first.body.completedLessons], [true, false, true, 3, 0], 'inicial: 0 de 3');
    t.equal(first.body.pendingRequiredQuizzes, [{ id: qf.id, title: 'Examen final' }], 'pendingRequiredQuizzes lista la evaluación');
    for (const video of c11.videos) t.status(await setProgress(fx.H, video.id), 200, `completar video ${video.id}`);
    const videos = await http('GET', `/api/courses/${c11.id}/certificate`, fx.H.token);
    t.equal([videos.body.eligible, videos.body.completedLessons, videos.body.totalLessons], [false, 2, 3], 'solo videos: no elegible');
    t.equal(videos.body.pendingRequiredQuizzes.length, 1, 'sigue pendiente');
    const denied = await http('POST', `/api/courses/${c11.id}/certificate`, fx.H.token, {});
    t.status(denied, 403, 'POST certificate sin aprobar');
    t.check(String(denied.body.message).includes('aprobar las evaluaciones obligatorias'), 'el mensaje menciona aprobar las evaluaciones obligatorias');
    const pass = await attempt(c11, qf.id, fx.H, answersFor(qf.questions, 'correct'));
    t.equal([pass.status, pass.body.passed], [201, true], 'aprobar la evaluación (100 % requerido)');
    const done = await http('GET', `/api/courses/${c11.id}/certificate`, fx.H.token);
    t.equal([done.body.eligible, done.body.completedLessons, done.body.totalLessons, done.body.pendingRequiredQuizzes], [true, 3, 3, []], 'elegible con todo completado');
  });

  // ---- S12: exenciones ----
  await scenario('S12', 'dueño y super_admin ven todo sin bloqueo; preview:true no guarda intentos', async (t) => {
    for (const [name, user] of [['dueño', owner], ['super_admin', superAdmin]]) {
      const view = await learn(c3, user);
      t.status(view, 200, `${name}: GET learn`);
      t.equal(view.body.lessons.map((lesson) => lesson.locked), [false, false, false, false, false], `${name}: sin bloqueos`);
      t.check(view.body.lessons.filter((lesson) => lesson.kind === 'video').every((lesson) => lesson.videoUrl), `${name}: ve todos los videoUrl`);
    }
    t.status(await setProgress(owner, v2.id), 200, 'dueño: progress en V2 sin aprobar');
    t.status(await http('POST', `/api/courses/${c3.id}/lessons/${v3.id}/materials/${v3.materialId}/access`, superAdmin.token), 200, 'super_admin: material de clase posterior');
    const before = Number((await sql('SELECT COUNT(*) AS n FROM quiz_attempts WHERE quiz_id = ? AND user_id IN (?, ?)', [qr.id, owner.id, superAdmin.id]))[0].n);
    const preview = await attempt(c3, qr.id, owner, answersFor(qr.questions, 'correct'), { preview: true });
    t.status(preview, 200, 'preview del dueño');
    t.equal([preview.body.preview, preview.body.attemptNo, preview.body.attemptsLeft, preview.body.passed], [true, null, null, true], 'forma de la vista previa');
    const failedPreview = await attempt(c3, qr.id, superAdmin, answersFor(qr.questions, 'wrong'), { preview: true });
    t.equal([failedPreview.status, failedPreview.body.passed], [200, false], 'preview reprobado del super_admin');
    const after = Number((await sql('SELECT COUNT(*) AS n FROM quiz_attempts WHERE quiz_id = ? AND user_id IN (?, ?)', [qr.id, owner.id, superAdmin.id]))[0].n);
    t.equal([before, after], [0, 0], 'la vista previa no guarda intentos');
    const progressRows = await sql('SELECT COUNT(*) AS n FROM lesson_progress WHERE user_id = ? AND lesson_id = ?', [owner.id, qr.id]);
    t.equal(Number(progressRows[0].n), 0, 'la vista previa no marca la evaluación como completada');
    t.status(await attempt(c3, qr.id, fx.A, answersFor(qr.questions, 'correct'), { preview: true }), 403, 'un alumno no puede usar preview');
    t.status(await attempt(c3, qr.id, owner, answersFor(qr.questions, 'correct'), { preview: 'yes' }), 400, 'preview no booleano');
  });

  // ---- S13: permisos ----
  await scenario('S13', 'permisos: alumno, admin ajeno, sin inscripción, inscripción vencida y sesión', async (t) => {
    const base = `/api/admin/courses/${c3.id}/quizzes`;
    for (const [name, user] of [['alumno', fx.A], ['admin ajeno', other]]) {
      t.status(await http('POST', base, user.token, { sectionId: c3.sections[0].id, title: 'Intruso' }), 403, `${name}: crear evaluación`);
      t.status(await http('GET', `${base}/${qr.id}`, user.token), 403, `${name}: leer evaluación`);
      t.status(await http('PATCH', `${base}/${qr.id}`, user.token, { title: 'Hackeado' }), 403, `${name}: editar evaluación`);
      t.status(await http('DELETE', `${base}/${qr.id}`, user.token), 403, `${name}: borrar evaluación`);
      t.status(await http('POST', `${base}/${qr.id}/questions`, user.token, single('Intrusa')), 403, `${name}: agregar pregunta`);
      t.status(await http('GET', `${base}/${qr.id}/results`, user.token), 403, `${name}: ver resultados`);
    }
    t.status(await http('GET', `/api/admin/courses/${c3.id}/editor`, fx.A.token), 403, 'alumno: editor');
    t.status(await http('GET', `${base}/${qr.id}`, null), 401, 'sin sesión: 401');
    t.status(await http('GET', `/api/courses/${c3.id}/quizzes/${qr.id}`, null), 401, 'sin sesión en la ruta del alumno: 401');
    const intact = await http('GET', `${base}/${qr.id}`, owner.token);
    t.equal([intact.status, intact.body.quiz.title, intact.body.quiz.questions.length], [200, 'Evaluación obligatoria', 2], 'la evaluación quedó intacta');
    t.status(await http('GET', `/api/admin/courses/${c1.id}/quizzes/${qr.id}`, owner.token), 404, 'evaluación de otro curso -> 404');
    const out = fx.outsider;
    t.status(await http('GET', `/api/courses/${c3.id}/quizzes/${qr.id}`, out.token), 403, 'sin inscripción: ver evaluación');
    t.status(await attempt(c3, qr.id, out, answersFor(qr.questions, 'correct')), 403, 'sin inscripción: enviar intento');
    t.status(await http('GET', `/api/courses/${c3.id}/quizzes/${qr.id}/attempts/mine`, out.token), 403, 'sin inscripción: historial');
    t.status(await learn(c3, out), 403, 'sin inscripción: learn');
    const expired = await newStudent('vencido', [c3], { expiresAt: '2020-01-01 00:00:00' });
    t.code(await http('GET', `/api/courses/${c3.id}/quizzes/${qr.id}`, expired.token), 403, 'ACCESS_EXPIRED', 'vencida: ver evaluación');
    t.code(await attempt(c3, qr.id, expired, answersFor(qr.questions, 'correct')), 403, 'ACCESS_EXPIRED', 'vencida: enviar intento');
    t.code(await learn(c3, expired), 403, 'ACCESS_EXPIRED', 'vencida: learn');
    t.code(await setProgress(expired, v1.id), 403, 'ACCESS_EXPIRED', 'vencida: progress');
    t.code(await http('POST', `/api/courses/${c3.id}/lessons/${v1.id}/materials/${v1.materialId}/access`, expired.token), 403, 'ACCESS_EXPIRED', 'vencida: material de clase');
    const none = await attempt(c3, qr.id, expired, answersFor(qr.questions, 'correct'));
    t.equal(none.status, 403, 'la inscripción vencida nunca guarda intentos');
    const saved = await sql('SELECT COUNT(*) AS n FROM quiz_attempts WHERE user_id = ?', [expired.id]);
    t.equal(Number(saved[0].n), 0, 'sin intentos guardados para la inscripción vencida');
  });

  // ---- S14: borrado ----
  const c14 = await makeCourse({ label: 'borrado', sections: [1, 1] });
  const z = await makeQuiz(c14, { section: 1, index: 0, title: 'Se borra con la sección' });
  const loose = await makeQuiz(c14, { section: 0, title: 'Suelta', questions: [single('Única')] });
  fx.J = await newStudent('j', [c14]);
  await scenario('S14', 'borrar evaluación suelta y sección con evaluación: cascada completa e /impact', async (t) => {
    t.status(await attempt(c14, z.id, fx.J, answersFor(z.questions, 'wrong')), 201, 'el alumno deja un intento en la evaluación de la sección 2');
    const unlockedLooseProgress = await sql("INSERT INTO lesson_progress (user_id, lesson_id, completed_at) VALUES (?, ?, CURRENT_TIMESTAMP)", [fx.J.id, loose.id]);
    t.check(unlockedLooseProgress.affectedRows === 1, 'progreso de la evaluación suelta sembrado');
    const delLoose = await http('DELETE', `/api/admin/courses/${c14.id}/quizzes/${loose.id}`, owner.token);
    t.equal([delLoose.status, delLoose.body.deleted], [200, { questions: 1, attempts: 0 }], 'DELETE de la evaluación suelta');
    t.status(await http('GET', `/api/admin/courses/${c14.id}/quizzes/${loose.id}`, owner.token), 404, 'la evaluación suelta ya no existe');
    t.equal(Number((await sql('SELECT COUNT(*) AS n FROM lesson_progress WHERE lesson_id = ?', [loose.id]))[0].n), 0, 'su progreso también se borró');
    const questionIds = (await sql('SELECT id FROM quiz_questions WHERE quiz_id = ?', [z.id])).map((row) => Number(row.id));
    t.equal(questionIds.length, 2, 'la evaluación tiene 2 preguntas antes de borrar');
    const impact = await http('GET', `/api/admin/courses/${c14.id}/sections/${c14.sections[1].id}/impact`, owner.token);
    t.status(impact, 200, 'GET impact');
    t.equal([impact.body.impact.lessons, impact.body.impact.quizzes, impact.body.impact.quizAttempts, impact.body.impact.lessonMaterials, impact.body.impact.remainingVideoLessons, impact.body.impact.blocked], [1, 1, 1, 1, 1, false], 'impact: videos, quizzes e intentos por separado');
    const deletedSection = await http('DELETE', `/api/admin/courses/${c14.id}/sections/${c14.sections[1].id}`, owner.token);
    t.status(deletedSection, 200, 'DELETE sección con evaluación');
    t.equal([deletedSection.body.deleted.lessons, deletedSection.body.deleted.quizzes, deletedSection.body.deleted.lessonMaterials], [1, 1, 1], 'deleted incluye quizzes');
    const gone = async (query, params) => Number((await sql(query, params))[0].n);
    t.equal(await gone('SELECT COUNT(*) AS n FROM lessons WHERE id = ?', [z.id]), 0, 'lessons sin la evaluación');
    t.equal(await gone('SELECT COUNT(*) AS n FROM quizzes WHERE lesson_id = ?', [z.id]), 0, 'quizzes sin la fila');
    t.equal(await gone('SELECT COUNT(*) AS n FROM quiz_questions WHERE quiz_id = ?', [z.id]), 0, 'sin preguntas');
    t.equal(await gone('SELECT COUNT(*) AS n FROM quiz_options WHERE question_id IN (?)', [questionIds]), 0, 'sin opciones');
    t.equal(await gone('SELECT COUNT(*) AS n FROM quiz_attempts WHERE quiz_id = ?', [z.id]), 0, 'sin intentos');
    const extra = await http('POST', `/api/admin/courses/${c14.id}/sections`, owner.token, { title: 'Solo evaluaciones' });
    t.status(extra, 201, 'crear sección vacía');
    const onlyQuiz = await http('POST', `/api/admin/courses/${c14.id}/quizzes`, owner.token, { sectionId: extra.body.section.id, title: 'Única de la sección' });
    t.status(onlyQuiz, 201, 'crear evaluación en la sección nueva');
    const onlyImpact = await http('GET', `/api/admin/courses/${c14.id}/sections/${extra.body.section.id}/impact`, owner.token);
    t.equal([onlyImpact.body.impact.lessons, onlyImpact.body.impact.quizzes, onlyImpact.body.impact.blocked], [0, 1, false], 'una sección solo de evaluaciones no cuenta como clases ni bloquea');
    const delOnly = await http('DELETE', `/api/admin/courses/${c14.id}/sections/${extra.body.section.id}`, owner.token);
    t.equal([delOnly.status, delOnly.body.deleted.quizzes, delOnly.body.deleted.lessons], [200, 1, 0], 'se puede borrar la sección de solo evaluaciones');
  });

  // ---- S15: publicar ----
  const c15 = await makeCourse({ label: 'publicar', sections: [1], status: 'draft' });
  fx.K = await newStudent('k', [c15]);
  await scenario('S15', 'publicar con evaluación sin preguntas -> 409 QUIZ_INCOMPLETE; vacía en curso publicado es invisible y no bloquea', async (t) => {
    const empty = await http('POST', `/api/admin/courses/${c15.id}/quizzes`, owner.token, { sectionId: c15.sections[0].id, title: 'Evaluación vacía' });
    t.status(empty, 201, 'crear evaluación vacía en borrador');
    const blocked = await http('POST', `/api/admin/courses/${c15.id}/publish`, owner.token);
    t.code(blocked, 409, 'QUIZ_INCOMPLETE', 'publicar con evaluación vacía');
    t.check(String(blocked.body.message).includes('Evaluación vacía') && String(blocked.body.message).includes('Agrega preguntas'), 'el mensaje nombra la evaluación');
    t.equal((await sql('SELECT status FROM courses WHERE id = ?', [c15.id]))[0].status, 'draft', 'el curso sigue en borrador');
    t.status(await http('POST', `/api/admin/courses/${c15.id}/quizzes/${empty.body.quiz.id}/questions`, owner.token, single('Ya tiene pregunta')), 201, 'agregar una pregunta');
    t.status(await http('POST', `/api/admin/courses/${c15.id}/publish`, owner.token), 200, 'publicar tras agregar la pregunta');
    t.equal((await sql('SELECT status FROM courses WHERE id = ?', [c15.id]))[0].status, 'published', 'curso publicado');
    const hidden = await http('POST', `/api/admin/courses/${c15.id}/quizzes`, owner.token, { sectionId: c15.sections[0].id, index: 0, title: 'Obligatoria vacía', isRequired: true });
    t.status(hidden, 201, 'crear obligatoria vacía en curso publicado');
    t.equal([hidden.body.quiz.isRequired, hidden.body.quiz.isEffectiveRequired], [true, false], 'obligatoria pero no efectiva');
    const view = await learn(c15, fx.K);
    t.check(!view.body.lessons.some((lesson) => lesson.id === hidden.body.quiz.id), 'el alumno no ve la evaluación vacía');
    t.equal([view.body.lessons.some((lesson) => lesson.locked), view.body.progress.total, view.body.progress.pendingRequired], [false, 1, []], 'no bloquea ni cuenta');
    t.status(await http('GET', `/api/courses/${c15.id}/quizzes/${hidden.body.quiz.id}`, fx.K.token), 404, 'el alumno recibe 404 al pedirla');
    t.status(await setProgress(fx.K, c15.videos[0].id), 200, 'el alumno avanza en el video');
    const ownerView = await learn(c15, owner);
    t.check(ownerView.body.lessons.some((lesson) => lesson.id === hidden.body.quiz.id), 'el dueño sí la ve');
    const noVideo = await makeCourse({ label: 'sin-video', sections: [0], status: 'draft' });
    await http('POST', `/api/admin/courses/${noVideo.id}/quizzes`, owner.token, { sectionId: noVideo.sections[0].id, title: 'Solo evaluación' });
    t.status(await http('POST', `/api/admin/courses/${noVideo.id}/publish`, owner.token), 400, 'una evaluación no sustituye al primer video');
  });

  // ---- S16: público y resultados ----
  await scenario('S16', 'detalle público con quizzes[] sin preguntas; resultados paginados del docente con summary', async (t) => {
    const empty = await http('POST', `/api/admin/courses/${c3.id}/quizzes`, owner.token, { sectionId: c3.sections[1].id, title: 'Vacía pública' });
    t.status(empty, 201, 'evaluación vacía en C3');
    const pub = await http('GET', `/api/courses/${c3.slug}`, null);
    t.status(pub, 200, 'GET público por slug');
    const course = pub.body.course;
    t.equal([course.lessonCount, course.lessons.length], [4, 4], 'lessons[] y lessonCount siguen siendo solo videos');
    t.equal(course.lessons.map((lesson) => lesson.lessonNumber), [1, 2, 3, 4], 'numeración pública sin evaluaciones');
    t.equal(course.quizzes.map((quiz) => quiz.id), [qr.id], 'quizzes[] solo con evaluaciones con preguntas');
    t.equal(Object.keys(course.quizzes[0]).sort(), ['id', 'isRequired', 'label', 'position', 'sectionId', 'title'], 'campos de quizzes[]');
    t.equal([course.quizzes[0].sectionId, course.quizzes[0].isRequired, course.quizzes[0].label], [c3.sections[0].id, true, 'otro'], 'datos de la evaluación pública');
    t.check(!/questions|options|is_?correct|explanation/i.test(pub.text) && !pub.text.includes(EXPLAIN), 'sin preguntas, opciones ni respuestas');
    const catalog = await http('GET', '/api/courses', null);
    t.equal(catalog.body.courses.find((item) => item.id === c3.id)?.lessonCount, 4, 'el catálogo cuenta solo videos');
    const page1 = await http('GET', `/api/admin/courses/${c3.id}/quizzes/${qr.id}/results?page=1&pageSize=2`, owner.token);
    t.status(page1, 200, 'GET results página 1');
    t.equal([page1.body.page, page1.body.pageSize, page1.body.attempts.length, page1.body.totalAttempts], [1, 2, 2, 3], 'página 1 de 2 filas, 3 intentos en total');
    t.equal(page1.body.summary.students, 2, 'summary.students');
    t.equal([page1.body.summary.attempts, page1.body.summary.passedStudents], [3, 1], 'summary.attempts y passedStudents');
    t.check(typeof page1.body.summary.averageScore === 'number' && Math.abs(page1.body.summary.averageScore - 50) < 0.01, 'summary.averageScore = (0 + 50 + 100) / 3 = 50');
    t.equal(Object.keys(page1.body.attempts[0]).sort(), ['attemptNo', 'email', 'fullName', 'passed', 'scorePercent', 'submittedAt', 'userId'], 'campos de cada intento');
    const page2 = await http('GET', `/api/admin/courses/${c3.id}/quizzes/${qr.id}/results?page=2&pageSize=2`, owner.token);
    t.equal(page2.body.attempts.length, 1, 'página 2 con la fila restante');
    t.status(await http('GET', `/api/admin/courses/${c3.id}/quizzes/${qr.id}/results?pageSize=51`, owner.token), 400, 'pageSize 51');
    t.status(await http('GET', `/api/admin/courses/${c3.id}/quizzes/${qr.id}/results?pageSize=0`, owner.token), 400, 'pageSize 0');
    t.status(await http('GET', `/api/admin/courses/${c3.id}/quizzes/${qr.id}/results?page=0`, owner.token), 400, 'page 0');
    const student = await http('GET', `/api/admin/courses/${c3.id}/students`, owner.token);
    const alumnoA = student.body.students.find((item) => item.id === fx.A.id);
    t.equal([student.body.course.lessonCount, alumnoA.lessonCount, alumnoA.completedLessons], [5, 5, 1], 'estudiantes del curso con obligatoria: total 5');
  });

  // ---- S17: curso sin evaluaciones ----
  const c17 = await makeCourse({ label: 'sin-quiz', sections: [2], template: 'mujer-legaltech' });
  fx.M = await newStudent('m', [c17]);
  await scenario('S17', 'curso sin evaluaciones: learn, overview, estudiantes y constancia con los totales de siempre', async (t) => {
    const view = await learn(c17, fx.M);
    t.equal(view.body.lessons.map((lesson) => lesson.kind), ['video', 'video'], 'solo videos');
    t.equal(view.body.lessons.map((lesson) => lesson.lessonNumber), [1, 2], 'lessonNumber 1..N');
    t.equal(view.body.lessons.map((lesson) => lesson.locked), [false, false], 'sin bloqueos');
    t.equal(view.body.progress, { completed: 0, total: 2, percent: 0, pendingRequired: [] }, 'progress total = videos');
    t.equal(view.body.course.lessonCount, 2, 'course.lessonCount = videos');
    t.status(await setProgress(fx.M, c17.videos[0].id), 200, 'completar V1');
    const overview = await http('GET', '/api/account/overview', fx.M.token);
    const row = overview.body.enrollments.find((item) => item.course.id === c17.id);
    t.equal([row.lessonCount, row.completedLessons, row.progressPercent, row.nextLesson.id, row.nextLesson.lessonNumber, row.nextLesson.kind], [2, 1, 50, c17.videos[1].id, 2, 'video'], 'overview y nextLesson');
    const students = await http('GET', `/api/admin/courses/${c17.id}/students`, owner.token);
    const student = students.body.students.find((item) => item.id === fx.M.id);
    t.equal([students.body.course.lessonCount, student.lessonCount, student.completedLessons, student.progressPercent], [2, 2, 1, 50], 'estudiantes del docente');
    const cert = await http('GET', `/api/courses/${c17.id}/certificate`, fx.M.token);
    t.equal([cert.body.eligible, cert.body.totalLessons, cert.body.completedLessons, cert.body.pendingRequiredQuizzes], [false, 2, 1, []], 'constancia a medias');
    t.status(await setProgress(fx.M, c17.videos[1].id), 200, 'completar V2');
    const done = await http('GET', `/api/courses/${c17.id}/certificate`, fx.M.token);
    t.equal([done.body.eligible, done.body.totalLessons, done.body.completedLessons], [true, 2, 2], 'elegible al completar los videos');
    const metrics = await http('GET', '/api/admin/courses', owner.token);
    const metric = Array.isArray(metrics.body?.courses) ? metrics.body.courses.find((item) => item.id === c17.id) : null;
    t.check(metric === null || metric === undefined || metric.lessonCount === 2, 'el listado del docente cuenta 2 clases');
    const detail = await http('GET', `/api/admin/courses/${c17.id}/students/${fx.M.id}/progress`, owner.token);
    t.equal(detail.body.lessons.map((lesson) => lesson.kind), ['video', 'video'], 'detalle por alumno: todo video');
  });

  if (HOLD) await holdForBrowser();
  await rateLimitScenario();
}

async function holdForBrowser() {
  const holdEmpty = await makeCourse({ label: 'navegador', sections: [2, 2] });
  const holdQuiz = await makeCourse({ label: 'navegador-quiz', sections: [2, 1] });
  const hq = await makeQuiz(holdQuiz, { section: 0, index: 1, title: 'Evaluación del navegador', isRequired: true, passingPercent: 70, questions: [single('¿Cuál es la correcta?', 0), multiple('Marca las correctas', [0, 2]), trueFalse('Esto es verdadero', true)] });
  const browser = await newStudent('navegador', [holdEmpty, holdQuiz]);
  const browserFresh = await newStudent('navegador-2', [holdQuiz]);
  writeFileSync(FIXTURES_FILE, JSON.stringify({
    tag: TAG, apiPort: API_PORT, password: PASSWORD, prefix: `${PREFIX}${TAG}`,
    owner: { id: fx.owner.id, email: fx.owner.email }, other: { id: fx.other.id, email: fx.other.email }, superAdmin: { id: fx.superAdmin.id, email: fx.superAdmin.email },
    student: { id: browser.id, email: browser.email }, studentFresh: { id: browserFresh.id, email: browserFresh.email },
    emptyCourse: { id: holdEmpty.id, slug: holdEmpty.slug, sections: holdEmpty.sections.map((section) => ({ id: section.id, videoIds: section.videos.map((video) => video.id) })) },
    quizCourse: { id: holdQuiz.id, slug: holdQuiz.slug, quizId: hq.id, sections: holdQuiz.sections.map((section) => ({ id: section.id, videoIds: section.videos.map((video) => video.id) })) },
    lockedCourse: { id: fx.c3.id, quizId: fx.qr.id, studentA: { id: fx.A.id, email: fx.A.email }, studentB: { id: fx.B.id, email: fx.B.email } },
  }, null, 2));
  console.log('\nREADY');
  await new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (existsSync(FLAG_FILE) || Date.now() - started > Number(process.env.E2E_HOLD_MIN ?? 20) * 60 * 1000) { clearInterval(timer); resolve(); }
    }, 1000);
  });
  console.log('Liberado: ejecutando el limitador y la limpieza.');
}

async function rateLimitScenario() {
  const c18 = await makeCourse({ label: 'limitador', sections: [1] });
  const q18 = await makeQuiz(c18, { title: 'Limitador', maxAttempts: null });
  const runner = await newStudent('limitador', [c18]);
  await scenario('S18', 'el limitador de intentos responde 429 al pasar de 10 por minuto', async (t) => {
    const statuses = [];
    let last = null;
    for (let index = 0; index < 11; index += 1) {
      last = await attempt(c18, q18.id, runner, answersFor(q18.questions, 'wrong'));
      statuses.push(last.status);
    }
    t.equal(statuses.slice(0, 10), Array(10).fill(201), 'los primeros 10 envíos se aceptan');
    t.equal(statuses[10], 429, 'el envío 11 recibe 429');
    t.equal(last.body.status, 'error', 'cuerpo JSON con status error');
    const stored = await sql('SELECT COUNT(*) AS n FROM quiz_attempts WHERE quiz_id = ? AND user_id = ?', [q18.id, runner.id]);
    t.equal(Number(stored[0].n), 10, 'el intento rechazado no se guardó');
  });
}

// ---------- principal ----------
const hardTimeout = setTimeout(() => {
  console.error('Tiempo máximo excedido (25 min).');
  backend?.kill();
  process.exit(1);
}, (Number(process.env.E2E_HOLD_MIN ?? 20) + 5) * 60 * 1000);
hardTimeout.unref();

let exitCode = 1;
let before = null;
let restored = false;
try {
  for (const file of [FLAG_FILE, FIXTURES_FILE]) if (existsSync(file)) unlinkSync(file);
  passwordHash = await bcrypt.hash(PASSWORD, 4);
  const stale = await cleanup();
  if (stale.users || stale.courses) console.log(`Se limpiaron restos de una ejecución anterior (${stale.users} usuarios, ${stale.courses} cursos).`);
  before = await snapshot();
  console.log(`SNAPSHOT ${JSON.stringify(before)}`);
  await createFixtures();
  await startBackend();
  console.log(`Backend temporal en :${API_PORT}, base real, datos ${PREFIX}${TAG}-*\n`);
  await runScenarios();
} catch (error) {
  console.error(`Error preparando o ejecutando las pruebas: ${error.stack ?? error.message}`);
  results.push({ id: 'SETUP', title: 'preparación', pass: false, error: error.message });
} finally {
  await stopBackend().catch(() => {});
  for (const file of [FLAG_FILE, FIXTURES_FILE]) { try { unlinkSync(file); } catch { /* ya no existe */ } }
  try {
    const removed = await cleanup();
    const left = await remainingRows();
    const after = await snapshot();
    restored = before === null || (JSON.stringify(before) === JSON.stringify(after) && left === 0);
    console.log(`\nLimpieza: ${removed.users} usuarios y ${removed.courses} cursos temporales eliminados; filas ${PREFIX} restantes: ${left}`);
    console.log(`SNAPSHOT_FINAL ${JSON.stringify(after)}`);
    console.log(`Conteos idénticos a los iniciales (incluido el curso ${REAL_COURSE_ID}): ${restored ? 'sí' : 'NO (revisar manualmente)'}`);
  } catch (error) {
    console.error(`La limpieza falló: ${error.message}`);
  }
  await pool.end().catch(() => {});
  const failed = results.filter((item) => !item.pass);
  console.log(`\nResultado: ${results.length - failed.length}/${results.length} escenarios en verde`);
  if (failed.length) {
    console.log(`Fallaron: ${failed.map((item) => item.id).join(', ')}`);
    if (backendLog) console.log(`\nÚltimas líneas del backend temporal:\n${backendLog.slice(-1200)}`);
  }
  exitCode = failed.length === 0 && restored && results.length > 0 ? 0 : 1;
}
process.exit(exitCode);
