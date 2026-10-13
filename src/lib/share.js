// Lógica pura (sin env ni BD) para las páginas compartibles /c/:slug con Open Graph.

export const FALLBACK_OG_IMAGE = 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=1200&q=80';
export const SITE_NAME = 'Streamly Academia';
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SHARE_NOT_FOUND_MESSAGE = 'Curso no disponible.';

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

export function isValidSlug(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 180 && SLUG_PATTERN.test(value);
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function plainText(value) {
  if (typeof value !== 'string') return '';
  // Quita etiquetas, decodifica entidades una vez y vuelve a quitar lo que haya aparecido (&lt;b&gt;).
  const stripped = decodeEntities(value.replace(/<[^>]*>/g, ' ')).replace(/<[^>]*>/g, ' ');
  return stripped.replace(/\s+/g, ' ').trim();
}

export function summarizeDescription(subtitle, description, max = 200) {
  const limit = Math.min(Math.max(Number(max) || 200, 2), 200);
  const text = plainText(subtitle) || plainText(description);
  if (text.length <= limit) return text;
  const room = limit - 1; // espacio para '…'
  let cut = text.slice(0, room + 1);
  const lastSpace = cut.lastIndexOf(' ');
  cut = lastSpace > 0 ? cut.slice(0, lastSpace) : text.slice(0, room);
  return `${cut.replace(/[\s.,;:!?-]+$/, '')}…`;
}

export function safeImageUrl(value, fallback = FALLBACK_OG_IMAGE) {
  if (typeof value !== 'string') return fallback;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : fallback;
  } catch {
    return fallback;
  }
}

// HTML mínimo para rastreadores (WhatsApp/Facebook/LinkedIn no ejecutan JS). Sin <script>, sin estilos inline ni handlers.
export function buildSharePage({ course, appUrl, shareUrl, fallbackImage = FALLBACK_OG_IMAGE }) {
  const base = String(appUrl ?? '').replace(/\/+$/, '');
  const target = `${base}/curso/${course.slug}`;
  const title = plainText(course.title) || SITE_NAME;
  const description = summarizeDescription(course.subtitle, course.description) || `Curso en ${SITE_NAME}.`;
  const image = safeImageUrl(course.thumbnail_url || course.promo_image_url, safeImageUrl(fallbackImage, FALLBACK_OG_IMAGE));
  const e = escapeHtml;
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>${e(title)} | ${SITE_NAME}</title>
<meta name="description" content="${e(description)}">
<meta property="og:title" content="${e(title)}">
<meta property="og:description" content="${e(description)}">
<meta property="og:image" content="${e(image)}">
<meta property="og:url" content="${e(shareUrl)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:locale" content="es_MX">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${e(title)}">
<meta name="twitter:description" content="${e(description)}">
<meta name="twitter:image" content="${e(image)}">
<meta http-equiv="refresh" content="0;url=${e(target)}">
</head>
<body>
<p><a href="${e(target)}">Ir al curso</a></p>
</body>
</html>
`;
}

// Base pública del backend: PUBLIC_API_URL si existe; si no, el Host de la petición (entonces no se cachea públicamente).
export function resolveApiBase({ publicApiUrl, protocol, host }) {
  return String(publicApiUrl ?? `${protocol}://${host}`).replace(/\/+$/, '');
}

export const certificateShareUrl = (apiBase, code) => `${apiBase}/v/${encodeURIComponent(code)}`;
export const certificateBadgeUrl = (apiBase, code) => `${apiBase}/api/certificates/badge/${encodeURIComponent(code)}.png`;

export const CERTIFICATE_SHARE_NOT_FOUND = 'No encontramos una constancia con ese código.';
export const CERTIFICATE_BADGE_SIZE = 600;

// Vista previa Open Graph de una constancia (GET /v/:code). Solo datos ya públicos en /verificar: sin correo ni ids.
// `imageUrl` debe ser ABSOLUTA. Sin <script> ni handlers: la CSP de helmet los bloquearía y los rastreadores no los ejecutan.
export function buildCertificateSharePage({ certificate, code, appUrl, shareUrl, imageUrl }) {
  const base = String(appUrl ?? '').replace(/\/+$/, '');
  const target = `${base}/verificar/${encodeURIComponent(code)}`;
  const name = plainText(certificate.recipientName);
  const course = plainText(certificate.courseTitle) || SITE_NAME;
  const hours = Number(certificate.durationHours) > 0 ? ` · ${Number(certificate.durationHours)} horas` : '';
  const modality = plainText(certificate.modality);
  const title = `¡Obtuve mi constancia! · ${course}`;
  const description = `Constancia de ${name || 'una alumna'} por completar ${course}${hours}${modality ? ` · ${modality}` : ''}. Verifica su autenticidad.`;
  const alt = `Insignia de la constancia ${course}`;
  const e = escapeHtml;
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>${e(title)} | ${SITE_NAME}</title>
<meta name="robots" content="noindex">
<meta name="description" content="${e(description)}">
<meta property="og:title" content="${e(title)}">
<meta property="og:description" content="${e(description)}">
<meta property="og:image" content="${e(imageUrl)}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="${CERTIFICATE_BADGE_SIZE}">
<meta property="og:image:height" content="${CERTIFICATE_BADGE_SIZE}">
<meta property="og:image:alt" content="${e(alt)}">
<meta property="og:url" content="${e(shareUrl)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:locale" content="es_MX">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${e(title)}">
<meta name="twitter:description" content="${e(description)}">
<meta name="twitter:image" content="${e(imageUrl)}">
<meta name="twitter:image:alt" content="${e(alt)}">
<meta http-equiv="refresh" content="0;url=${e(target)}">
</head>
<body>
<p><a href="${e(target)}">Ver y verificar la constancia</a></p>
</body>
</html>
`;
}

export function buildCertificateShareNotFoundPage() {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>${escapeHtml(CERTIFICATE_SHARE_NOT_FOUND)} | ${SITE_NAME}</title>
<meta name="robots" content="noindex">
</head>
<body>
<p>${escapeHtml(CERTIFICATE_SHARE_NOT_FOUND)}</p>
</body>
</html>
`;
}

export function buildShareNotFoundPage() {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>${escapeHtml(SHARE_NOT_FOUND_MESSAGE)} | ${SITE_NAME}</title>
<meta name="robots" content="noindex">
</head>
<body>
<p>${escapeHtml(SHARE_NOT_FOUND_MESSAGE)}</p>
</body>
</html>
`;
}
