import { spawn } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import bcrypt from 'bcryptjs';

import { pool } from '../src/config/database.js';
import { generateCertificateCode } from '../src/lib/certificates.js';

// Verificación de punta a punta de "constancia verificable + enlace compartible del curso".
// Levanta un backend temporal (:3100, APP_URL=http://localhost:5190), crea datos temporales con prefijo
// "e2e-share-" en la base REAL, ejecuta las aserciones de API y luego ESPERA a que exista el archivo
// %TEMP%/share-verify-release.flag (mientras tanto se puede hacer la corrida del navegador usando
// %TEMP%/share-verify-fixtures.json). Al liberarse: prueba el rate limit, limpia todo y compara conteos.
//   E2E_CONFIRM=yes npm run test:share:e2e
if (process.env.E2E_CONFIRM !== 'yes') {
  console.error('Estas pruebas escriben en la base de datos REAL (usuarios y cursos temporales con prefijo e2e-share-).\nSi quieres ejecutarlas: E2E_CONFIRM=yes npm run test:share:e2e');
  process.exit(2);
}

const API_PORT = Number(process.env.E2E_API_PORT ?? 3100);
const APP_PORT = Number(process.env.E2E_APP_PORT ?? 5190);
if ([3000, 5173].includes(API_PORT) || [3000, 5173].includes(APP_PORT)) {
  console.error('Los puertos 3000 y 5173 están reservados al backend y al frontend de desarrollo.');
  process.exit(2);
}
const API = `http://127.0.0.1:${API_PORT}`;
const APP_URL = `http://localhost:${APP_PORT}`;
const PASSWORD = 'E2e-Share-2026!';
const TAG = Date.now().toString(36);
const PREFIX = 'e2e-share-';
const EMAIL_LIKE = `${PREFIX}%@streamly.test`;
const SLUG_LIKE = `${PREFIX}%`;
const RECIPIENT = 'María de los Ángeles Pérez López';
const ISSUED_AT = '2026-03-15 12:00:00';
const REAL_COURSE_ID = 83;
const NOT_FOUND = 'No encontramos una constancia con ese código.';
const TMP = tmpdir();
const FIXTURES_FILE = path.join(TMP, 'share-verify-fixtures.json');
const FLAG_FILE = path.join(TMP, 'share-verify-release.flag');
const BACK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let backend = null;
let backendLog = '';
let passwordHash = null;
const results = [];

const sql = async (statement, params = []) => (await pool.query(statement, params))[0];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(method, route, { token, body, headers = {} } = {}) {
  const response = await fetch(`${API}${route}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, bytes, text: bytes.toString('utf8') };
}

async function http(method, route, options) {
  const raw = await request(method, route, options);
  let json = null;
  try { json = JSON.parse(raw.text); } catch { json = null; }
  return { ...raw, body: json };
}

// ---------- utilidades de pruebas ----------
async function scenario(id, title, run) {
  const lines = [];
  const check = (condition, message) => {
    if (!condition) throw new Error(`FALLÓ: ${message}`);
    lines.push(message);
  };
  const equal = (actual, expected, message) => check(actual === expected, `${message} (esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)})`);
  try {
    await run({ check, equal });
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
async function createUser(role, label, fullName) {
  const email = `${PREFIX}${TAG}-${label}@streamly.test`;
  const result = await sql('INSERT INTO users (full_name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, 1)', [fullName, email, passwordHash, role]);
  return { id: Number(result.insertId), email };
}

const FAKE_VIDEO = 'https://res.cloudinary.com/e2e-share/video/upload/v1/e2e-share.mp4';

// videoUrl=null en el curso que abre el navegador evita peticiones externas de un video ficticio.
async function createCourse({ ownerId, label, title, priceCents = 0, status = 'published', thumbnail = null, template = null, lessonTitle = 'Introducción al curso', promoImage = null, videoUrl = FAKE_VIDEO }) {
  const slug = `${PREFIX}${TAG}-${label}`;
  const result = await sql(
    `INSERT INTO courses (owner_id, slug, title, subtitle, description, category, level, price_cents, access_days, thumbnail_url, certificate_template, status, published_at)
     VALUES (?, ?, ?, 'Subtítulo de prueba del curso temporal', 'Descripción de prueba del curso temporal para las verificaciones.', 'Pruebas', 'beginner', ?, NULL, ?, ?, ?, ${status === 'published' ? 'CURRENT_TIMESTAMP' : 'NULL'})`,
    [ownerId, slug, title, priceCents, thumbnail, template, status],
  );
  const id = Number(result.insertId);
  const section = await sql("INSERT INTO course_sections (course_id, title, description, position) VALUES (?, 'Módulo uno', 'Primer módulo', 1)", [id]);
  const lesson = await sql(
    "INSERT INTO lessons (course_id, section_id, title, description, video_url, duration_seconds, position) VALUES (?, ?, ?, 'Clase de prueba', ?, 600, 1)",
    [id, Number(section.insertId), lessonTitle, videoUrl],
  );
  if (promoImage) await sql("INSERT INTO course_promo_images (course_id, image_url, alt_text, position) VALUES (?, ?, 'Imagen promocional de prueba', 1)", [id, promoImage]);
  return { id, slug, lessonId: Number(lesson.insertId) };
}

async function cleanup() {
  const users = (await sql('SELECT id FROM users WHERE email LIKE ?', [EMAIL_LIKE])).map((row) => Number(row.id));
  const courses = (await sql('SELECT id FROM courses WHERE slug LIKE ?', [SLUG_LIKE])).map((row) => Number(row.id));
  if (courses.length) {
    await sql('DELETE FROM certificates WHERE course_id IN (?)', [courses]);
    await sql('DELETE FROM payments WHERE course_id IN (?)', [courses]);
    await sql('DELETE FROM enrollments WHERE course_id IN (?)', [courses]);
    await sql('DELETE FROM lesson_progress WHERE lesson_id IN (SELECT id FROM lessons WHERE course_id IN (?))', [courses]);
    await sql('DELETE FROM course_promo_images WHERE course_id IN (?)', [courses]);
    await sql('DELETE FROM lessons WHERE course_id IN (?)', [courses]);
    await sql('DELETE FROM course_sections WHERE course_id IN (?)', [courses]);
    await sql('DELETE FROM courses WHERE id IN (?)', [courses]);
  }
  if (users.length) {
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
            (SELECT COUNT(*) FROM payments) AS payments, (SELECT COUNT(*) FROM certificates) AS certificates`,
  );
  const [real] = await sql(
    `SELECT (SELECT COUNT(*) FROM lessons WHERE course_id = ?) AS lessons, (SELECT COUNT(*) FROM course_sections WHERE course_id = ?) AS sections,
            (SELECT COUNT(*) FROM enrollments WHERE course_id = ?) AS enrollments, (SELECT COUNT(*) FROM payments WHERE course_id = ?) AS payments,
            (SELECT COUNT(*) FROM certificates WHERE course_id = ?) AS certificates`,
    [REAL_COURSE_ID, REAL_COURSE_ID, REAL_COURSE_ID, REAL_COURSE_ID, REAL_COURSE_ID],
  );
  return { totals, course83: real };
}

// ---------- backend hijo ----------
async function startBackend() {
  backend = spawn(process.execPath, ['src/server.js'], {
    cwd: BACK_ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(API_PORT), APP_URL },
  });
  backend.stdout.on('data', (chunk) => { backendLog += chunk; });
  backend.stderr.on('data', (chunk) => { backendLog += chunk; });
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

async function stopBackend() {
  if (!backend || backend.exitCode !== null) return;
  const exited = new Promise((resolve) => backend.once('exit', resolve));
  backend.kill();
  await Promise.race([exited, wait(5000)]);
  if (backend.exitCode === null) backend.kill('SIGKILL');
}

// ---------- escenarios ----------
const fx = {};

async function createFixtures() {
  const owner = await createUser('admin', 'owner', 'E2E Docente Share');
  const alumno = await createUser('student', 'alumno', 'Alumna Con Constancia');
  const certCourse = await createCourse({ ownerId: owner.id, label: 'constancia', title: 'Mujer LegalTech E2E', template: 'mujer-legaltech', videoUrl: null });
  const code = generateCertificateCode('MLT');
  await sql('INSERT INTO enrollments (user_id, course_id, enrolled_by_id, expires_at) VALUES (?, ?, ?, NULL)', [alumno.id, certCourse.id, alumno.id]);
  await sql('INSERT INTO lesson_progress (user_id, lesson_id, completed_at) VALUES (?, ?, CURRENT_TIMESTAMP)', [alumno.id, certCourse.lessonId]);
  await sql("INSERT INTO certificates (user_id, course_id, template, certificate_code, recipient_name, issued_at) VALUES (?, ?, 'mujer-legaltech', ?, ?, ?)", [alumno.id, certCourse.id, code, RECIPIENT, ISSUED_AT]);
  const image = 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=1200&q=80';
  const paid = await createCourse({ ownerId: owner.id, label: 'pago', title: 'Curso de pago E2E', priceCents: 49900, thumbnail: image, promoImage: image });
  const free = await createCourse({ ownerId: owner.id, label: 'gratis', title: 'Curso gratis E2E' });
  const draft = await createCourse({ ownerId: owner.id, label: 'borrador', title: 'Curso borrador E2E', status: 'draft' });
  const xss = await createCourse({ ownerId: owner.id, label: 'xss', title: '"><script>alert(1)</script> e2e' });
  Object.assign(fx, { owner, alumno, certCourse, code, paid, free, draft, xss });
}

async function runScenarios() {
  await scenario('A1', 'verificación pública de la constancia: payload exacto y sin datos sensibles', async (t) => {
    const ok = await http('GET', `/api/certificates/verify/${fx.code}`);
    t.equal(ok.status, 200, 'GET verify/<código> responde 200');
    const keys = Object.keys(ok.body ?? {}).sort();
    t.equal(JSON.stringify(keys), JSON.stringify(['certificateCode', 'courseTitle', 'durationHours', 'instructorName', 'issuedAt', 'issuer', 'modality', 'recipientName', 'valid']), 'exactamente las 9 claves');
    t.equal(ok.body.valid, true, 'valid=true');
    t.equal(ok.body.recipientName, RECIPIENT, 'recipientName');
    t.equal(ok.body.certificateCode, fx.code, 'certificateCode');
    t.equal(ok.body.courseTitle, 'Mujer LegalTech E2E', 'courseTitle');
    t.equal(ok.body.issuer, 'Mujer LegalTech en México', 'issuer');
    t.equal(ok.body.durationHours, 20, 'durationHours 20');
    t.equal(ok.body.modality, '100% en línea', 'modality');
    t.equal(ok.body.instructorName, 'E2E Docente Share', 'instructorName = propietario');
    t.check(!Number.isNaN(Date.parse(ok.body.issuedAt)), 'issuedAt es una fecha ISO válida');
    t.equal(ok.headers.get('cache-control'), 'no-store', 'Cache-Control: no-store');
    t.equal(ok.headers.get('x-robots-tag'), 'noindex', 'X-Robots-Tag: noindex');
    const leaked = ok.text.toLowerCase();
    t.check(!leaked.includes('@streamly.test') && !/user_?id|course_?id|payment|email/.test(leaked), 'sin correo, ids ni pagos');
    const lower = await http('GET', `/api/certificates/verify/${fx.code.toLowerCase()}`);
    t.equal(lower.status, 200, 'el código en minúsculas también se normaliza y responde 200');
    fx.issuedAtIso = ok.body.issuedAt;
  });

  await scenario('A2', 'códigos inexistentes o mal formados: 404 idéntico', async (t) => {
    const probes = ['MLT-ZZZZ-ZZZZ', 'abc!!', encodeURIComponent('<script>alert(1)</script>'), 'A'.repeat(60), 'MLT', 'MLT_ZZZZ_ZZZZ'];
    const bodies = [];
    for (const probe of probes) {
      const res = await http('GET', `/api/certificates/verify/${probe}`);
      t.equal(res.status, 404, `verify/${probe.slice(0, 24)} -> 404`);
      bodies.push(res.text);
    }
    t.check(bodies.every((body) => body === bodies[0]), 'todas las respuestas 404 son idénticas');
    t.equal(JSON.parse(bodies[0]).message, NOT_FOUND, 'mensaje genérico');
  });

  await scenario('A3', 'insignia PNG: cabeceras y firma', async (t) => {
    const res = await request('GET', `/api/certificates/badge/${fx.code}.png`);
    t.equal(res.status, 200, 'badge/<código>.png responde 200');
    t.equal(res.headers.get('content-type'), 'image/png', 'Content-Type image/png');
    t.check(/public/.test(res.headers.get('cache-control') ?? ''), 'Cache-Control público');
    t.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin', 'Cross-Origin-Resource-Policy: cross-origin');
    t.equal(res.bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'firma PNG');
    t.check(res.bytes.length > 10000, `cuerpo de ${res.bytes.length} bytes`);
    const missing = await http('GET', '/api/certificates/badge/MLT-ZZZZ-ZZZZ.png');
    t.equal(missing.status, 404, 'badge de código inexistente -> 404');
    const noExt = await http('GET', `/api/certificates/badge/${fx.code}`);
    t.equal(noExt.status, 404, 'badge sin .png -> 404');
  });

  await scenario('A4', 'verifyUrl en GET /api/courses/:id/certificate', async (t) => {
    const login = await http('POST', '/api/auth/login', { body: { email: fx.alumno.email, password: PASSWORD } });
    t.equal(login.status, 200, 'login del alumno');
    const info = await http('GET', `/api/courses/${fx.certCourse.id}/certificate`, { token: login.body.accessToken });
    t.equal(info.status, 200, 'GET certificate responde 200');
    t.equal(info.body.verifyUrl, `${APP_URL}/verificar/${fx.code}`, 'verifyUrl = APP_URL/verificar/<código>');
    t.equal(info.body.certificateCode, fx.code, 'certificateCode');
    t.equal(info.body.recipientName, RECIPIENT, 'recipientName');
    t.equal(info.body.courseTitle, 'Mujer LegalTech E2E', 'courseTitle');
    t.equal(info.body.issuer, 'Mujer LegalTech en México', 'issuer');
  });

  await scenario('B1', 'GET /c/<slug>: Open Graph y redirección', async (t) => {
    const res = await request('GET', `/c/${fx.paid.slug}`);
    t.equal(res.status, 200, '/c/<slug pago> responde 200');
    t.equal(res.headers.get('content-type'), 'text/html; charset=utf-8', 'Content-Type text/html; charset=utf-8');
    for (const meta of ['og:title', 'og:description', 'og:image', 'og:url', 'og:type', 'og:site_name', 'twitter:card']) t.check(res.text.includes(`"${meta}"`), `contiene ${meta}`);
    t.check(res.text.includes('Curso de pago E2E'), 'og:title con el título');
    t.check(res.text.includes('images.unsplash.com/photo-1516321318423'), 'og:image con la portada https');
    t.check(res.text.includes(`0;url=${APP_URL}/curso/${fx.paid.slug}`), `meta refresh a ${APP_URL}/curso/<slug>`);
    t.check(!/<script/i.test(res.text), 'sin <script');
    const xss = await request('GET', `/c/${fx.xss.slug}`);
    t.equal(xss.status, 200, '/c/<slug xss> responde 200');
    // El backend quita las etiquetas del título y escapa el resto: nunca debe quedar HTML activo.
    t.check(xss.text.includes('<meta property="og:title" content="&quot;&gt; alert(1) e2e">') || xss.text.includes('&quot;&gt;&lt;script&gt;'), 'el título aparece escapado (sin etiquetas activas)');
    t.check(!/<script/i.test(xss.text) && !xss.text.includes('"><'), 'NO contiene <script ni "><');
    t.equal((await request('GET', `/c/${fx.draft.slug}`)).status, 404, '/c/<borrador> -> 404');
    t.equal((await request('GET', `/c/${PREFIX}${TAG}-inexistente`)).status, 404, '/c/<inexistente> -> 404');
    const odd = await request('GET', '/c/%3Cscript%3E');
    t.equal(odd.status, 404, '/c/%3Cscript%3E -> 404');
    t.check(!/<script/i.test(odd.text), '404 sin <script');
  });

  await scenario('B2', 'API pública del curso: secciones sin URLs de video', async (t) => {
    const res = await http('GET', `/api/courses/${fx.paid.slug}`);
    t.equal(res.status, 200, 'GET /api/courses/<slug> anónimo -> 200');
    const course = res.body?.course ?? {};
    t.check(Array.isArray(course.sections) && course.sections.length === 1, 'trae sections');
    t.check(Array.isArray(course.lessons) && course.lessons.length === 1, 'trae lessons');
    t.check(Boolean(course.lessons[0].lessonNumber), `la clase trae lessonNumber (${JSON.stringify(course.lessons[0].lessonNumber)})`);
    t.equal(course.lessons[0].sectionId, course.sections[0].id, 'sectionId enlaza con la sección');
    t.check(!/video_?url/i.test(res.text) && !res.text.includes('res.cloudinary.com/e2e-share'), 'sin video_url ni URL de video');
    t.equal((await http('GET', `/api/courses/${fx.draft.slug}`)).status, 404, 'borrador -> 404');
    const config = await http('GET', '/api/share/config');
    t.equal(config.status, 200, '/api/share/config -> 200');
    t.equal(config.body.previewAvailable, false, 'previewAvailable=false sin PUBLIC_API_URL público');
    t.equal(config.body.appUrl, APP_URL, 'appUrl');
  });

  await scenario('B3', 'registro, inscripción gratuita idempotente y curso de pago', async (t) => {
    const email = `${PREFIX}${TAG}-api@streamly.test`;
    const reg = await http('POST', '/api/auth/register', { body: { fullName: 'Usuaria Api Share', email, password: PASSWORD } });
    t.check(reg.status === 201 || reg.status === 200, `registro (${reg.status})`);
    const login = await http('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
    t.equal(login.status, 200, 'login del usuario registrado');
    const token = login.body.accessToken;
    const first = await http('POST', `/api/courses/${fx.free.id}/enroll`, { token });
    t.equal(first.status, 201, 'primer enroll -> 201');
    const second = await http('POST', `/api/courses/${fx.free.id}/enroll`, { token });
    t.equal(second.status, 200, 'segundo enroll -> 200');
    const [{ n }] = await sql('SELECT COUNT(*) AS n FROM enrollments e JOIN users u ON u.id = e.user_id WHERE u.email = ? AND e.course_id = ?', [email, fx.free.id]);
    t.equal(Number(n), 1, 'una sola inscripción');
    const paid = await http('POST', `/api/courses/${fx.paid.id}/enroll`, { token });
    t.equal(paid.status, 402, 'enroll al curso de pago -> 402');
  });
}

async function rateLimitScenario() {
  await scenario('R1', 'rate limit de verify: más de 30 por minuto desde la misma IP -> 429', async (t) => {
    const statuses = [];
    for (let index = 0; index < 40; index += 1) statuses.push((await request('GET', `/api/certificates/verify/${fx.code}`)).status);
    t.check(statuses.includes(429), `alguna respuesta es 429 (${statuses.filter((s) => s === 429).length} de 40)`);
    t.check(statuses[0] === 200 || statuses[0] === 429, 'las primeras respuestas son normales');
  });
}

async function waitForRelease() {
  await new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (existsSync(FLAG_FILE) || Date.now() - started > 20 * 60 * 1000) {
        clearInterval(timer);
        resolve();
      }
    }, 1000);
  });
}

// ---------- principal ----------
const hardTimeout = setTimeout(() => {
  console.error('Tiempo máximo excedido (25 min).');
  backend?.kill();
  process.exit(1);
}, 25 * 60 * 1000);
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
  console.log(`Backend temporal en :${API_PORT} (APP_URL=${APP_URL}), base real, datos ${PREFIX}${TAG}-*\n`);
  await runScenarios();
  writeFileSync(FIXTURES_FILE, JSON.stringify({
    tag: TAG, apiPort: API_PORT, appUrl: APP_URL, password: PASSWORD, prefix: `${PREFIX}${TAG}`, code: fx.code, recipient: RECIPIENT,
    issuedAt: fx.issuedAtIso, owner: fx.owner, alumno: fx.alumno,
    certCourse: { ...fx.certCourse, title: 'Mujer LegalTech E2E' }, paid: { ...fx.paid, title: 'Curso de pago E2E' }, free: { ...fx.free, title: 'Curso gratis E2E' },
    draft: { ...fx.draft, title: 'Curso borrador E2E' }, xss: fx.xss,
  }, null, 2));
  const early = results.filter((item) => !item.pass);
  console.log(`\nAserciones de API: ${results.length - early.length}/${results.length} en verde`);
  console.log('READY');
  await waitForRelease();
  console.log('Liberado: ejecutando el rate limit y la limpieza.');
  await rateLimitScenario();
} catch (error) {
  console.error(`Error preparando o ejecutando las pruebas: ${error.message}`);
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
