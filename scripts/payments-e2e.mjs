import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import bcrypt from 'bcryptjs';

import { pool } from '../src/config/database.js';
import { createFakeMercadoPago } from './lib/fake-mercadopago.mjs';

// Pruebas de punta a punta del flujo de pagos. Levanta (1) un Mercado Pago FALSO en este mismo proceso y
// (2) un backend temporal que lo usa, y ejecuta escenarios con HTTP real contra la base de datos REAL.
// Crea usuarios/cursos temporales con prefijo "e2e-" y los borra al terminar. No toca Mercado Pago real.
//   E2E_CONFIRM=yes npm run test:payments:e2e
if (process.env.E2E_CONFIRM !== 'yes') {
  console.error('Estas pruebas escriben en la base de datos REAL (usuarios, cursos, pagos e inscripciones temporales con prefijo e2e-).\nSi quieres ejecutarlas: E2E_CONFIRM=yes npm run test:payments:e2e');
  process.exit(2);
}

const API_PORT = Number(process.env.E2E_API_PORT ?? 3100);
const FAKE_PORT = Number(process.env.E2E_FAKE_PORT ?? 3199);
if ([3000, 5173].includes(API_PORT) || [3000, 5173].includes(FAKE_PORT) || API_PORT === FAKE_PORT) {
  console.error('Los puertos 3000 y 5173 están reservados al backend y al frontend de desarrollo.');
  process.exit(2);
}
const API = `http://127.0.0.1:${API_PORT}`;
const FAKE_TOKEN = 'APP_USR-e2e-token-falso';
const WEBHOOK_SECRET = `e2e-secreto-${randomUUID()}`;
const APP_URL = 'https://academia.e2e.example.com';
const PUBLIC_API_URL = 'https://api.e2e.example.com';
const PASSWORD = 'E2e-Pass-2026!';
const TAG = Date.now().toString(36);
const BACK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REAL_PAID_COURSE_ID = 7; // fotografia-movil-demo
const REAL_OWNER_COURSE_ID = 3; // curso de pago de Juan (sin inscripción para alumnos nuevos)

const fake = createFakeMercadoPago({ port: FAKE_PORT, accessToken: FAKE_TOKEN });
let backend = null;
let backendLog = '';
let passwordHash = null;
const results = [];

// ---------- utilidades ----------
const sql = async (statement, params = []) => (await pool.query(statement, params))[0];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function http(method, route, { token, body, headers = {} } = {}) {
  const response = await fetch(`${API}${route}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, body: json };
}

function webhook(dataId, { sign = true, secret = WEBHOOK_SECRET, signedId = dataId, requestId = randomUUID(), ts = String(Date.now()), type = 'payment' } = {}) {
  const headers = { 'x-request-id': requestId };
  if (sign) {
    const manifest = `id:${String(signedId).toLowerCase()};request-id:${requestId};ts:${ts};`;
    headers['x-signature'] = `ts=${ts},v1=${createHmac('sha256', secret).update(manifest).digest('hex')}`;
  }
  return http('POST', `/api/payments/webhook?data.id=${dataId}&type=${type}`, { headers, body: { action: 'payment.updated', type, data: { id: String(dataId) } } });
}

async function createUser(role, label) {
  const email = `e2e-${TAG}-${label}@streamly.test`;
  const result = await sql('INSERT INTO users (full_name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, 1)', [`E2E ${label}`, email, passwordHash, role]);
  const login = await http('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  if (login.status !== 200 || !login.body?.accessToken) throw new Error(`No se pudo iniciar sesión con el usuario de prueba ${label} (${login.status})`);
  return { id: Number(result.insertId), email, token: login.body.accessToken, role };
}

async function createCourse({ ownerId, label, priceCents, accessDays, status = 'published' }) {
  const result = await sql(
    "INSERT INTO courses (owner_id, slug, title, subtitle, description, category, level, price_cents, access_days, status, published_at) VALUES (?, ?, ?, '', 'Curso temporal de pruebas e2e', 'Pruebas', 'beginner', ?, ?, ?, CURRENT_TIMESTAMP)",
    [ownerId, `e2e-${TAG}-${label}`, `E2E ${label}`, priceCents, accessDays, status],
  );
  return Number(result.insertId);
}

const enrollmentOf = async (userId, courseId) => (await sql(
  "SELECT id, enrolled_by_id, DATE_FORMAT(expires_at, '%Y-%m-%d %H:%i:%s') AS raw, TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), expires_at) AS secs FROM enrollments WHERE user_id = ? AND course_id = ?",
  [userId, courseId],
))[0] ?? null;
const enrollmentCount = async (userId, courseId) => Number((await sql('SELECT COUNT(*) AS n FROM enrollments WHERE user_id = ? AND course_id = ?', [userId, courseId]))[0].n);
const paymentOf = async (reference) => (await sql('SELECT * FROM payments WHERE external_reference = ?', [reference]))[0] ?? null;
// Estado comparable (sin el contador de segundos, que cambia solo).
const stableState = async (reference, userId) => {
  const enrollment = await enrollmentOf(userId, REAL_PAID_COURSE_ID);
  return JSON.stringify([await paymentOf(reference), enrollment && { id: enrollment.id, raw: enrollment.raw }]);
};
const addExpiredEnrollment = (userId, courseId) => sql('INSERT INTO enrollments (user_id, course_id, enrolled_by_id, expires_at) VALUES (?, ?, ?, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 DAY))', [userId, courseId, userId]);
const courseOf = async (courseId) => (await sql('SELECT id, price_cents, access_days FROM courses WHERE id = ?', [courseId]))[0];

const checkout = (user, courseId, body) => http('POST', `/api/payments/courses/${courseId}/checkout`, { token: user.token, body: body ?? {} });
const learn = (user, courseId) => http('GET', `/api/courses/${courseId}/learn`, { token: user.token });
const verify = (user, body) => http('POST', '/api/payments/verify', { token: user.token, body });

async function buy(user, courseId, { amount, currency = 'MXN', status = 'approved', metadata } = {}) {
  const course = await courseOf(courseId);
  const started = await checkout(user, courseId);
  if (started.status !== 201) throw new Error(`checkout inesperado ${started.status}`);
  const payment = fake.addPayment({
    reference: started.body.externalReference, amount: amount ?? Number(course.price_cents) / 100, currency, status, email: user.email,
    metadata: metadata ?? { user_id: user.id, course_id: Number(courseId) },
  });
  return { start: started.body, mp: payment, reference: started.body.externalReference };
}

function approxSeconds(actual, days, tolerance = 300) {
  return Math.abs(Number(actual) - days * 86400) <= tolerance;
}

// ---------- marco de escenarios ----------
function makeChecker() {
  const lines = [];
  const check = (condition, message) => {
    if (!condition) throw new Error(`FALLÓ: ${message}`);
    lines.push(message);
  };
  const equal = (actual, expected, message) => check(actual === expected, `${message} (esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)})`);
  return { check, equal, lines };
}

async function scenario(id, title, run) {
  const t = makeChecker();
  try {
    await run(t);
    results.push({ id, title, pass: true, checks: t.lines.length });
    console.log(`PASS  ${id}  ${title}  (${t.lines.length} verificaciones)`);
    for (const line of t.lines) console.log(`        ok  ${line}`);
  } catch (error) {
    results.push({ id, title, pass: false, error: error.message });
    console.log(`FAIL  ${id}  ${title}\n        ${error.message}`);
    for (const line of t.lines.slice(-3)) console.log(`        ok  ${line}`);
  }
}

// ---------- ciclo de vida ----------
async function waitForBackend() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
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

async function startBackend() {
  backend = spawn(process.execPath, ['src/server.js'], {
    cwd: BACK_ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(API_PORT),
      NODE_ENV: 'test',
      MERCADOPAGO_ACCESS_TOKEN: FAKE_TOKEN,
      MERCADOPAGO_PUBLIC_KEY: '',
      MERCADOPAGO_API_BASE_URL: `http://127.0.0.1:${FAKE_PORT}`,
      MERCADOPAGO_WEBHOOK_SECRET: WEBHOOK_SECRET,
      PUBLIC_API_URL,
      APP_URL,
      CORS_ORIGIN: APP_URL,
      TRUST_PROXY: '',
    },
  });
  backend.stdout.on('data', (chunk) => { backendLog += chunk; });
  backend.stderr.on('data', (chunk) => { backendLog += chunk; });
  await waitForBackend();
}

async function stopBackend() {
  if (!backend || backend.exitCode !== null) return;
  const exited = new Promise((resolve) => backend.once('exit', resolve));
  backend.kill();
  await Promise.race([exited, wait(5000)]);
  if (backend.exitCode === null) backend.kill('SIGKILL');
}

async function cleanup() {
  const users = (await sql("SELECT id FROM users WHERE email LIKE 'e2e-%@streamly.test'")).map((row) => Number(row.id));
  const courses = (await sql("SELECT id FROM courses WHERE slug LIKE 'e2e-%'")).map((row) => Number(row.id));
  if (users.length) await sql('DELETE FROM payments WHERE user_id IN (?)', [users]);
  if (courses.length) await sql('DELETE FROM payments WHERE course_id IN (?)', [courses]);
  if (users.length) {
    await sql('DELETE FROM enrollments WHERE user_id IN (?)', [users]);
    await sql('DELETE FROM lesson_progress WHERE user_id IN (?)', [users]);
  }
  if (courses.length) {
    await sql('DELETE FROM enrollments WHERE course_id IN (?)', [courses]);
    await sql('DELETE FROM courses WHERE id IN (?)', [courses]);
  }
  if (users.length) await sql('DELETE FROM users WHERE id IN (?)', [users]);
  return { users: users.length, courses: courses.length };
}

async function snapshot() {
  const [counts] = await sql('SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM courses) AS courses, (SELECT COUNT(*) FROM enrollments) AS enrollments, (SELECT COUNT(*) FROM payments) AS payments');
  const courses = await sql('SELECT id, price_cents, access_days, status FROM courses WHERE id IN (?, ?) ORDER BY id', [REAL_PAID_COURSE_ID, REAL_OWNER_COURSE_ID]);
  const enrollments = await sql("SELECT id, DATE_FORMAT(expires_at, '%Y-%m-%d %H:%i:%s') AS raw FROM enrollments WHERE user_id NOT IN (SELECT id FROM users WHERE email LIKE 'e2e-%@streamly.test') ORDER BY id");
  return JSON.stringify({ counts, courses, enrollments });
}

// ---------- escenarios ----------
async function runScenarios() {
  const owner = await createUser('admin', 'docente');
  const otherAdmin = await createUser('admin', 'docente-ajeno');
  const superAdmin = await createUser('super_admin', 'super');
  const paidCourse = await createCourse({ ownerId: owner.id, label: 'pago30', priceCents: 5000, accessDays: 30 });
  const lifetimeCourse = await createCourse({ ownerId: owner.id, label: 'indefinido', priceCents: 5000, accessDays: null });
  const freeCourse = await createCourse({ ownerId: owner.id, label: 'gratis', priceCents: 0, accessDays: 30 });
  const draftCourse = await createCourse({ ownerId: owner.id, label: 'borrador', priceCents: 5000, accessDays: 30, status: 'draft' });
  const real = await courseOf(REAL_PAID_COURSE_ID);
  const realDays = Number(real.access_days);
  const ctx = {};

  await scenario('B1', 'checkout de alumna con acceso vencido: pending + preferencia con monto del servidor', async (t) => {
    t.equal(Number(real.price_cents), 19900, 'el curso 7 cuesta 19900 centésimas (199.00 MXN)');
    const student = await createUser('student', 'alumna-vencida');
    await addExpiredEnrollment(student.id, REAL_PAID_COURSE_ID);
    const before = await learn(student, REAL_PAID_COURSE_ID);
    t.equal(before.status, 403, 'antes de pagar /learn responde 403');
    t.equal(before.body?.code, 'ACCESS_EXPIRED', 'con código ACCESS_EXPIRED');

    const hits = fake.preferences.length;
    const started = await checkout(student, REAL_PAID_COURSE_ID, { amount: 1, priceCents: 1, unit_price: 1, price: 1, currency: 'USD', currency_id: 'USD' });
    t.equal(started.status, 201, 'checkout responde 201');
    t.equal(started.body.amount, 199, 'amount de la respuesta = 199 (ignora el monto del cliente)');
    t.equal(started.body.currency, 'MXN', 'moneda MXN');
    t.check(UUID.test(started.body.externalReference), 'external_reference es un UUID');
    t.check(String(started.body.initPoint).startsWith('https://www.mercadopago.com.mx/'), 'initPoint https de mercadopago.com.mx');
    t.equal(fake.preferences.length, hits + 1, 'se creó exactamente una preferencia');
    const preference = fake.preferences.at(-1);
    const item = preference.body.items[0];
    t.equal(item.unit_price, 199, 'unit_price de la preferencia = 199');
    t.equal(item.currency_id, 'MXN', 'currency_id de la preferencia = MXN');
    t.equal(item.quantity, 1, 'quantity = 1');
    t.equal(preference.body.external_reference, started.body.externalReference, 'la preferencia lleva el mismo external_reference');
    t.equal(preference.idempotencyKey, started.body.externalReference, 'X-Idempotency-Key = external_reference');
    t.equal(preference.body.back_urls.success, `${APP_URL}/pago/resultado`, 'back_urls.success apunta al frontend');
    t.equal(preference.body.back_urls.failure, `${APP_URL}/pago/resultado`, 'back_urls.failure');
    t.equal(preference.body.back_urls.pending, `${APP_URL}/pago/resultado`, 'back_urls.pending');
    t.equal(preference.body.auto_return, 'approved', 'auto_return=approved con back_urls https públicas');
    t.equal(preference.body.notification_url, `${PUBLIC_API_URL}/api/payments/webhook`, 'notification_url = PUBLIC_API_URL/api/payments/webhook');
    t.equal(preference.body.metadata.user_id, student.id, 'metadata.user_id');
    t.equal(preference.body.metadata.course_id, REAL_PAID_COURSE_ID, 'metadata.course_id');
    t.equal(preference.body.payer.email, student.email, 'payer.email');
    t.equal(preference.body.payment_methods, undefined, 'no restringe medios de pago ni cuotas (MSI según la cuenta)');
    const row = await paymentOf(started.body.externalReference);
    t.equal(row.status, 'pending', 'registro payments en pending');
    t.equal(Number(row.amount_cents), 19900, 'amount_cents = 19900 desde la BD');
    t.equal(Number(row.amount), 199, 'amount = 199.00');
    t.equal(row.currency, 'MXN', 'currency MXN');
    t.equal(row.preference_id, preference.id, 'preference_id guardado');
    t.check(Boolean(row.checkout_url), 'checkout_url guardado');
    const again = await checkout(student, REAL_PAID_COURSE_ID);
    t.equal(again.body.paymentId, started.body.paymentId, 'un segundo clic reutiliza el pago pendiente');
    t.equal(fake.preferences.length, hits + 1, 'sin preferencia adicional por el reintento');
    ctx.student = student;
    ctx.reference = started.body.externalReference;
  });

  await scenario('B2', 'webhook firmado aprobado: renueva 90 días y reabre el curso', async (t) => {
    const { student, reference } = ctx;
    t.check(Boolean(student && reference), 'B1 dejó el contexto');
    const mp = fake.addPayment({ reference, amount: 199, status: 'approved', email: student.email, metadata: { user_id: student.id, course_id: REAL_PAID_COURSE_ID } });
    ctx.mp = mp;
    const response = await webhook(mp.id);
    t.equal(response.status, 200, 'webhook firmado responde 200');
    const row = await paymentOf(reference);
    t.equal(row.status, 'approved', 'payments.status = approved');
    t.equal(String(row.mp_payment_id), String(mp.id), 'mp_payment_id guardado');
    t.check(row.approved_at !== null, 'approved_at establecido');
    t.check(row.enrollment_id !== null, 'enrollment_id enlazado');
    t.equal(Number(row.needs_review), 0, 'sin marca de revisión');
    const enrollment = await enrollmentOf(student.id, REAL_PAID_COURSE_ID);
    t.equal(await enrollmentCount(student.id, REAL_PAID_COURSE_ID), 1, 'una sola inscripción (renovada, no duplicada)');
    t.check(approxSeconds(enrollment.secs, realDays), `expires_at = ahora + ${realDays} días (UTC)`);
    ctx.expiresRaw = enrollment.raw;
    const after = await learn(student, REAL_PAID_COURSE_ID);
    t.equal(after.status, 200, 'GET /learn ahora responde 200');
    const mine = await http('GET', '/api/payments/mine', { token: student.token });
    t.check(mine.body.payments.some((item) => item.externalReference === reference && item.status === 'approved' && item.accessGranted === true), '/api/payments/mine refleja aprobado con acceso');
  });

  await scenario('B3', 'idempotencia: 3 reenvíos secuenciales y 5 en paralelo', async (t) => {
    const { student, reference, mp, expiresRaw } = ctx;
    t.check(Boolean(mp && expiresRaw), 'B2 dejó el contexto');
    for (let index = 0; index < 3; index += 1) {
      const response = await webhook(mp.id);
      t.equal(response.status, 200, `reenvío secuencial ${index + 1} responde 200`);
    }
    const parallel = await Promise.all(Array.from({ length: 5 }, () => webhook(mp.id)));
    t.check(parallel.every((item) => item.status === 200), '5 webhooks en paralelo responden 200');
    const viaVerify = await verify(student, { externalReference: reference, paymentId: String(mp.id) });
    t.equal(viaVerify.status, 200, 'verify posterior responde 200');
    t.equal(viaVerify.body.accessGranted, true, 'verify informa acceso concedido');
    t.equal(await enrollmentCount(student.id, REAL_PAID_COURSE_ID), 1, 'sigue habiendo UNA inscripción');
    const enrollment = await enrollmentOf(student.id, REAL_PAID_COURSE_ID);
    t.equal(enrollment.raw, expiresRaw, 'expires_at no se extendió');
    const approved = await sql("SELECT COUNT(*) AS n FROM payments WHERE user_id = ? AND course_id = ? AND status = 'approved'", [student.id, REAL_PAID_COURSE_ID]);
    t.equal(Number(approved[0].n), 1, 'un solo pago approved');
    t.equal(Number((await paymentOf(reference)).needs_review), 0, 'sin marca de revisión por repetición');
  });

  await scenario('B4', 'firma inválida / sin firma / id manipulado / pago inexistente', async (t) => {
    const student = await createUser('student', 'alumna-firmas');
    await addExpiredEnrollment(student.id, REAL_PAID_COURSE_ID);
    const { mp, reference } = await buy(student, REAL_PAID_COURSE_ID);
    const snapshotBefore = await stableState(reference, student.id);
    const fetchesBefore = fake.hits.payment;
    const wrongSecret = await webhook(mp.id, { secret: 'otro-secreto' });
    t.equal(wrongSecret.status, 401, 'firma con secreto incorrecto -> 401');
    const unsigned = await webhook(mp.id, { sign: false });
    t.equal(unsigned.status, 401, 'sin x-signature -> 401');
    const tampered = await webhook(mp.id, { signedId: String(mp.id + 1) });
    t.equal(tampered.status, 401, 'firma de otro data.id -> 401');
    const malformed = await http('POST', `/api/payments/webhook?data.id=${mp.id}&type=payment`, { headers: { 'x-signature': 'ts=1,v1=zz', 'x-request-id': randomUUID() }, body: { type: 'payment' } });
    t.equal(malformed.status, 401, 'x-signature mal formada -> 401');
    t.equal(fake.hits.payment, fetchesBefore, 'las llamadas rechazadas no consultaron a Mercado Pago');
    t.equal(await stableState(reference, student.id), snapshotBefore, 'BD sin cambios tras firmas inválidas');
    t.equal((await learn(student, REAL_PAID_COURSE_ID)).status, 403, 'el curso sigue bloqueado');
    const paymentsBefore = Number((await sql('SELECT COUNT(*) AS n FROM payments'))[0].n);
    const missing = await webhook('99999999999999');
    t.equal(missing.status, 200, 'firma válida con payment_id inexistente -> 200');
    const otherTopic = await webhook(mp.id, { type: 'merchant_order' });
    t.equal(otherTopic.status, 200, 'otro tema (merchant_order) se ignora con 200');
    t.equal(Number((await sql('SELECT COUNT(*) AS n FROM payments'))[0].n), paymentsBefore, 'sin filas nuevas');
    t.equal(await stableState(reference, student.id), snapshotBefore, 'BD sin cambios tras id inexistente / otro tema');
  });

  await scenario('B5', 'monto/moneda distintos y referencias ajenas: sin acceso', async (t) => {
    const amountStudent = await createUser('student', 'alumna-monto');
    await addExpiredEnrollment(amountStudent.id, REAL_PAID_COURSE_ID);
    const amountCase = await buy(amountStudent, REAL_PAID_COURSE_ID, { amount: 1 });
    t.equal((await webhook(amountCase.mp.id)).status, 200, 'webhook con monto 1.00 responde 200');
    const amountRow = await paymentOf(amountCase.reference);
    t.equal(amountRow.status, 'pending', 'el pago no pasa a approved');
    t.equal(Number(amountRow.needs_review), 1, 'queda marcado para revisión');
    t.equal(amountRow.review_reason, 'amount_mismatch', 'motivo amount_mismatch');
    t.equal((await learn(amountStudent, REAL_PAID_COURSE_ID)).status, 403, 'sin acceso con monto distinto');

    const currencyStudent = await createUser('student', 'alumna-moneda');
    await addExpiredEnrollment(currencyStudent.id, REAL_PAID_COURSE_ID);
    const currencyCase = await buy(currencyStudent, REAL_PAID_COURSE_ID, { currency: 'USD' });
    await webhook(currencyCase.mp.id);
    const currencyRow = await paymentOf(currencyCase.reference);
    t.equal(currencyRow.status, 'pending', 'moneda USD: no aprobado');
    t.equal(currencyRow.review_reason, 'amount_mismatch', 'moneda USD: marcado amount_mismatch');
    t.equal((await learn(currencyStudent, REAL_PAID_COURSE_ID)).status, 403, 'sin acceso con moneda distinta');

    const metaStudent = await createUser('student', 'alumna-meta');
    await addExpiredEnrollment(metaStudent.id, REAL_PAID_COURSE_ID);
    const metaCase = await buy(metaStudent, REAL_PAID_COURSE_ID, { metadata: { user_id: currencyStudent.id, course_id: REAL_PAID_COURSE_ID } });
    await webhook(metaCase.mp.id);
    const metaRow = await paymentOf(metaCase.reference);
    t.equal(metaRow.status, 'pending', 'metadata de otro usuario: no aprobado');
    t.equal(metaRow.review_reason, 'metadata_mismatch', 'marcado metadata_mismatch');
    t.equal((await learn(metaStudent, REAL_PAID_COURSE_ID)).status, 403, 'sin acceso con metadata ajena');

    const foreign = fake.addPayment({ reference: randomUUID(), amount: 199, status: 'approved' });
    const rowsBefore = Number((await sql('SELECT COUNT(*) AS n FROM payments'))[0].n);
    t.equal((await webhook(foreign.id)).status, 200, 'external_reference desconocida -> 200');
    t.equal(Number((await sql('SELECT COUNT(*) AS n FROM payments'))[0].n), rowsBefore, 'sin efecto en la BD');
    const demoRef = fake.addPayment({ reference: `demo-${randomUUID()}`, amount: 199, status: 'approved' });
    t.equal((await webhook(demoRef.id)).status, 200, 'referencia demo- -> 200 sin efecto');
  });

  await scenario('B6', 'sin webhook: verify no confía en el query y exige estado real approved', async (t) => {
    const student = await createUser('student', 'alumna-verify');
    await addExpiredEnrollment(student.id, REAL_PAID_COURSE_ID);
    const { mp, reference } = await buy(student, REAL_PAID_COURSE_ID, { status: 'pending' });
    const forged = await http('POST', `/api/payments/verify?status=approved&collection_status=approved&payment_id=${mp.id}`, {
      token: student.token, body: { externalReference: reference, paymentId: String(mp.id), status: 'approved', collection_status: 'approved' },
    });
    t.equal(forged.status, 200, 'verify con query/cuerpo falsos responde 200');
    t.equal(forged.body.accessGranted, false, 'NO otorga acceso por el status falso');
    t.equal(forged.body.outcome, 'pending', 'outcome sigue pending');
    t.equal((await paymentOf(reference)).status, 'pending', 'BD sigue en pending');
    t.equal((await learn(student, REAL_PAID_COURSE_ID)).status, 403, 'curso aún bloqueado');
    const getVerify = await http('GET', `/api/payments/verify?external_reference=${reference}&payment_id=${mp.id}&status=approved`, { token: student.token });
    t.check(getVerify.status === 404, 'GET /verify no existe (404): no hay atajo por URL');

    fake.setStatus(mp.id, 'approved');
    const real1 = await verify(student, { externalReference: reference, paymentId: String(mp.id) });
    t.equal(real1.body.accessGranted, true, 'con el pago realmente approved, verify otorga acceso');
    t.equal((await learn(student, REAL_PAID_COURSE_ID)).status, 200, 'curso accesible');
    const first = await enrollmentOf(student.id, REAL_PAID_COURSE_ID);
    const real2 = await verify(student, { externalReference: reference, paymentId: String(mp.id) });
    t.equal(real2.status, 200, 'segundo verify responde 200');
    const second = await enrollmentOf(student.id, REAL_PAID_COURSE_ID);
    t.equal(second.raw, first.raw, 'acceso otorgado una sola vez (expires_at igual)');
    t.equal(await enrollmentCount(student.id, REAL_PAID_COURSE_ID), 1, 'una inscripción');

    const stranger = await createUser('student', 'alumna-ajena');
    const foreignVerify = await verify(stranger, { externalReference: reference, paymentId: String(mp.id) });
    t.equal(foreignVerify.status, 404, 'otro usuario verificando pago ajeno -> 404');
    await addExpiredEnrollment(stranger.id, REAL_PAID_COURSE_ID);
    const strangerStart = await checkout(stranger, REAL_PAID_COURSE_ID);
    const mismatch = await verify(stranger, { externalReference: strangerStart.body.externalReference, paymentId: String(mp.id) });
    t.equal(mismatch.status, 400, 'usar un payment_id ajeno con la propia referencia -> 400');
    t.equal((await learn(stranger, REAL_PAID_COURSE_ID)).status, 403, 'el intruso no obtiene acceso');

    const searcher = await createUser('student', 'alumna-search');
    await addExpiredEnrollment(searcher.id, REAL_PAID_COURSE_ID);
    const searchCase = await buy(searcher, REAL_PAID_COURSE_ID);
    const searched = await verify(searcher, { externalReference: searchCase.reference });
    t.equal(searched.body.accessGranted, true, 'verify sin payment_id busca por external_reference y otorga acceso');
    t.equal((await verify(searcher, { externalReference: 'no-es-uuid' })).status, 400, 'referencia inválida -> 400');
    t.equal((await http('POST', '/api/payments/verify', { body: { externalReference: reference } })).status, 401, 'verify sin sesión -> 401');
  });

  await scenario('B7', 'pending / in_process / rejected / reintento', async (t) => {
    const student = await createUser('student', 'alumna-estados');
    await addExpiredEnrollment(student.id, REAL_PAID_COURSE_ID);
    const { mp, reference } = await buy(student, REAL_PAID_COURSE_ID, { status: 'pending' });
    let result = await verify(student, { externalReference: reference, paymentId: String(mp.id) });
    t.equal(result.body.outcome, 'pending', 'pending -> outcome pending');
    t.equal(result.body.accessGranted, false, 'pending -> sin acceso');
    fake.setStatus(mp.id, 'in_process');
    await webhook(mp.id);
    t.equal((await paymentOf(reference)).status, 'in_process', 'in_process reflejado en la BD');
    result = await verify(student, { externalReference: reference, paymentId: String(mp.id) });
    t.equal(result.body.outcome, 'pending', 'in_process -> outcome pending');
    t.equal((await learn(student, REAL_PAID_COURSE_ID)).status, 403, 'in_process -> sin acceso');
    fake.setStatus(mp.id, 'approved');
    await webhook(mp.id);
    t.equal((await paymentOf(reference)).status, 'approved', 'approved reflejado');
    t.equal((await learn(student, REAL_PAID_COURSE_ID)).status, 200, 'approved -> acceso');

    const rejectedStudent = await createUser('student', 'alumna-rechazo');
    await addExpiredEnrollment(rejectedStudent.id, REAL_PAID_COURSE_ID);
    const rejectedCase = await buy(rejectedStudent, REAL_PAID_COURSE_ID, { status: 'rejected' });
    await webhook(rejectedCase.mp.id);
    const rejectedVerify = await verify(rejectedStudent, { externalReference: rejectedCase.reference, paymentId: String(rejectedCase.mp.id) });
    t.equal(rejectedVerify.body.outcome, 'rejected', 'rejected -> outcome rejected');
    t.equal(rejectedVerify.body.accessGranted, false, 'rejected -> sin acceso');
    t.equal((await paymentOf(rejectedCase.reference)).status, 'rejected', 'estado rejected en BD');
    const retry = await checkout(rejectedStudent, REAL_PAID_COURSE_ID);
    t.equal(retry.status, 201, 'puede reintentar con un checkout nuevo');
    t.check(retry.body.externalReference !== rejectedCase.reference && retry.body.paymentId !== rejectedCase.start.paymentId, 'el reintento crea un pago y referencia nuevos');
    const second = fake.addPayment({ reference: retry.body.externalReference, amount: 199, status: 'approved', email: rejectedStudent.email, metadata: { user_id: rejectedStudent.id, course_id: REAL_PAID_COURSE_ID } });
    await webhook(second.id);
    t.equal((await learn(rejectedStudent, REAL_PAID_COURSE_ID)).status, 200, 'el reintento aprobado da acceso');
  });

  await scenario('B8', 'reembolso / contracargo tras aprobar: no revoca, visible para super admin', async (t) => {
    const refundStudent = await createUser('student', 'alumna-reembolso');
    await addExpiredEnrollment(refundStudent.id, REAL_PAID_COURSE_ID);
    const refundCase = await buy(refundStudent, REAL_PAID_COURSE_ID);
    await webhook(refundCase.mp.id);
    t.equal((await learn(refundStudent, REAL_PAID_COURSE_ID)).status, 200, 'acceso tras aprobar');
    const enrollmentBefore = await enrollmentOf(refundStudent.id, REAL_PAID_COURSE_ID);
    fake.setStatus(refundCase.mp.id, 'refunded');
    t.equal((await webhook(refundCase.mp.id)).status, 200, 'webhook de reembolso responde 200');
    const refundRow = await paymentOf(refundCase.reference);
    t.equal(refundRow.status, 'refunded', 'payments.status = refunded');
    t.equal(Number(refundRow.needs_review), 1, 'marcado para revisión');
    t.equal(refundRow.review_reason, 'refunded', 'motivo refunded');
    t.equal((await learn(refundStudent, REAL_PAID_COURSE_ID)).status, 200, 'el acceso NO se revoca automáticamente (diseño)');
    t.equal((await enrollmentOf(refundStudent.id, REAL_PAID_COURSE_ID)).raw, enrollmentBefore.raw, 'la inscripción no cambió');

    const chargebackStudent = await createUser('student', 'alumna-contracargo');
    await addExpiredEnrollment(chargebackStudent.id, REAL_PAID_COURSE_ID);
    const chargebackCase = await buy(chargebackStudent, REAL_PAID_COURSE_ID);
    await webhook(chargebackCase.mp.id);
    fake.setStatus(chargebackCase.mp.id, 'charged_back');
    await webhook(chargebackCase.mp.id);
    const chargebackRow = await paymentOf(chargebackCase.reference);
    t.equal(chargebackRow.status, 'charged_back', 'payments.status = charged_back');
    t.equal(chargebackRow.review_reason, 'charged_back', 'motivo charged_back');
    t.equal((await learn(chargebackStudent, REAL_PAID_COURSE_ID)).status, 200, 'contracargo tampoco revoca automáticamente');

    const superList = await http('GET', '/api/super/payments?status=refunded&pageSize=50', { token: superAdmin.token });
    t.equal(superList.status, 200, 'super admin lista reembolsos');
    t.check(superList.body.payments.some((item) => item.externalReference === refundCase.reference && item.needsReview), 'el reembolso aparece en el listado con needsReview');
    const review = await http('GET', '/api/super/payments?status=review&pageSize=50', { token: superAdmin.token });
    t.check(review.body.payments.some((item) => item.externalReference === chargebackCase.reference), 'el contracargo aparece en "requieren revisión"');
  });

  await scenario('B9', 'alumno sin inscripción previa: expires_at correcto (45 días real, 30 días, indefinido)', async (t) => {
    const realOwnerCourse = await courseOf(REAL_OWNER_COURSE_ID);
    const realOwnerDays = Number(realOwnerCourse.access_days);
    const newStudent = await createUser('student', 'alumno-nuevo');
    t.equal(await enrollmentCount(newStudent.id, REAL_OWNER_COURSE_ID), 0, 'sin inscripción previa en el curso 3');
    const realCase = await buy(newStudent, REAL_OWNER_COURSE_ID);
    t.equal(realCase.start.amount, Number(realOwnerCourse.price_cents) / 100, `monto del curso 3 = ${Number(realOwnerCourse.price_cents) / 100}`);
    t.equal((await webhook(realCase.mp.id)).status, 200, 'webhook aprobado responde 200');
    const created = await enrollmentOf(newStudent.id, REAL_OWNER_COURSE_ID);
    t.check(created !== null, 'inscripción creada');
    t.check(approxSeconds(created.secs, realOwnerDays), `expires_at = ahora + ${realOwnerDays} días (valor real de access_days del curso 3)`);
    t.equal(created.enrolled_by_id, null, 'enrolled_by_id NULL (compra, no asignación)');
    t.equal((await learn(newStudent, REAL_OWNER_COURSE_ID)).status, 200, 'acceso al curso 3');

    const thirty = await createUser('student', 'alumno-30');
    const thirtyCase = await buy(thirty, paidCourse);
    await webhook(thirtyCase.mp.id);
    t.check(approxSeconds((await enrollmentOf(thirty.id, paidCourse)).secs, 30), 'curso temporal de 30 días -> now + 30 días');

    const lifetime = await createUser('student', 'alumno-indef');
    const lifetimeCase = await buy(lifetime, lifetimeCourse);
    await webhook(lifetimeCase.mp.id);
    const lifetimeEnrollment = await enrollmentOf(lifetime.id, lifetimeCourse);
    t.check(lifetimeEnrollment !== null && lifetimeEnrollment.raw === null, 'curso indefinido -> expires_at NULL');
    ctx.paidBuyer = thirty;
  });

  await scenario('B10', 'seguridad: autenticación, validaciones, roles y alcance de listados', async (t) => {
    const student = await createUser('student', 'alumno-seguridad');
    t.equal((await http('POST', `/api/payments/courses/${REAL_PAID_COURSE_ID}/checkout`)).status, 401, 'checkout sin sesión -> 401');
    t.equal((await checkout(student, freeCourse)).status, 422, 'curso gratis -> 422');
    t.equal((await checkout(student, 99999999)).status, 404, 'curso inexistente -> 404');
    t.equal((await checkout(student, draftCourse)).status, 404, 'curso no publicado -> 404');
    t.equal((await checkout(student, 'abc')).status, 400, 'id no numérico -> 400');
    const managerOwner = await checkout(owner, paidCourse);
    t.equal(managerOwner.status, 409, 'docente dueño -> 409');
    t.equal(managerOwner.body.code, 'COURSE_MANAGER', 'con código COURSE_MANAGER');
    t.check(/administrador de este curso/i.test(managerOwner.body.message), 'mensaje: Eres administrador de este curso');
    const managerSuper = await checkout(superAdmin, REAL_PAID_COURSE_ID);
    t.equal(managerSuper.status, 409, 'super_admin -> 409');
    t.equal(managerSuper.body.code, 'COURSE_MANAGER', 'super_admin con código COURSE_MANAGER');
    const active = await checkout(ctx.paidBuyer, paidCourse);
    t.equal(active.status, 409, 'alumno con acceso vigente -> 409');
    t.equal(active.body.code, 'ALREADY_ENROLLED', 'con código ALREADY_ENROLLED');

    const noPay = await http('POST', `/api/courses/${REAL_PAID_COURSE_ID}/enroll`, { token: student.token });
    t.equal(noPay.status, 402, '/enroll en curso de pago sin pago -> 402');
    t.equal(noPay.body.code, 'PAYMENT_REQUIRED', 'con código PAYMENT_REQUIRED');
    const free = await http('POST', `/api/courses/${freeCourse}/enroll`, { token: student.token });
    t.check(free.status === 201 || free.status === 200, '/enroll en curso gratuito -> OK');
    const expired = await createUser('student', 'alumno-renovar');
    await addExpiredEnrollment(expired.id, REAL_PAID_COURSE_ID);
    const renewal = await http('POST', `/api/courses/${REAL_PAID_COURSE_ID}/enroll`, { token: expired.token });
    t.equal(renewal.status, 409, '/enroll con acceso vencido en curso de pago -> 409');
    t.equal(renewal.body.code, 'RENEWAL_REQUIRED', 'con código RENEWAL_REQUIRED');
    t.equal(renewal.body.message, 'Tu acceso venció. Renueva el acceso pagando de nuevo el curso.', 'mensaje nuevo de renovación');

    const mine = await http('GET', '/api/payments/mine', { token: ctx.paidBuyer.token });
    const ownRows = await sql('SELECT external_reference FROM payments WHERE user_id = ?', [ctx.paidBuyer.id]);
    t.equal(mine.status, 200, '/mine responde 200');
    t.equal(mine.body.payments.length, ownRows.length, '/mine devuelve solo los pagos propios (misma cantidad que en la BD)');
    t.check(mine.body.payments.every((item) => ownRows.some((row) => row.external_reference === item.externalReference)), 'todas las referencias de /mine son propias');
    t.equal((await http('GET', '/api/payments/mine')).status, 401, '/mine sin sesión -> 401');

    t.equal((await http('GET', '/api/super/payments', { token: student.token })).status, 403, 'alumno en /super/payments -> 403');
    t.equal((await http('GET', '/api/super/payments', { token: owner.token })).status, 403, 'docente en /super/payments -> 403');
    t.equal((await http('GET', '/api/admin/payments', { token: student.token })).status, 403, 'alumno en /admin/payments -> 403');
    t.equal((await http('GET', '/api/super/payments')).status, 401, '/super/payments sin sesión -> 401');
    const superAll = await http('GET', '/api/super/payments?pageSize=50', { token: superAdmin.token });
    t.equal(superAll.status, 200, 'super admin ve todos los pagos');
    t.check(superAll.body.total >= 10 && superAll.body.payments.some((item) => item.course.id === REAL_PAID_COURSE_ID), 'incluye pagos del curso 7');
    t.check(superAll.body.payments.every((item) => item.student && !('payerEmail' in item) && !('rawStatusPayload' in item)), 'no expone payer_email ni payload crudo');
    const ownerList = await http('GET', '/api/admin/payments?pageSize=50', { token: owner.token });
    t.equal(ownerList.status, 200, 'docente lista sus pagos');
    t.check(ownerList.body.total >= 2 && ownerList.body.payments.every((item) => [paidCourse, lifetimeCourse].includes(item.course.id)), 'docente solo ve pagos de sus propios cursos');
    const otherList = await http('GET', '/api/admin/payments?pageSize=50', { token: otherAdmin.token });
    t.equal(otherList.status, 200, 'otro docente lista');
    t.equal(otherList.body.total, 0, 'otro docente no ve pagos ajenos');
    t.equal((await http('GET', '/api/super/payments?page=1e21', { token: superAdmin.token })).status, 400, 'page=1e21 -> 400 (antes 500)');
    t.equal((await http('GET', '/api/super/payments?page=100001', { token: superAdmin.token })).status, 400, 'page=100001 -> 400');
    t.equal((await http('GET', '/api/super/payments?pageSize=51', { token: superAdmin.token })).status, 400, 'pageSize=51 -> 400');
    t.equal((await http('GET', '/api/super/payments?status=bogus', { token: superAdmin.token })).status, 400, 'status inválido -> 400');
    t.equal((await http('GET', '/api/payments/config')).body.currency, 'MXN', '/config informa MXN');
  });

  await scenario('H1', 'endurecimiento: si Mercado Pago falla no queda registro pending huérfano', async (t) => {
    const student = await createUser('student', 'alumno-fallo-mp');
    fake.control.failNextPreferences = 2; // createPreference no reintenta salvo auto_return; cubre ambas llamadas
    const failed = await checkout(student, paidCourse);
    fake.control.failNextPreferences = 0;
    t.equal(failed.status, 502, 'fallo de Mercado Pago -> 502');
    t.equal(failed.body.code, 'PAYMENT_PROVIDER_ERROR', 'código PAYMENT_PROVIDER_ERROR');
    const rows = await sql('SELECT status, status_detail, preference_id, checkout_url FROM payments WHERE user_id = ?', [student.id]);
    t.equal(rows.length, 1, 'el intento quedó registrado');
    t.equal(rows[0].status, 'cancelled', 'registro marcado cancelled (no pending huérfano)');
    t.equal(rows[0].preference_id, null, 'sin preference_id');
    const retry = await checkout(student, paidCourse);
    t.equal(retry.status, 201, 'el reintento posterior funciona');
    t.check(retry.body.paymentId !== undefined && retry.body.paymentId !== failed.body.paymentId, 'crea un pago nuevo (no reutiliza el cancelado)');
  });

  await scenario('H2', 'endurecimiento: el webhook usa su propio límite holgado (>120 por minuto)', async (t) => {
    const responses = await Promise.all(Array.from({ length: 150 }, () => webhook('99999999998', { sign: true })));
    t.check(responses.every((item) => item.status === 200), '150 webhooks seguidos no reciben 429');
  });
}

// ---------- principal ----------
const hardTimeout = setTimeout(() => {
  console.error('Tiempo máximo de las pruebas e2e excedido (10 min).');
  backend?.kill();
  process.exit(1);
}, 600000);
hardTimeout.unref();

let exitCode = 1;
let before = null;
try {
  passwordHash = await bcrypt.hash(PASSWORD, 4);
  const stale = await cleanup();
  if (stale.users || stale.courses) console.log(`Se limpiaron restos de una ejecución anterior (${stale.users} usuarios, ${stale.courses} cursos).`);
  before = await snapshot();
  await fake.start();
  await startBackend();
  console.log(`Backend temporal en :${API_PORT}, Mercado Pago falso en :${FAKE_PORT}, base de datos real (usuarios temporales e2e-${TAG}-*)\n`);
  await runScenarios();
} catch (error) {
  console.error(`Error preparando o ejecutando las pruebas: ${error.message}`);
  results.push({ id: 'SETUP', title: 'preparación', pass: false, error: error.message });
} finally {
  await stopBackend().catch(() => {});
  await fake.stop().catch(() => {});
  let restored = false;
  try {
    const removed = await cleanup();
    const after = await snapshot();
    restored = before === null || before === after;
    console.log(`\nLimpieza: ${removed.users} usuarios y ${removed.courses} cursos temporales eliminados; base restaurada: ${restored ? 'sí' : 'NO (revisar manualmente)'}`);
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
