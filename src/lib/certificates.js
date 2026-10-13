import { randomInt } from 'node:crypto';

import { httpError } from './http-error.js';

// Lógica pura de constancias (sin env ni base de datos): validación del nombre, elegibilidad y códigos.

export const NAME_MIN_LENGTH = 3;
export const NAME_MAX_LENGTH = 80;

const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}' .\-’]*$/u;
const CONTROL_CHARS = /[\p{Cc}\u2028\u2029]/u;
const LOWERCASE_CONNECTORS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e']);

// Código sin caracteres ambiguos (sin I, L, O, 0, 1).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function validateRecipientName(value) {
  if (typeof value !== 'string') throw httpError(400, 'Escribe el nombre que aparecerá en la constancia.');
  const raw = value.normalize('NFC').trim();
  if (CONTROL_CHARS.test(raw)) throw httpError(400, 'El nombre no puede contener saltos de línea ni caracteres de control.');
  const name = raw.replace(/\s+/g, ' ');
  if ([...name].length < NAME_MIN_LENGTH) throw httpError(400, `El nombre debe tener al menos ${NAME_MIN_LENGTH} caracteres.`);
  if ([...name].length > NAME_MAX_LENGTH) throw httpError(400, `El nombre no puede superar ${NAME_MAX_LENGTH} caracteres.`);
  if (!NAME_PATTERN.test(name)) {
    throw httpError(400, 'El nombre solo puede contener letras, espacios, apóstrofes, guiones y puntos.');
  }
  return name;
}

function capitalizeWord(word) {
  // Mayúscula tras el inicio de palabra, guion o apóstrofe (Hernández-Peñaloza, D'Angelo).
  return word.toLowerCase().replace(/(^|[-'’])(\p{L})/gu, (_match, prefix, letter) => prefix + letter.toUpperCase());
}

// Title Case SOLO si todo viene en mayúsculas o todo en minúsculas; un nombre mixto se respeta.
export function formatNameForCertificate(name) {
  const text = String(name ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
  if (text !== text.toUpperCase() && text !== text.toLowerCase()) return text;
  return text
    .split(' ')
    .map((word, index) => {
      const lower = word.toLowerCase();
      return index > 0 && LOWERCASE_CONNECTORS.has(lower) ? lower : capitalizeWord(word);
    })
    .join(' ');
}

// El vencimiento del acceso NO bloquea la descarga: elegible = inscrito + 100 % de las clases.
export function evaluateCertificateEligibility({ enrolled, totalLessons, completedLessons }) {
  const total = Number(totalLessons) || 0;
  const completed = Number(completedLessons) || 0;
  if (!enrolled) return { eligible: false, reason: 'not_enrolled' };
  if (total <= 0) return { eligible: false, reason: 'no_lessons' };
  if (completed < total) return { eligible: false, reason: 'incomplete' };
  return { eligible: true, reason: null };
}

export function generateCertificateCode(prefix = 'MLT') {
  const pick = () => Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  return `${prefix}-${pick()}-${pick()}`;
}

export const VERIFY_NOT_FOUND_MESSAGE = 'No encontramos una constancia con ese código.';

// Prefijo (2-8) y 1-3 grupos (3-8), solo A-Z/0-9, longitud total <= 32.
export const CERTIFICATE_CODE_PATTERN = /^[A-Z0-9]{2,8}(?:-[A-Z0-9]{3,8}){1,3}$/;
const CERTIFICATE_CODE_MAX_LENGTH = 32;

export function normalizeCertificateCode(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

export function isValidCertificateCode(value) {
  const code = normalizeCertificateCode(value);
  return code.length <= CERTIFICATE_CODE_MAX_LENGTH && CERTIFICATE_CODE_PATTERN.test(code);
}

// Payload público mínimo de verificación: nunca incluye ids internos, correo ni pagos.
export function buildVerifyPayload({ row, template }) {
  return {
    valid: true,
    recipientName: row.recipient_name,
    courseTitle: row.course_title,
    issuer: template?.issuer ?? 'Streamly Academia',
    issuedAt: new Date(row.issued_at).toISOString(),
    durationHours: template?.durationHours ?? null,
    modality: template?.modality ?? null,
    certificateCode: row.certificate_code,
    instructorName: row.instructor_name || row.owner_name || null,
  };
}

function asciiFilename(filename) {
  const ascii = String(filename)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return ascii || 'constancia.pdf';
}

export function certificateContentDisposition(filename) {
  const safe = asciiFilename(filename);
  if (safe === filename) return `attachment; filename="${safe}"`;
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
}
