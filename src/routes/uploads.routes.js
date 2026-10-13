import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { Router } from 'express';

import { cloudinary } from '../config/cloudinary.js';
import { env } from '../config/env.js';
import { assert, httpError } from '../lib/http-error.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

export const uploadsRouter = Router();

uploadsRouter.post(
  '/signature',
  requireAuth,
  requireRole('admin', 'super_admin'),
  (request, response) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const parameters = {
      folder: env.cloudinary.uploadFolder,
      timestamp,
    };

    response.json({
      upload: {
        cloudName: env.cloudinary.cloudName,
        apiKey: env.cloudinary.apiKey,
        folder: env.cloudinary.uploadFolder,
        timestamp,
        signature: cloudinary.utils.api_sign_request(
          parameters,
          env.cloudinary.apiSecret,
        ),
      },
    });
  },
);

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function isPrivateAddress(address) {
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) return isPrivateAddress(normalized.slice(7));
  if (isIP(normalized) === 6) {
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb');
  }
  if (isIP(normalized) !== 4) return true;
  const [a, b] = normalized.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
}

async function validateRemoteUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw httpError(400, 'Escribe una URL de imagen válida.'); }
  assert(url.protocol === 'https:', 400, 'La URL debe usar HTTPS.');
  assert(!url.username && !url.password, 400, 'La URL no puede incluir credenciales.');
  assert(!url.port || url.port === '443', 400, 'La URL debe usar el puerto HTTPS estándar.');
  const addresses = await lookup(url.hostname, { all: true, verbatim: true }).catch(() => []);
  assert(addresses.length > 0, 400, 'No se pudo resolver el servidor de la imagen.');
  assert(addresses.every(({ address }) => !isPrivateAddress(address)), 400, 'No se permiten direcciones privadas o locales.');
  return url;
}

async function fetchRemoteImage(value) {
  let url = await validateRemoteUrl(value);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const remote = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(12_000), headers: { Accept: 'image/jpeg,image/png,image/webp', 'User-Agent': 'Streamly-Image-Importer/1.0' } });
    if (remote.status >= 300 && remote.status < 400) {
      const location = remote.headers.get('location');
      assert(location && redirects < 3, 400, 'La URL tiene demasiadas redirecciones.');
      url = await validateRemoteUrl(new URL(location, url).href);
      continue;
    }
    assert(remote.ok, 400, `El servidor de la imagen respondió con estado ${remote.status}.`);
    const contentType = String(remote.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    assert(IMAGE_TYPES.has(contentType), 400, 'La URL no contiene una imagen JPG, PNG o WebP.');
    const declaredSize = Number(remote.headers.get('content-length') || 0);
    assert(!declaredSize || declaredSize <= MAX_IMAGE_BYTES, 413, 'La imagen no puede superar 8 MB.');
    const reader = remote.body?.getReader();
    assert(reader, 400, 'No se pudo leer la imagen remota.');
    const chunks = []; let size = 0;
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      size += chunk.byteLength;
      if (size > MAX_IMAGE_BYTES) { await reader.cancel(); throw httpError(413, 'La imagen no puede superar 8 MB.'); }
      chunks.push(Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);
    return { dataUrl: `data:${contentType};base64,${buffer.toString('base64')}`, contentType, size, sourceHost: url.hostname };
  }
  throw httpError(400, 'No se pudo descargar la imagen.');
}

uploadsRouter.post('/image-source', requireAuth, requireRole('admin', 'super_admin'), async (request, response) => {
  const url = String(request.body?.url || '').trim();
  assert(url.length > 0 && url.length <= 2048, 400, 'La URL es obligatoria y no puede superar 2048 caracteres.');
  response.json({ image: await fetchRemoteImage(url) });
});
