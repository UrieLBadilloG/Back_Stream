import assert from 'node:assert/strict';
import test from 'node:test';

import { CERTIFICATE_TEMPLATES } from '../src/lib/certificate-pdf.js';
import {
  VERIFY_NOT_FOUND_MESSAGE,
  buildVerifyPayload,
  generateCertificateCode,
  isValidCertificateCode,
  normalizeCertificateCode,
} from '../src/lib/certificates.js';

const template = CERTIFICATE_TEMPLATES['mujer-legaltech'];

const row = {
  certificate_code: 'MLT-ABCD-EF23',
  recipient_name: 'María de los Ángeles Hernández',
  issued_at: new Date('2025-03-15T12:00:00Z'),
  course_title: 'Mujer LegalTech',
  instructor_name: 'Ana Instructora',
  owner_name: 'Dueña del curso',
};

test('normalizeCertificateCode recorta, pasa a mayúsculas y vacía otros tipos', () => {
  assert.equal(normalizeCertificateCode('  mlt-abcd-ef23 '), 'MLT-ABCD-EF23');
  assert.equal(normalizeCertificateCode(null), '');
  assert.equal(normalizeCertificateCode(undefined), '');
  assert.equal(normalizeCertificateCode(123), '');
  assert.equal(normalizeCertificateCode({}), '');
});

test('isValidCertificateCode acepta códigos bien formados', () => {
  assert.equal(isValidCertificateCode('MLT-ABCD-EF23'), true);
  assert.equal(isValidCertificateCode('mlt-abcd-ef23'), true);
  assert.equal(isValidCertificateCode('AB-CDE'), true);
  assert.equal(isValidCertificateCode('MLT-ABCD-EF23-GHIJ'), true);
});

test('isValidCertificateCode rechaza códigos mal formados', () => {
  for (const bad of [
    '',
    null,
    undefined,
    42,
    'MLT',
    'MLT-ABCD-EF23-GHIJ-KLMN',
    'MLT ABCD EF23',
    'MLT-ABCD EF23',
    'MLT-ABC D-EF23',
    'MLT-AB$D-EF23',
    '<script>',
    '<script>alert(1)</script>',
    'MLT_ABCD_EF23',
    'MLT-ABCD-EF23\nMLT-ABCD-EF23',
    'MLT-ABCD\n-EF23',
    `MLT-${'A'.repeat(40)}`,
    'MLT--ABCD',
    '-MLT-ABCD',
    'MLT-ABCD-',
    'MLT-AB-EF23',
  ]) {
    assert.equal(isValidCertificateCode(bad), false, `debería rechazar ${JSON.stringify(bad)}`);
  }
});

test('isValidCertificateCode rechaza longitudes superiores a 32 aunque cumplan el patrón por grupos', () => {
  const long = 'ABCDEFGH-ABCDEFGH-ABCDEFGH-ABCDEFGH';
  assert.ok(long.length > 32);
  assert.equal(isValidCertificateCode(long), false);
});

test('buildVerifyPayload devuelve exactamente las claves públicas', () => {
  const payload = buildVerifyPayload({ row, template });
  assert.deepEqual(Object.keys(payload).sort(), [
    'certificateCode',
    'courseTitle',
    'durationHours',
    'instructorName',
    'issuedAt',
    'issuer',
    'modality',
    'recipientName',
    'valid',
  ]);
  assert.equal(payload.valid, true);
  assert.equal(payload.recipientName, row.recipient_name);
  assert.equal(payload.courseTitle, 'Mujer LegalTech');
  assert.equal(payload.certificateCode, 'MLT-ABCD-EF23');
  assert.equal(payload.issuer, 'Mujer LegalTech en México');
  assert.equal(payload.durationHours, 20);
  assert.equal(payload.modality, '100% en línea');
  assert.equal(payload.issuedAt, '2025-03-15T12:00:00.000Z');
  assert.equal(new Date(payload.issuedAt).toISOString(), payload.issuedAt);
});

test('buildVerifyPayload usa el instructor del curso o, si falta, el dueño', () => {
  assert.equal(buildVerifyPayload({ row, template }).instructorName, 'Ana Instructora');
  assert.equal(buildVerifyPayload({ row: { ...row, instructor_name: null }, template }).instructorName, 'Dueña del curso');
  assert.equal(buildVerifyPayload({ row: { ...row, instructor_name: '' }, template }).instructorName, 'Dueña del curso');
});

test('buildVerifyPayload no filtra datos privados', () => {
  const dirty = { ...row, email: 'a@b.mx', user_id: 7, course_id: 9, payment_id: 3, userId: 7, courseId: 9 };
  const text = JSON.stringify(buildVerifyPayload({ row: dirty, template }));
  for (const forbidden of ['email', 'user_id', 'course_id', 'userId', 'courseId', 'payment', 'a@b.mx']) {
    assert.equal(text.includes(forbidden), false, `no debe incluir ${forbidden}`);
  }
});

test('buildVerifyPayload con plantilla desconocida usa el emisor genérico', () => {
  const payload = buildVerifyPayload({ row, template: undefined });
  assert.equal(payload.issuer, 'Streamly Academia');
  assert.equal(payload.durationHours, null);
  assert.equal(payload.modality, null);
});

test('la plantilla mujer-legaltech declara metadatos e insignia', () => {
  assert.equal(template.issuer, 'Mujer LegalTech en México');
  assert.equal(template.durationHours, 20);
  assert.ok(template.badgeUrl.pathname.endsWith('/assets/badges/mujer-legaltech.png'));
});

test('generateCertificateCode siempre produce un código válido', () => {
  for (let index = 0; index < 200; index += 1) {
    const code = generateCertificateCode('MLT');
    assert.equal(isValidCertificateCode(code), true, code);
  }
});

test('el mensaje de no encontrada es el texto acordado', () => {
  assert.equal(VERIFY_NOT_FOUND_MESSAGE, 'No encontramos una constancia con ese código.');
});
