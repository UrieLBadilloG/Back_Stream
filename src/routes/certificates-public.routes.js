import { readFile } from 'node:fs/promises';

import { Router } from 'express';

import { pool } from '../config/database.js';
import { CERTIFICATE_TEMPLATES } from '../lib/certificate-pdf.js';
import {
  VERIFY_NOT_FOUND_MESSAGE,
  buildVerifyPayload,
  isValidCertificateCode,
  normalizeCertificateCode,
} from '../lib/certificates.js';
import { httpError } from '../lib/http-error.js';
import { createRateLimiter } from '../middleware/rate-limit.js';

// Rutas PÚBLICAS (sin sesión) para verificar una constancia por su código y servir su insignia.
export const certificatePublicRouter = Router();

const verifyLimiter = createRateLimiter({ windowMs: 60000, max: 30, keyFn: (request) => `verify:${request.ip}` });
const badgeLimiter = createRateLimiter({ windowMs: 60000, max: 120, keyFn: (request) => `badge:${request.ip}` });

const badgeCache = new Map();

export async function findCertificateByCode(code) {
  const [rows] = await pool.execute(
    `SELECT ct.certificate_code, ct.recipient_name, ct.issued_at, ct.template,
            c.title AS course_title, c.instructor_name, owner.full_name AS owner_name
     FROM certificates ct
     JOIN courses c ON c.id = ct.course_id
     JOIN users owner ON owner.id = c.owner_id
     WHERE ct.certificate_code = ? LIMIT 1`,
    [code],
  );
  return rows[0] ?? null;
}

async function readBadge(url) {
  if (!badgeCache.has(url.href)) {
    badgeCache.set(
      url.href,
      readFile(url).catch((error) => {
        badgeCache.delete(url.href);
        throw error;
      }),
    );
  }
  return badgeCache.get(url.href);
}

certificatePublicRouter.get('/verify/:code', verifyLimiter, async (request, response) => {
  const code = normalizeCertificateCode(request.params.code);
  if (!isValidCertificateCode(code)) throw httpError(404, VERIFY_NOT_FOUND_MESSAGE);
  const row = await findCertificateByCode(code);
  if (!row) throw httpError(404, VERIFY_NOT_FOUND_MESSAGE);
  response.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  response.json(buildVerifyPayload({ row, template: CERTIFICATE_TEMPLATES[row.template] }));
});

certificatePublicRouter.get('/badge/:file', badgeLimiter, async (request, response) => {
  const match = /^(.+)\.png$/i.exec(String(request.params.file ?? ''));
  const code = match ? normalizeCertificateCode(match[1]) : '';
  if (!isValidCertificateCode(code)) throw httpError(404, VERIFY_NOT_FOUND_MESSAGE);
  const row = await findCertificateByCode(code);
  const template = row ? CERTIFICATE_TEMPLATES[row.template] : null;
  if (!template?.badgeUrl) throw httpError(404, VERIFY_NOT_FOUND_MESSAGE);
  let bytes;
  try {
    bytes = await readBadge(template.badgeUrl);
  } catch {
    throw httpError(404, VERIFY_NOT_FOUND_MESSAGE);
  }
  // helmet() fija Cross-Origin-Resource-Policy: same-origin; el frontend vive en otro origen.
  response.set({
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=3600',
    'Content-Disposition': 'inline',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Robots-Tag': 'noindex',
  });
  response.status(200).end(bytes);
});
