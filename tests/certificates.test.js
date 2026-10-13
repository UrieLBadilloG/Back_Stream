import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PDFDocument } from 'pdf-lib';

import { CERTIFICATE_TEMPLATES, generateCertificatePdf } from '../src/lib/certificate-pdf.js';
import {
  certificateContentDisposition,
  evaluateCertificateEligibility,
  formatNameForCertificate,
  generateCertificateCode,
  validateRecipientName,
} from '../src/lib/certificates.js';

const template = CERTIFICATE_TEMPLATES['mujer-legaltech'];

test('validateRecipientName acepta nombres válidos y normaliza espacios', () => {
  assert.equal(validateRecipientName('  María   de los Ángeles  '), 'María de los Ángeles');
  assert.equal(validateRecipientName('Begoña Muñoz'), 'Begoña Muñoz');
  assert.equal(validateRecipientName("Sinéad O'Connor"), "Sinéad O'Connor");
  assert.equal(validateRecipientName('Ana-Lucía Díaz'), 'Ana-Lucía Díaz');
  assert.equal(validateRecipientName('Ma. Elena Ruiz'), 'Ma. Elena Ruiz');
  assert.equal(validateRecipientName('Ana O’Neil'), 'Ana O’Neil');
  // NFC: "e" + acento combinante queda como una sola letra.
  assert.equal(validateRecipientName('Jose\u0301 Pe\u0301rez'), 'José Pérez');
});

test('validateRecipientName rechaza nombres inválidos con 400', () => {
  const invalid = ['', '   ', 'Al', 'A'.repeat(81), 'Ana 2', 'Ana\nDíaz', 'Ana\r\nDíaz', 'Ana 😀 Díaz', '-Ana', 'Ana <b>', 42, null, undefined];
  for (const value of invalid) {
    assert.throws(() => validateRecipientName(value), (error) => error.statusCode === 400, `debería rechazar ${JSON.stringify(value)}`);
  }
  assert.equal(validateRecipientName('A'.repeat(80)).length, 80);
});

test('formatNameForCertificate aplica Title Case solo a todo mayúsculas o todo minúsculas', () => {
  assert.equal(formatNameForCertificate('MARÍA DE LOS ÁNGELES HERNÁNDEZ-PEÑALOZA'), 'María de los Ángeles Hernández-Peñaloza');
  assert.equal(formatNameForCertificate('ana díaz y lópez'), 'Ana Díaz y López');
  assert.equal(formatNameForCertificate("SINÉAD O'CONNOR"), "Sinéad O'Connor");
  assert.equal(formatNameForCertificate('María de la Luz'), 'María de la Luz');
  assert.equal(formatNameForCertificate('ANA McDONALD'), 'ANA McDONALD');
  assert.equal(formatNameForCertificate('DE LA CRUZ'), 'De la Cruz');
});

test('evaluateCertificateEligibility exige inscripción y 100 % de clases', () => {
  assert.equal(evaluateCertificateEligibility({ enrolled: true, totalLessons: 0, completedLessons: 0 }).eligible, false);
  assert.equal(evaluateCertificateEligibility({ enrolled: true, totalLessons: 7, completedLessons: 3 }).eligible, false);
  assert.equal(evaluateCertificateEligibility({ enrolled: true, totalLessons: 7, completedLessons: 7 }).eligible, true);
  assert.equal(evaluateCertificateEligibility({ enrolled: false, totalLessons: 7, completedLessons: 7 }).eligible, false);
  assert.equal(evaluateCertificateEligibility({ enrolled: false, totalLessons: 7, completedLessons: 7 }).reason, 'not_enrolled');
  // El vencimiento del acceso no entra en la regla: inscrito + completo = elegible.
  assert.equal(evaluateCertificateEligibility({ enrolled: true, totalLessons: 7, completedLessons: 7, accessExpired: true }).eligible, true);
});

test('generateCertificateCode produce MLT-XXXX-XXXX sin ambiguos y único', () => {
  const seen = new Set();
  for (let index = 0; index < 1000; index += 1) {
    const code = generateCertificateCode('MLT');
    assert.match(code, /^MLT-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    seen.add(code);
  }
  assert.equal(seen.size, 1000);
});

test('certificateContentDisposition escapa nombres con acentos', () => {
  assert.equal(certificateContentDisposition('Constancia-Mujer-LegalTech.pdf'), 'attachment; filename="Constancia-Mujer-LegalTech.pdf"');
  const header = certificateContentDisposition('Constancia María Ñandú.pdf');
  assert.match(header, /^attachment; filename="Constancia_Maria_Nandu\.pdf"; filename\*=UTF-8''Constancia%20Mar%C3%ADa%20%C3%91and%C3%BA\.pdf$/);
  assert.doesNotMatch(header, /[^\x20-\x7e]/);
});

test('generateCertificatePdf genera un PDF de una página con el tamaño de la plantilla', async () => {
  const templateDoc = await PDFDocument.load(await readFile(template.pdfUrl));
  const expected = templateDoc.getPage(0).getSize();
  const issuedAt = new Date('2025-01-02T03:04:05Z');
  const names = ['Ana Díaz', 'María de los Ángeles Hernández-Peñaloza Ordóñez', 'BEGOÑA MUÑOZ', 'A'.repeat(3)];
  for (const recipientName of names) {
    const bytes = await generateCertificatePdf({ template: 'mujer-legaltech', recipientName, certificateCode: 'MLT-ABCD-2345', issuedAt });
    assert.equal(Buffer.from(bytes.subarray(0, 5)).toString('latin1'), '%PDF-');
    const doc = await PDFDocument.load(bytes);
    assert.equal(doc.getPageCount(), 1);
    assert.deepEqual(doc.getPage(0).getSize(), expected);
    assert.equal(doc.getTitle(), 'Constancia Mujer LegalTech');
    assert.equal(doc.getAuthor(), 'Streamly Academia');
    assert.match(doc.getKeywords(), /MLT-ABCD-2345/);
  }
});

test('generateCertificatePdf rechaza glifos no soportados y nombres demasiado largos con 400', async () => {
  const is400 = (error) => error.statusCode === 400;
  await assert.rejects(generateCertificatePdf({ template: 'mujer-legaltech', recipientName: 'Ana Дíaz' }), is400);
  await assert.rejects(generateCertificatePdf({ template: 'mujer-legaltech', recipientName: 'W'.repeat(80) }), is400);
  await assert.rejects(generateCertificatePdf({ template: 'mujer-legaltech', recipientName: 'Ana 2' }), is400);
  await assert.rejects(generateCertificatePdf({ template: 'otra', recipientName: 'Ana Díaz' }), (error) => error.statusCode === 404);
});
