import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DOCUMENT_CATEGORIES,
  PROMO_IMAGE_LIMIT,
  hasClassPrefix,
  isCloudinaryImageUrl,
  numberLessons,
  planLessonLayout,
  planSectionOrder,
} from '../src/lib/course-structure.js';

const lesson = (id, sectionPosition, position) => ({ id, sectionPosition, position });
const numbersById = (rows) => Object.fromEntries(numberLessons(rows).map((row) => [row.id, row.lessonNumber]));
const status400 = (error) => error.statusCode === 400;

test('numera las clases de forma continua entre secciones', () => {
  const rows = [lesson(1, 1, 1), lesson(2, 1, 2), lesson(3, 2, 3), lesson(4, 2, 4)];
  assert.deepEqual(numbersById(rows), { 1: 1, 2: 2, 3: 3, 4: 4 });
});

test('reordenar secciones cambia la numeración sin tocar las posiciones de clase', () => {
  const rows = [lesson(1, 2, 1), lesson(2, 2, 2), lesson(3, 1, 3)];
  assert.deepEqual(numbersById(rows), { 3: 1, 1: 2, 2: 3 });
});

test('reordenar clases dentro de una sección actualiza los números', () => {
  const rows = [lesson(1, 1, 2), lesson(2, 1, 1), lesson(3, 1, 3)];
  assert.deepEqual(numbersById(rows), { 2: 1, 1: 2, 3: 3 });
});

const quiz = (id, sectionPosition, position) => ({ id, sectionPosition, position, kind: 'quiz' });

test('una evaluación entre videos no desplaza la numeración y recibe null', () => {
  const rows = [lesson(1, 1, 1), quiz(2, 1, 2), lesson(3, 1, 3), lesson(4, 2, 4)];
  assert.deepEqual(numbersById(rows), { 1: 1, 2: null, 3: 2, 4: 3 });
});

test('una evaluación al inicio no consume el número 1', () => {
  const rows = [quiz(1, 1, 1), { ...lesson(2, 1, 2), kind: 'video' }, lesson(3, 1, 3)];
  assert.deepEqual(numbersById(rows), { 1: null, 2: 1, 3: 2 });
});

test('un curso con solo evaluaciones no numera nada', () => {
  assert.deepEqual(numbersById([quiz(1, 1, 1), quiz(2, 2, 2)]), { 1: null, 2: null });
});

test('numberLessons reconoce kind en filas snake_case y no muta las filas', () => {
  const rows = [{ id: 1, section_position: 1, position: 1, kind: 'video' }, { id: 2, section_position: 1, position: 2, kind: 'quiz' }, { id: 3, section_position: 2, position: 3, kind: 'video' }];
  assert.deepEqual(numbersById(rows), { 1: 1, 2: null, 3: 2 });
  assert.equal(Object.hasOwn(rows[0], 'lessonNumber'), false);
});

test('mover una clase a otra sección la renumera', () => {
  const plan = planLessonLayout(
    [{ id: 10, lessonIds: [1, 2] }, { id: 20, lessonIds: [3] }],
    [{ id: 10, lessonIds: [1] }, { id: 20, lessonIds: [3, 2] }],
  );
  assert.deepEqual(plan, [
    { lessonId: 1, sectionId: 10, position: 1 },
    { lessonId: 3, sectionId: 20, position: 2 },
    { lessonId: 2, sectionId: 20, position: 3 },
  ]);
  const rows = plan.map((item) => lesson(item.lessonId, item.sectionId === 10 ? 1 : 2, item.position));
  assert.deepEqual(numbersById(rows), { 1: 1, 3: 2, 2: 3 });
});

test('mover una clase a una sección vacía y vaciar la de origen conserva posiciones únicas y todas las clases', () => {
  const plan = planLessonLayout(
    [{ id: 10, lessonIds: [1] }, { id: 20, lessonIds: [2, 3] }, { id: 30, lessonIds: [] }],
    [{ id: 10, lessonIds: [] }, { id: 20, lessonIds: [2, 3] }, { id: 30, lessonIds: [1] }],
  );
  assert.deepEqual(plan, [
    { lessonId: 2, sectionId: 20, position: 1 },
    { lessonId: 3, sectionId: 20, position: 2 },
    { lessonId: 1, sectionId: 30, position: 3 },
  ]);
  assert.equal(new Set(plan.map((item) => item.position)).size, plan.length);
  const rows = plan.map((item) => lesson(item.lessonId, item.sectionId / 10, item.position));
  assert.deepEqual(numbersById(rows), { 2: 1, 3: 2, 1: 3 });
});

test('no se puede mover una clase de otro curso a una sección ni a una sección ajena', () => {
  const current = [{ id: 10, lessonIds: [1] }, { id: 20, lessonIds: [] }];
  assert.throws(() => planLessonLayout(current, [{ id: 10, lessonIds: [] }, { id: 20, lessonIds: [1, 999] }]), status400);
  assert.throws(() => planLessonLayout(current, [{ id: 10, lessonIds: [] }, { id: 99, lessonIds: [1] }]), status400);
});

test('los huecos en position tras eliminar no cambian la numeración continua', () => {
  const rows = [lesson(1, 1, 1), lesson(3, 1, 7), lesson(4, 2, 12)];
  assert.deepEqual(numbersById(rows), { 1: 1, 3: 2, 4: 3 });
});

test('numberLessons usa el id como desempate y acepta snake_case', () => {
  const rows = [{ id: 9, section_position: 1, position: 1 }, { id: 5, section_position: 1, position: 1 }, { id: 7, position: 1 }];
  assert.deepEqual(numberLessons(rows).map((row) => [row.id, row.lessonNumber]), [[7, 1], [5, 2], [9, 3]]);
});

test('planSectionOrder asigna posiciones 1..N según el orden pedido', () => {
  assert.deepEqual(planSectionOrder([4, 5, 6], [6, 4, 5]), [{ id: 6, position: 1 }, { id: 4, position: 2 }, { id: 5, position: 3 }]);
});

test('planSectionOrder rechaza faltantes, duplicados y ajenos', () => {
  assert.throws(() => planSectionOrder([4, 5, 6], [4, 5]), status400);
  assert.throws(() => planSectionOrder([4, 5], [4, 4]), status400);
  assert.throws(() => planSectionOrder([4, 5], [4, 5, 9]), status400);
  assert.throws(() => planSectionOrder([4, 5], [4, 99]), status400);
  assert.throws(() => planSectionOrder([4, 5], 'x'), status400);
  assert.throws(() => planSectionOrder([4, 5], [4, 'a']), status400);
  assert.throws(() => planSectionOrder([4, 5], [4, -1]), status400);
});

test('planLessonLayout reordena dentro de la sección con posiciones globales', () => {
  const plan = planLessonLayout(
    [{ id: 1, lessonIds: [10, 11, 12] }, { id: 2, lessonIds: [13] }],
    [{ id: 2, lessonIds: [13] }, { id: 1, lessonIds: [12, 10, 11] }],
  );
  assert.deepEqual(plan.map((item) => [item.lessonId, item.position]), [[12, 1], [10, 2], [11, 3], [13, 4]]);
});

test('planLessonLayout rechaza clases faltantes, duplicadas y ajenas', () => {
  const current = [{ id: 1, lessonIds: [10, 11] }, { id: 2, lessonIds: [12] }];
  assert.throws(() => planLessonLayout(current, [{ id: 1, lessonIds: [10] }, { id: 2, lessonIds: [12] }]), status400);
  assert.throws(() => planLessonLayout(current, [{ id: 1, lessonIds: [10, 10, 11] }, { id: 2, lessonIds: [12] }]), status400);
  assert.throws(() => planLessonLayout(current, [{ id: 1, lessonIds: [10, 11, 99] }, { id: 2, lessonIds: [12] }]), status400);
  assert.throws(() => planLessonLayout(current, [{ id: 1, lessonIds: [10, 11] }, { id: 2, lessonIds: [10, 12] }]), status400);
});

test('planLessonLayout rechaza secciones faltantes, repetidas o ajenas y entradas inválidas', () => {
  const current = [{ id: 1, lessonIds: [10] }, { id: 2, lessonIds: [] }];
  assert.throws(() => planLessonLayout(current, [{ id: 1, lessonIds: [10] }]), status400);
  assert.throws(() => planLessonLayout(current, [{ id: 1, lessonIds: [10] }, { id: 1, lessonIds: [] }]), status400);
  assert.throws(() => planLessonLayout(current, [{ id: 1, lessonIds: [10] }, { id: 3, lessonIds: [] }]), status400);
  assert.throws(() => planLessonLayout(current, 'x'), status400);
  assert.throws(() => planLessonLayout(current, [{ id: 1, lessonIds: 'x' }, { id: 2, lessonIds: [] }]), status400);
  assert.throws(() => planLessonLayout(current, [{ lessonIds: [10] }, { id: 2, lessonIds: [] }]), status400);
});

test('isCloudinaryImageUrl acepta solo imágenes https del cloud configurado', () => {
  const ok = 'https://res.cloudinary.com/demo/image/upload/v1/streamly/courses/a.jpg';
  assert.equal(isCloudinaryImageUrl(ok, 'demo'), true);
  assert.equal(isCloudinaryImageUrl(ok.replace('https', 'http'), 'demo'), false);
  assert.equal(isCloudinaryImageUrl('https://example.com/demo/image/upload/a.jpg', 'demo'), false);
  assert.equal(isCloudinaryImageUrl('https://res.cloudinary.com.evil.com/demo/image/upload/a.jpg', 'demo'), false);
  assert.equal(isCloudinaryImageUrl(ok, 'otro'), false);
  assert.equal(isCloudinaryImageUrl('https://res.cloudinary.com/demo/raw/upload/a.pdf', 'demo'), false);
  assert.equal(isCloudinaryImageUrl('https://res.cloudinary.com/demo/video/upload/a.mp4', 'demo'), false);
  assert.equal(isCloudinaryImageUrl('https://user@res.cloudinary.com/demo/image/upload/a.jpg', 'demo'), false);
  assert.equal(isCloudinaryImageUrl('no es una url', 'demo'), false);
  assert.equal(isCloudinaryImageUrl(undefined, 'demo'), false);
  assert.equal(isCloudinaryImageUrl(ok, ''), false);
});

test('hasClassPrefix detecta títulos que ya empiezan por "Clase N"', () => {
  assert.equal(hasClassPrefix('Clase 3: Contratos'), true);
  assert.equal(hasClassPrefix('  clase3 - intro'), true);
  assert.equal(hasClassPrefix('CLASE 12'), true);
  assert.equal(hasClassPrefix('Introducción a la clase 3'), false);
  assert.equal(hasClassPrefix('Clase magistral'), false);
  assert.equal(hasClassPrefix(''), false);
  assert.equal(hasClassPrefix(null), false);
});

test('constantes del módulo', () => {
  assert.deepEqual([...DOCUMENT_CATEGORIES], ['terms', 'document', 'guide']);
  assert.equal(PROMO_IMAGE_LIMIT, 8);
});
