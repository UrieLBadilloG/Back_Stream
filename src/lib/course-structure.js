import { httpError } from './http-error.js';

// Funciones puras para la estructura de un curso (numeración, órdenes y validadores).
// No importar env, base de datos ni Cloudinary: las pruebas unitarias cargan este archivo sin .env.

export const DOCUMENT_CATEGORIES = Object.freeze(['terms', 'document', 'guide']);
export const PROMO_IMAGE_LIMIT = 8;

const CLASS_PREFIX = /^\s*clase\s*\d+/i;

export function hasClassPrefix(title) {
  return CLASS_PREFIX.test(String(title ?? ''));
}

function numeric(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

// Ordena por (posición de sección, posición de clase, id) y asigna lessonNumber 1..N continuo.
// Los huecos en `position` no afectan el número. Acepta camelCase o snake_case.
// Las evaluaciones (kind === 'quiz') reciben lessonNumber null y no consumen número; sin `kind` = video.
export function numberLessons(rows) {
  const sectionOf = (row) => numeric(row.sectionPosition ?? row.section_position ?? 0);
  let counter = 0;
  return [...rows]
    .sort((a, b) => sectionOf(a) - sectionOf(b) || numeric(a.position) - numeric(b.position) || numeric(a.id) - numeric(b.id))
    .map((row) => {
      if (row.kind === 'quiz') return { ...row, lessonNumber: null };
      counter += 1;
      return { ...row, lessonNumber: counter };
    });
}

function idList(value, label) {
  if (!Array.isArray(value)) throw httpError(400, `${label} debe ser una lista.`);
  const ids = value.map((item) => Number(item));
  if (!ids.every((id) => Number.isSafeInteger(id) && id > 0)) throw httpError(400, `${label} contiene identificadores no válidos.`);
  return ids;
}

function assertSamePermutation(currentIds, requestedIds, label) {
  const seen = new Set();
  for (const id of requestedIds) {
    if (seen.has(id)) throw httpError(400, `${label} contiene elementos repetidos.`);
    seen.add(id);
  }
  const current = new Set(currentIds.map(Number));
  if (requestedIds.some((id) => !current.has(id))) throw httpError(400, `${label} contiene elementos que no pertenecen al curso.`);
  if (requestedIds.length !== current.size) throw httpError(400, `${label} debe incluir todos los elementos del curso.`);
}

// Devuelve [{ id, position }] con posiciones 1..N según el orden solicitado (permutación exacta).
export function planOrder(currentIds, requestedIds, label) {
  const requested = idList(requestedIds, label);
  assertSamePermutation(currentIds, requested, label);
  return requested.map((id, index) => ({ id, position: index + 1 }));
}

export function planSectionOrder(currentIds, requestedIds) {
  return planOrder(currentIds, requestedIds, 'La lista de secciones');
}

// currentSections: [{ id, lessonIds }] en el orden de visualización actual de las secciones.
// requestedSections: [{ id, lessonIds }] con el diseño final deseado (incluye mover clases entre secciones).
// Las posiciones de clase son globales al curso (UNIQUE course_id, position) y se numeran siguiendo el
// orden actual de secciones, para que coincidan con el orden de lectura (sección, clase).
// Devuelve [{ lessonId, sectionId, position }].
export function planLessonLayout(currentSections, requestedSections) {
  if (!Array.isArray(requestedSections)) throw httpError(400, 'El diseño de clases debe ser una lista de secciones.');
  const requested = new Map();
  for (const section of requestedSections) {
    const sectionId = Number(section?.id);
    if (!Number.isSafeInteger(sectionId) || sectionId <= 0) throw httpError(400, 'El diseño contiene una sección no válida.');
    if (requested.has(sectionId)) throw httpError(400, 'El diseño contiene secciones repetidas.');
    requested.set(sectionId, idList(section.lessonIds, 'La lista de clases'));
  }
  assertSamePermutation(currentSections.map((section) => section.id), [...requested.keys()], 'El diseño de secciones');
  const currentLessonIds = currentSections.flatMap((section) => section.lessonIds.map(Number));
  assertSamePermutation(currentLessonIds, [...requested.values()].flat(), 'El diseño de clases');
  const plan = [];
  let position = 0;
  for (const section of currentSections) {
    const sectionId = Number(section.id);
    for (const lessonId of requested.get(sectionId)) {
      position += 1;
      plan.push({ lessonId, sectionId, position });
    }
  }
  return plan;
}

// Acepta únicamente imágenes alojadas en el Cloudinary del proyecto: https://res.cloudinary.com/<cloud>/image/...
export function isCloudinaryImageUrl(url, cloudName) {
  if (typeof url !== 'string' || !cloudName) return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'res.cloudinary.com') return false;
  if (parsed.port || parsed.username || parsed.password) return false;
  return parsed.pathname.startsWith(`/${cloudName}/image/`);
}
