const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0)$/i;

function isLocalUrl(value) {
  try {
    return LOCAL_HOST.test(new URL(String(value)).hostname);
  } catch {
    return false;
  }
}

// Módulo puro: devuelve avisos (texto sin valores ni secretos) sobre una configuración de producción incompleta.
export function collectStartupWarnings(env) {
  const warnings = [];
  const mp = env.payments.mercadoPago;
  if (mp.apiBaseUrlIgnored) warnings.push('MERCADOPAGO_API_BASE_URL está definida pero se ignora en producción.');
  if (env.nodeEnv !== 'production' || !mp.accessToken) return warnings;
  if (!mp.webhookSecret) warnings.push('Producción: falta MERCADOPAGO_WEBHOOK_SECRET; el webhook de Mercado Pago aceptaría llamadas sin firma.');
  if (!env.payments.publicApiUrl) warnings.push('Producción: falta PUBLIC_API_URL (https); Mercado Pago no recibirá notification_url y dependerás solo de la verificación al volver al sitio.');
  const origins = String(env.corsOrigin ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  if (isLocalUrl(env.payments.appUrl) || origins.some(isLocalUrl)) warnings.push('Producción: APP_URL o CORS_ORIGIN apuntan a localhost; las back_urls de pago no volverán a tu sitio.');
  if (env.trustProxy === false) warnings.push('Producción: TRUST_PROXY no está definido; si el backend está detrás de un proxy, el límite de peticiones verá una sola IP.');
  return warnings;
}
