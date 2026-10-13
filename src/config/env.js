import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const requiredVariables = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'JWT_SECRET', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
const missingVariables = requiredVariables.filter((name) => !process.env[name]);

if (missingVariables.length > 0) {
  throw new Error(
    `Faltan variables de entorno obligatorias: ${missingVariables.join(', ')}`,
  );
}

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} debe ser un número entero positivo`);
  }

  return value;
}

function optionalValue(name) {
  const value = String(process.env[name] ?? '').trim();
  return value || null;
}

function optionalUrl(name) {
  const value = optionalValue(name);
  if (!value) return null;
  try {
    return new URL(value).toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function resolveAppUrl() {
  const explicit = optionalUrl('APP_URL') ?? optionalUrl('FRONTEND_URL');
  if (explicit) return explicit;
  const origins = String(process.env.CORS_ORIGIN ?? '').split(',').map((item) => item.trim()).filter((item) => item && item !== '*');
  for (const origin of origins) {
    try {
      return new URL(origin).toString().replace(/\/+$/, '');
    } catch {
      // Se ignora el origen inválido y se prueba el siguiente.
    }
  }
  return 'http://localhost:5173';
}

const isProduction = (process.env.NODE_ENV ?? 'development') === 'production';

// Solo para pruebas locales (servidor falso de Mercado Pago). En producción se ignora siempre.
function resolveMercadoPagoBaseUrl() {
  const configured = optionalUrl('MERCADOPAGO_API_BASE_URL');
  return { url: isProduction ? null : configured, ignored: isProduction && Boolean(optionalValue('MERCADOPAGO_API_BASE_URL')) };
}

// TRUST_PROXY: número de saltos (1 = un proxy delante) o lista de loopback|linklocal|uniquelocal. Vacío = desactivado.
// Nunca se acepta "true": confiaría en cualquier X-Forwarded-For y permitiría falsificar la IP.
function resolveTrustProxy() {
  const raw = optionalValue('TRUST_PROXY');
  if (!raw) return false;
  const value = raw.toLowerCase();
  if (value === 'false' || value === '0') return false;
  if (/^\d{1,2}$/.test(value)) return Number(value);
  const keywords = value.split(',').map((item) => item.trim());
  if (keywords.every((item) => ['loopback', 'linklocal', 'uniquelocal'].includes(item))) return keywords.join(',');
  throw new Error('TRUST_PROXY debe ser un número de saltos (p. ej. 1) o loopback, linklocal, uniquelocal');
}

const mercadoPagoBase = resolveMercadoPagoBaseUrl();

export const env = Object.freeze({
  payments: Object.freeze({
    mercadoPago: Object.freeze({
      accessToken: optionalValue('MERCADOPAGO_ACCESS_TOKEN'),
      publicKey: optionalValue('MERCADOPAGO_PUBLIC_KEY'),
      webhookSecret: optionalValue('MERCADOPAGO_WEBHOOK_SECRET'),
      apiBaseUrl: mercadoPagoBase.url,
      apiBaseUrlIgnored: mercadoPagoBase.ignored,
    }),
    publicApiUrl: optionalUrl('PUBLIC_API_URL'),
    appUrl: resolveAppUrl(),
  }),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  trustProxy: resolveTrustProxy(),
  port: positiveInteger('PORT', 3000),
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  auth: Object.freeze({
    jwtSecret: process.env.JWT_SECRET,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '8h',
  }),
  cloudinary: Object.freeze({
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET,
    uploadFolder: process.env.CLOUDINARY_UPLOAD_FOLDER ?? 'streamly/courses',
  }),
  db: Object.freeze({
    host: process.env.DB_HOST,
    port: positiveInteger('DB_PORT', 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    name: process.env.DB_NAME,
    connectionLimit: positiveInteger('DB_CONNECTION_LIMIT', 5),
    connectTimeoutMs: positiveInteger('DB_CONNECT_TIMEOUT_MS', 10000),
  }),
});
