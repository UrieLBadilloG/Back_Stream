// Compatibilidad del curso 83 antes/despues de las evaluaciones.
//   node scripts/quizzes-compat-83.mjs capture   -> guarda .agents/tasks/quizzes/baseline-83.json
//   node scripts/quizzes-compat-83.mjs compare   -> repite la consulta y compara (imprime OK o DIFF)
// Solo hace GET de lectura contra un servidor efimero en 127.0.0.1 (puerto asignado por el sistema).
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import app from '../src/app.js';
import { closeDatabasePool, pool } from '../src/config/database.js';
import { createAccessToken } from '../src/middleware/auth.js';

const COURSE_ID = 83;
const SUPER_ADMIN_ID = 1;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = resolve(root, '.agents/tasks/quizzes/baseline-83.json');

const mode = process.argv[2];
if (mode !== 'capture' && mode !== 'compare') {
  console.error('Uso: node scripts/quizzes-compat-83.mjs capture|compare');
  process.exit(1);
}

// Huella de las filas del curso. Sin columna kind: debe poder correr antes de la migracion.
async function fingerprint() {
  const [sections] = await pool.execute('SELECT id, course_id, title, description, position FROM course_sections WHERE course_id = ? ORDER BY id', [COURSE_ID]);
  const [lessons] = await pool.execute('SELECT id, section_id, title, description, video_url, video_public_id, duration_seconds, position, is_preview FROM lessons WHERE course_id = ? ORDER BY id', [COURSE_ID]);
  const [lessonMaterials] = await pool.execute('SELECT m.* FROM lesson_materials m JOIN lessons l ON l.id = m.lesson_id WHERE l.course_id = ? ORDER BY m.id', [COURSE_ID]);
  const [courseMaterials] = await pool.execute('SELECT * FROM course_materials WHERE course_id = ? ORDER BY id', [COURSE_ID]);
  const hash = createHash('sha256').update(JSON.stringify({ sections, lessons, lessonMaterials, courseMaterials })).digest('hex');
  return { sha256: hash, counts: { sections: sections.length, lessons: lessons.length, lessonMaterials: lessonMaterials.length, courseMaterials: courseMaterials.length } };
}

const pick = (lesson, keys, extra = {}) => Object.fromEntries([...keys.map((key) => [key, lesson[key] ?? null]), ...Object.entries(extra)]);
const LESSON_KEYS = ['id', 'title', 'position', 'lessonNumber', 'sectionId', 'videoUrl', 'durationSeconds'];
const PUBLIC_KEYS = ['id', 'title', 'position', 'lessonNumber', 'sectionId', 'durationSeconds'];

async function main() {
  const [[courseRow]] = await pool.execute('SELECT slug FROM courses WHERE id = ? LIMIT 1', [COURSE_ID]);
  if (!courseRow) throw new Error(`El curso ${COURSE_ID} no existe.`);
  const [[superAdmin]] = await pool.execute('SELECT id, role FROM users WHERE id = ? LIMIT 1', [SUPER_ADMIN_ID]);
  if (!superAdmin || superAdmin.role !== 'super_admin') throw new Error('El usuario 1 no es super_admin.');
  const token = createAccessToken(superAdmin);

  const server = await new Promise((resolveServer) => { const instance = app.listen(0, '127.0.0.1', () => resolveServer(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const get = async (path, auth = true) => {
      const result = await fetch(`${base}${path}`, { headers: auth ? { Authorization: `Bearer ${token}` } : {} });
      if (!result.ok) throw new Error(`GET ${path} respondio ${result.status}`);
      return result.json();
    };
    const editor = await get(`/api/admin/courses/${COURSE_ID}/editor`);
    const learn = await get(`/api/courses/${COURSE_ID}/learn`);
    const publicCourse = await get(`/api/courses/${encodeURIComponent(courseRow.slug)}`, false);
    const students = await get(`/api/admin/courses/${COURSE_ID}/students`);
    const certificate = await get(`/api/courses/${COURSE_ID}/certificate`);

    const editorLessons = editor.sections.flatMap((section) => section.lessons.map((lesson) => pick(lesson, LESSON_KEYS, { sectionId: section.id })));
    const stable = {
      editor: { sections: editor.sections.map((section) => ({ id: section.id, title: section.title, position: section.position })), lessons: editorLessons, lessonCount: editorLessons.length },
      learn: { lessons: learn.lessons.map((lesson) => pick(lesson, LESSON_KEYS)), lessonCount: learn.lessons.length, completedLessons: learn.lessons.filter((lesson) => lesson.completedAt).length },
      public: { lessons: publicCourse.course.lessons.map((lesson) => pick(lesson, PUBLIC_KEYS)), lessonCount: publicCourse.course.lessons.length, courseLessonCount: publicCourse.course.lessonCount },
      students: { lessonCount: students.course.lessonCount, students: students.students.map((student) => ({ id: student.id, lessonCount: student.lessonCount })) },
      certificate: { totalLessons: certificate.totalLessons, completedLessons: certificate.completedLessons, eligible: certificate.eligible },
    };
    const snapshot = { courseId: COURSE_ID, fingerprint: await fingerprint(), stable };

    if (mode === 'capture') {
      await mkdir(dirname(baselinePath), { recursive: true });
      await writeFile(baselinePath, `${JSON.stringify({ capturedAt: new Date().toISOString(), ...snapshot }, null, 2)}\n`);
      console.log(`CAPTURE OK: ${stable.editor.lessonCount} lecciones, huella ${snapshot.fingerprint.sha256.slice(0, 12)}... -> ${baselinePath}`);
      return;
    }

    const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
    const diffs = [];
    if (baseline.fingerprint.sha256 !== snapshot.fingerprint.sha256) diffs.push('huella de filas distinta');
    for (const key of Object.keys(baseline.stable)) {
      if (JSON.stringify(baseline.stable[key]) !== JSON.stringify(stable[key])) diffs.push(`claves estables distintas en ${key}`);
    }
    if (diffs.length) {
      console.log(`DIFF: ${diffs.join('; ')}`);
      process.exitCode = 1;
    } else {
      console.log(`OK: curso ${COURSE_ID} identico al baseline (${stable.editor.lessonCount} lecciones)`);
    }
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

try {
  await main();
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
} finally {
  await closeDatabasePool();
}
