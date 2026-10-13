import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';

import { createMercadoPagoClient, MP_API_URL } from '../src/lib/mercadopago.js';
import { collectStartupWarnings } from '../src/lib/startup-warnings.js';

// Importa config/env.js en un proceso aparte con un entorno controlado y devuelve lo que interesa.
function loadEnv(overrides) {
  const script = "import('./src/config/env.js').then(({ env }) => console.log(JSON.stringify({ base: env.payments.mercadoPago.apiBaseUrl, ignored: env.payments.mercadoPago.apiBaseUrlIgnored, trust: env.trustProxy })))";
  const output = execFileSync(process.execPath, ['-e', script], {
    cwd: new URL('..', import.meta.url),
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      DB_HOST: 'x', DB_USER: 'x', DB_PASSWORD: 'x', DB_NAME: 'x', JWT_SECRET: 'x', CLOUDINARY_CLOUD_NAME: 'x', CLOUDINARY_API_KEY: 'x', CLOUDINARY_API_SECRET: 'x',
      ...overrides,
    },
    encoding: 'utf8',
    timeout: 15000,
  });
  return JSON.parse(output.trim().split('\n').at(-1));
}

describe('cliente de Mercado Pago: URL base', () => {
  it('usa api.mercadopago.com por defecto y respeta baseUrl en pruebas', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return { status: 200, ok: true, json: async () => ({ site_id: 'MLM' }) };
    };
    await createMercadoPagoClient({ accessToken: 't', fetchImpl }).getAccountInfo();
    await createMercadoPagoClient({ accessToken: 't', fetchImpl, baseUrl: 'http://localhost:3199/' }).getAccountInfo();
    assert.equal(calls[0], `${MP_API_URL}/users/me`);
    assert.equal(calls[1], 'http://localhost:3199/users/me');
  });
});

describe('configuración de entorno', () => {
  it('MERCADOPAGO_API_BASE_URL se respeta fuera de producción', () => {
    const result = loadEnv({ NODE_ENV: 'development', MERCADOPAGO_API_BASE_URL: 'http://localhost:3199' });
    assert.equal(result.base, 'http://localhost:3199');
    assert.equal(result.ignored, false);
  });

  it('MERCADOPAGO_API_BASE_URL se ignora en producción y se marca', () => {
    const result = loadEnv({ NODE_ENV: 'production', MERCADOPAGO_API_BASE_URL: 'http://localhost:3199' });
    assert.equal(result.base, null);
    assert.equal(result.ignored, true);
  });

  it('TRUST_PROXY: desactivado por defecto, acepta saltos y rechaza "true"', () => {
    assert.equal(loadEnv({}).trust, false);
    assert.equal(loadEnv({ TRUST_PROXY: '1' }).trust, 1);
    assert.equal(loadEnv({ TRUST_PROXY: 'loopback' }).trust, 'loopback');
    assert.throws(() => loadEnv({ TRUST_PROXY: 'true' }), /TRUST_PROXY/);
  });
});

describe('avisos de arranque', () => {
  const ok = { nodeEnv: 'production', corsOrigin: 'https://tudominio.com', trustProxy: 1, payments: { appUrl: 'https://tudominio.com', publicApiUrl: 'https://api.tudominio.com', mercadoPago: { accessToken: 'x', webhookSecret: 'y', apiBaseUrlIgnored: false } } };

  it('producción completa no avisa nada', () => {
    assert.deepEqual(collectStartupWarnings(ok), []);
  });

  it('avisa por cada ajuste faltante, sin imprimir valores', () => {
    const bad = { ...ok, corsOrigin: 'http://localhost:5173', trustProxy: false, payments: { appUrl: 'http://localhost:5173', publicApiUrl: null, mercadoPago: { accessToken: 'secreto-x', webhookSecret: null, apiBaseUrlIgnored: true } } };
    const warnings = collectStartupWarnings(bad);
    assert.equal(warnings.length, 5);
    assert.ok(warnings.every((line) => !line.includes('secreto-x')));
  });

  it('en desarrollo o sin credenciales de Mercado Pago no avisa', () => {
    assert.deepEqual(collectStartupWarnings({ ...ok, nodeEnv: 'development', payments: { ...ok.payments, mercadoPago: { ...ok.payments.mercadoPago, webhookSecret: null } } }), []);
    assert.deepEqual(collectStartupWarnings({ ...ok, payments: { ...ok.payments, mercadoPago: { accessToken: null } } }), []);
  });
});
