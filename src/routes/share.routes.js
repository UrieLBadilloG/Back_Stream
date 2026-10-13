import { Router } from 'express';

import { pool } from '../config/database.js';
import { env } from '../config/env.js';
import { CERTIFICATE_TEMPLATES } from '../lib/certificate-pdf.js';
import { isValidCertificateCode, normalizeCertificateCode } from '../lib/certificates.js';
import {
  FALLBACK_OG_IMAGE,
  buildCertificateShareNotFoundPage,
  buildCertificateSharePage,
  buildSharePage,
  buildShareNotFoundPage,
  certificateBadgeUrl,
  certificateShareUrl,
  isValidSlug,
  resolveApiBase,
} from '../lib/share.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import { findCertificateByCode } from './certificates-public.routes.js';

// GET /c/:slug — HTML mínimo con Open Graph para WhatsApp/Facebook/LinkedIn (no ejecutan JS).
export const shareRouter = Router();
// GET /v/:code — lo mismo para una constancia emitida (vista previa con la insignia).
export const certificateShareRouter = Router();
// GET /api/share/config — datos que el frontend no conoce (PUBLIC_API_URL).
export const shareConfigRouter = Router();

const shareLimiter = createRateLimiter({ windowMs: 60000, max: 120, keyFn: (request) => `share:${request.ip}` });
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function sendNotFound(response) {
  response.status(404).set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).send(buildShareNotFoundPage());
}

shareRouter.get('/:slug', shareLimiter, async (request, response) => {
  const slug = request.params.slug;
  if (!isValidSlug(slug)) return sendNotFound(response);
  const [rows] = await pool.execute(
    `SELECT c.slug, c.title, c.subtitle, c.description, c.thumbnail_url,
      (SELECT i.image_url FROM course_promo_images i WHERE i.course_id = c.id ORDER BY i.position ASC, i.id ASC LIMIT 1) AS promo_image_url
     FROM courses c WHERE c.slug = ? AND c.status = 'published' LIMIT 1`,
    [slug],
  );
  const course = rows[0];
  if (!course) return sendNotFound(response);
  // Sin PUBLIC_API_URL el host viene del cliente: no se cachea públicamente para evitar envenenar proxies/CDN.
  const hostDerived = !env.payments.publicApiUrl;
  const apiBase = (env.payments.publicApiUrl ?? `${request.protocol}://${request.get('host')}`).replace(/\/+$/, '');
  const html = buildSharePage({
    course,
    appUrl: env.payments.appUrl,
    shareUrl: `${apiBase}/c/${course.slug}`,
    fallbackImage: FALLBACK_OG_IMAGE,
  });
  response.status(200).set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': hostDerived ? 'no-store' : 'public, max-age=60' }).send(html);
});

certificateShareRouter.get('/:code', shareLimiter, async (request, response) => {
  const notFound = () => response.status(404).set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }).send(buildCertificateShareNotFoundPage());
  const code = normalizeCertificateCode(request.params.code);
  if (!isValidCertificateCode(code)) return notFound();
  const row = await findCertificateByCode(code);
  if (!row) return notFound();
  const template = CERTIFICATE_TEMPLATES[row.template];
  // Sin PUBLIC_API_URL el host viene del cliente: no se cachea públicamente (mismo criterio que /c/:slug).
  const hostDerived = !env.payments.publicApiUrl;
  const apiBase = resolveApiBase({ publicApiUrl: env.payments.publicApiUrl, protocol: request.protocol, host: request.get('host') });
  const html = buildCertificateSharePage({
    certificate: {
      recipientName: row.recipient_name,
      courseTitle: row.course_title,
      durationHours: template?.durationHours,
      modality: template?.modality,
    },
    code: row.certificate_code,
    appUrl: env.payments.appUrl,
    shareUrl: certificateShareUrl(apiBase, row.certificate_code),
    imageUrl: certificateBadgeUrl(apiBase, row.certificate_code),
  });
  response.status(200).set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': hostDerived ? 'no-store' : 'public, max-age=300', 'X-Robots-Tag': 'noindex' }).send(html);
});

function isPublicHost(value) {
  if (!value) return false;
  try {
    return !LOCAL_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

shareConfigRouter.get('/config', (_request, response) => {
  const { appUrl, publicApiUrl } = env.payments;
  response.json({ appUrl, publicApiUrl: publicApiUrl ?? null, previewAvailable: isPublicHost(publicApiUrl) });
});
