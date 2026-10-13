import assert from 'node:assert/strict';
import test from 'node:test';

import { isValidCertificateCode } from '../src/lib/certificates.js';
import {
  CERTIFICATE_SHARE_NOT_FOUND,
  FALLBACK_OG_IMAGE,
  buildCertificateShareNotFoundPage,
  buildCertificateSharePage,
  buildSharePage,
  certificateBadgeUrl,
  certificateShareUrl,
  escapeHtml,
  isValidSlug,
  resolveApiBase,
  safeImageUrl,
  summarizeDescription,
} from '../src/lib/share.js';

const baseCourse = {
  slug: 'derecho-digital',
  title: 'Derecho digital',
  subtitle: 'Aprende lo esencial',
  description: '<p>Descripción larga</p>',
  thumbnail_url: 'https://res.cloudinary.com/demo/image/upload/portada.jpg',
};
const pageOptions = { appUrl: 'https://app.example.com', shareUrl: 'https://api.example.com/c/derecho-digital' };

test('escapeHtml escapa & < > " \'', () => {
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  const escaped = escapeHtml('"><script>alert(1)</script>');
  assert.ok(!escaped.includes('<'));
  assert.ok(!escaped.includes('>'));
  assert.ok(!escaped.includes('"'));
});

test('escapeHtml convierte valores no string', () => {
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('isValidSlug acepta slugs normales', () => {
  for (const slug of ['a', 'curso', 'mujer-legal-tech', 'curso-2025', '2025']) assert.equal(isValidSlug(slug), true, slug);
  assert.equal(isValidSlug('a'.repeat(180)), true);
});

test('isValidSlug rechaza entradas peligrosas o mal formadas', () => {
  const bad = ['', 'Curso', '../x', 'a b', 'a--b', '-a', 'a-', 'a'.repeat(181), 'cañón', 'a/b', 'a_b', null, undefined, 5, {}, 'a\n'];
  for (const slug of bad) assert.equal(isValidSlug(slug), false, String(slug));
});

test('summarizeDescription prioriza el subtítulo', () => {
  assert.equal(summarizeDescription('Subtítulo', 'Descripción'), 'Subtítulo');
  assert.equal(summarizeDescription('   ', 'Descripción'), 'Descripción');
  assert.equal(summarizeDescription('', ''), '');
  assert.equal(summarizeDescription(null, undefined), '');
});

test('summarizeDescription quita HTML y entidades y colapsa espacios', () => {
  assert.equal(summarizeDescription('', '<p>Hola   <b>mundo</b></p>\n<br> &amp; adiós&nbsp;amigos'), 'Hola mundo & adiós amigos');
  assert.ok(!summarizeDescription('', '&lt;script&gt;alert(1)&lt;/script&gt; texto').includes('<'));
});

test('summarizeDescription recorta en límite de palabra sin pasar de 200', () => {
  const long = Array.from({ length: 80 }, (_, index) => `palabra${index}`).join(' ');
  const result = summarizeDescription('', long);
  assert.ok(result.length <= 200, `longitud ${result.length}`);
  assert.ok(result.endsWith('…'));
  const words = new Set(long.split(' '));
  for (const word of result.slice(0, -1).split(' ')) assert.ok(words.has(word), `palabra cortada: ${word}`);
  assert.ok(summarizeDescription('', 'x'.repeat(500)).length <= 200);
  assert.ok(summarizeDescription('', long, 999).length <= 200);
});

test('safeImageUrl solo permite http/https absolutas', () => {
  assert.equal(safeImageUrl('https://a.com/x.png', 'FB'), 'https://a.com/x.png');
  assert.equal(safeImageUrl('http://a.com/x.png', 'FB'), 'http://a.com/x.png');
  for (const value of ['javascript:alert(1)', 'data:image/png;base64,AAAA', '/img/x.png', '//a.com/x.png', '', null, undefined, 3]) {
    assert.equal(safeImageUrl(value, 'FB'), 'FB', String(value));
  }
});

test('buildSharePage incluye Open Graph, Twitter, meta refresh y enlace visible', () => {
  const html = buildSharePage({ course: baseCourse, ...pageOptions });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<html lang="es">/);
  assert.match(html, /<meta property="og:title" content="Derecho digital">/);
  assert.match(html, /<meta property="og:description" content="Aprende lo esencial">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/res\.cloudinary\.com\/demo\/image\/upload\/portada\.jpg">/);
  assert.match(html, /<meta property="og:url" content="https:\/\/api\.example\.com\/c\/derecho-digital">/);
  assert.match(html, /<meta property="og:type" content="website">/);
  assert.match(html, /<meta property="og:site_name" content="Streamly Academia">/);
  assert.match(html, /<meta property="og:locale" content="es_MX">/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(html, /<meta http-equiv="refresh" content="0;url=https:\/\/app\.example\.com\/curso\/derecho-digital">/);
  assert.match(html, /<a href="https:\/\/app\.example\.com\/curso\/derecho-digital">Ir al curso<\/a>/);
});

test('buildSharePage escapa un título malicioso y no incluye scripts', () => {
  const html = buildSharePage({
    course: { ...baseCourse, title: '"><script>alert(1)</script>', subtitle: '"><img src=x onerror=alert(1)>' },
    ...pageOptions,
  });
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('"><'));
  assert.ok(!/<img/i.test(html));
});

test('buildSharePage escapa también appUrl y shareUrl', () => {
  const html = buildSharePage({ course: baseCourse, appUrl: 'https://a.com/"><script>', shareUrl: 'https://b.com/"><script>x' });
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('"><'));
});

test('buildSharePage usa la imagen promocional y luego el fallback si la portada es inválida', () => {
  const promo = buildSharePage({ course: { ...baseCourse, thumbnail_url: null, promo_image_url: 'https://cdn.example.com/promo.jpg' }, ...pageOptions });
  assert.ok(promo.includes('content="https://cdn.example.com/promo.jpg"'));
  const invalid = buildSharePage({ course: { ...baseCourse, thumbnail_url: 'javascript:alert(1)' }, ...pageOptions });
  assert.ok(invalid.includes(`content="${escapeHtml(FALLBACK_OG_IMAGE)}"`));
  assert.ok(!invalid.includes('javascript:'));
  const none = buildSharePage({ course: { ...baseCourse, thumbnail_url: null }, ...pageOptions });
  assert.ok(none.includes(`content="${escapeHtml(FALLBACK_OG_IMAGE)}"`));
});

test('buildSharePage nunca contiene <script ni handlers inline', () => {
  for (const course of [baseCourse, { ...baseCourse, title: '', subtitle: '', description: '' }, { ...baseCourse, description: '<script>x</script>', subtitle: '' }]) {
    const html = buildSharePage({ course, ...pageOptions });
    assert.ok(!/<script/i.test(html));
    assert.ok(!/\son\w+=/i.test(html));
    assert.ok(!/style=/i.test(html));
  }
});

// ---------- GET /v/:code (vista previa Open Graph de la constancia) ----------
const certificate = { recipientName: 'María de los Ángeles Hernández', courseTitle: 'Mujer LegalTech', durationHours: 20, modality: '100% en línea' };
const certOptions = {
  certificate,
  code: 'MLT-ABCD-EF23',
  appUrl: 'https://app.example.com/',
  shareUrl: 'https://api.example.com/v/MLT-ABCD-EF23',
  imageUrl: 'https://api.example.com/api/certificates/badge/MLT-ABCD-EF23.png',
};

test('buildCertificateSharePage incluye Open Graph, Twitter, imagen absoluta 600x600 y meta refresh', () => {
  const html = buildCertificateSharePage(certOptions);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<meta property="og:title" content="¡Obtuve mi constancia! · Mujer LegalTech">/);
  assert.match(html, /<meta property="og:description" content="Constancia de María de los Ángeles Hernández por completar Mujer LegalTech · 20 horas · 100% en línea\. Verifica su autenticidad\.">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/api\.example\.com\/api\/certificates\/badge\/MLT-ABCD-EF23\.png">/);
  assert.match(html, /<meta property="og:image:width" content="600">/);
  assert.match(html, /<meta property="og:image:height" content="600">/);
  assert.match(html, /<meta property="og:image:alt" content="[^"]+">/);
  assert.match(html, /<meta property="og:url" content="https:\/\/api\.example\.com\/v\/MLT-ABCD-EF23">/);
  assert.match(html, /<meta property="og:type" content="website">/);
  assert.match(html, /<meta property="og:site_name" content="Streamly Academia">/);
  assert.match(html, /<meta property="og:locale" content="es_MX">/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(html, /<meta http-equiv="refresh" content="0;url=https:\/\/app\.example\.com\/verificar\/MLT-ABCD-EF23">/);
  assert.match(html, /<a href="https:\/\/app\.example\.com\/verificar\/MLT-ABCD-EF23">Ver y verificar la constancia<\/a>/);
});

test('buildCertificateSharePage escapa nombre, curso y URLs maliciosos y no incluye scripts', () => {
  const evil = '"><script>alert(1)</script>';
  const html = buildCertificateSharePage({
    ...certOptions,
    certificate: { ...certificate, recipientName: evil, courseTitle: `${evil} <img src=x onerror=alert(1)>`, modality: evil },
    appUrl: `https://a.com/${evil}`,
    shareUrl: `https://b.com/${evil}`,
    imageUrl: `https://c.com/${evil}`,
  });
  assert.ok(!/<script/i.test(html));
  assert.ok(!html.includes('"><'));
  assert.ok(!/<img/i.test(html));
  assert.ok(!/\son\w+=/i.test(html));
  assert.ok(!/style=/i.test(html));
});

test('buildCertificateSharePage omite horas ausentes y no expone correo ni ids', () => {
  const html = buildCertificateSharePage({ ...certOptions, certificate: { recipientName: 'Ana Pérez', courseTitle: 'Curso', email: 'ana@x.com', user_id: 7 } });
  assert.ok(html.includes('Constancia de Ana Pérez por completar Curso. Verifica su autenticidad.'));
  assert.ok(!html.includes('ana@x.com') && !/user_?id|course_?id/i.test(html));
});

test('buildCertificateShareNotFoundPage es genérica y sin scripts', () => {
  const html = buildCertificateShareNotFoundPage();
  assert.ok(html.includes(CERTIFICATE_SHARE_NOT_FOUND));
  assert.ok(!/<script/i.test(html));
  assert.ok(!html.includes('og:'));
});

test('resolveApiBase usa PUBLIC_API_URL o, si falta, el host de la petición; sin barra final', () => {
  assert.equal(resolveApiBase({ publicApiUrl: 'https://api.example.com//', protocol: 'http', host: 'x:1' }), 'https://api.example.com');
  assert.equal(resolveApiBase({ publicApiUrl: undefined, protocol: 'http', host: '127.0.0.1:3112' }), 'http://127.0.0.1:3112');
  assert.equal(resolveApiBase({ publicApiUrl: null, protocol: 'https', host: 'api.example.com' }), 'https://api.example.com');
});

test('certificateShareUrl y certificateBadgeUrl son absolutas', () => {
  assert.equal(certificateShareUrl('https://api.example.com', 'MLT-ABCD-EF23'), 'https://api.example.com/v/MLT-ABCD-EF23');
  assert.equal(certificateBadgeUrl('https://api.example.com', 'MLT-ABCD-EF23'), 'https://api.example.com/api/certificates/badge/MLT-ABCD-EF23.png');
});

test('los códigos mal formados se rechazan con la misma regla que verify (404 genérico en /v/)', () => {
  for (const bad of ['', 'abc!!', '<script>', 'MLT', 'MLT_ZZZZ_ZZZZ', 'A'.repeat(60), '../x']) {
    assert.equal(isValidCertificateCode(bad), false, bad);
  }
  assert.equal(isValidCertificateCode('mlt-abcd-ef23'), true);
});
