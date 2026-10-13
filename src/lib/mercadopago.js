import { createHmac, timingSafeEqual } from 'node:crypto';

import { httpError } from './http-error.js';

// Módulo puro: no importa env ni la base de datos. Cliente REST mínimo de Mercado Pago (Preferences API).
export const MP_API_URL = 'https://api.mercadopago.com';
export const STATEMENT_DESCRIPTOR = 'STREAMLYACADEMIA';

export const SITE_CURRENCY = Object.freeze({
  MLA: 'ARS', MLB: 'BRL', MLC: 'CLP', MLM: 'MXN', MCO: 'COP', MPE: 'PEN', MLU: 'UYU',
});
export const ZERO_DECIMAL = Object.freeze(new Set(['CLP', 'COP']));

export function currencyForSite(siteId) {
  return SITE_CURRENCY[String(siteId ?? '').toUpperCase()] ?? null;
}

// price_cents se lee como centésimas de la moneda de la cuenta. CLP y COP no usan decimales.
export function unitPriceFromCents(priceCents, currency) {
  const cents = Number(priceCents);
  if (!Number.isFinite(cents) || cents <= 0) throw httpError(422, 'El precio del curso no es válido para cobrar.');
  const major = cents / 100;
  if (ZERO_DECIMAL.has(currency)) {
    const rounded = Math.round(major);
    if (rounded < 1) throw httpError(422, `El precio del curso no es válido para cobrar en ${currency}.`);
    return rounded;
  }
  return Number(major.toFixed(2));
}

export function isPublicHttpsUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (host === '::1' || host === '::' || /^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith('fe80:')) return false;
  const octets = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (octets) {
    const [a, b] = [Number(octets[1]), Number(octets[2])];
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
  }
  return true;
}

// El monto y la moneda llegan siempre como argumentos calculados por el servidor, nunca desde el request.
export function buildPreferenceBody({ course, user, unitPrice, currency, externalReference, appUrl, publicApiUrl }) {
  const base = String(appUrl).replace(/\/+$/, '');
  const resultUrl = `${base}/pago/resultado`;
  const body = {
    items: [{ id: String(course.id), title: String(course.title).slice(0, 250), quantity: 1, currency_id: currency, unit_price: unitPrice }],
    payer: { email: user.email },
    back_urls: { success: resultUrl, pending: resultUrl, failure: resultUrl },
    external_reference: externalReference,
    statement_descriptor: STATEMENT_DESCRIPTOR,
    metadata: { user_id: Number(user.id), course_id: Number(course.id) },
  };
  if (isPublicHttpsUrl(resultUrl)) body.auto_return = 'approved';
  if (publicApiUrl && isPublicHttpsUrl(publicApiUrl)) {
    body.notification_url = `${String(publicApiUrl).replace(/\/+$/, '')}/api/payments/webhook`;
  }
  return body;
}

// Manifest oficial: id:<data.id>;request-id:<x-request-id>;ts:<ts>; (se omite el par cuyo valor falta).
export function verifyWebhookSignature({ signatureHeader, requestId, dataId, secret }) {
  try {
    if (!signatureHeader || !secret) return false;
    let ts = null;
    let v1 = null;
    for (const part of String(signatureHeader).split(',')) {
      const index = part.indexOf('=');
      if (index < 0) continue;
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (key === 'ts') ts = value;
      if (key === 'v1') v1 = value;
    }
    if (!ts || !v1 || !/^[0-9a-f]+$/i.test(v1)) return false;
    let manifest = '';
    if (dataId) manifest += `id:${/^[a-z0-9]+$/i.test(String(dataId)) ? String(dataId).toLowerCase() : dataId};`;
    if (requestId) manifest += `request-id:${requestId};`;
    manifest += `ts:${ts};`;
    const expected = createHmac('sha256', secret).update(manifest).digest();
    const received = Buffer.from(v1, 'hex');
    if (received.length !== expected.length) return false;
    return timingSafeEqual(received, expected);
  } catch {
    return false;
  }
}

const providerError = () => httpError(502, 'No pudimos comunicarnos con Mercado Pago. Intenta de nuevo.', true, 'PAYMENT_PROVIDER_ERROR');

export function createMercadoPagoClient({ accessToken, fetchImpl = fetch, timeoutMs = 10000, baseUrl = MP_API_URL }) {
  const apiBase = String(baseUrl || MP_API_URL).replace(/\/+$/, '');
  // Devuelve { status, data }. Nunca incluye el token ni el cuerpo de la respuesta en errores propios.
  async function request(path, { method = 'GET', body, headers = {} } = {}) {
    if (!accessToken) throw providerError();
    let response;
    try {
      response = await fetchImpl(`${apiBase}${path}`, {
        method,
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw providerError();
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return { status: response.status, ok: response.ok, data };
  }

  return {
    async getAccountInfo() {
      const { ok, data } = await request('/users/me');
      if (!ok || !data) throw providerError();
      return { siteId: data.site_id ?? null, currency: currencyForSite(data.site_id) };
    },

    async createPreference(body, { idempotencyKey } = {}) {
      const headers = idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {};
      let payload = body;
      let result = await request('/checkout/preferences', { method: 'POST', body: payload, headers });
      let autoReturnDropped = false;
      if (result.status === 400 && payload.auto_return && /auto_return|back_url/i.test(JSON.stringify(result.data ?? {}))) {
        const { auto_return: _dropped, ...withoutAutoReturn } = payload;
        payload = withoutAutoReturn;
        autoReturnDropped = true;
        result = await request('/checkout/preferences', { method: 'POST', body: payload, headers });
      }
      if (!result.ok || !result.data?.id) throw providerError();
      return { id: String(result.data.id), initPoint: result.data.init_point ?? null, sandboxInitPoint: result.data.sandbox_init_point ?? null, autoReturnDropped };
    },

    // Devuelve null si el pago no existe (404).
    async getPayment(id) {
      if (!/^\d{1,20}$/.test(String(id))) return null;
      const { status, ok, data } = await request(`/v1/payments/${id}`);
      if (status === 404) return null;
      if (!ok || !data) throw providerError();
      return data;
    },

    async searchPaymentsByReference(reference) {
      const query = new URLSearchParams({ sort: 'date_created', criteria: 'desc', external_reference: reference });
      const { ok, data } = await request(`/v1/payments/search?${query}`);
      if (!ok || !data) throw providerError();
      return Array.isArray(data.results) ? data.results : [];
    },
  };
}
