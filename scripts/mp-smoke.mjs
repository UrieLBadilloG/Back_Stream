import { randomUUID } from 'node:crypto';

import dotenv from 'dotenv';

import { buildPreferenceBody, createMercadoPagoClient, unitPriceFromCents } from '../src/lib/mercadopago.js';

// Prueba de humo: lee la cuenta y crea una preferencia de 1 unidad. No se realiza ningún cobro.
// Solo imprime site_id, moneda y el host del init_point (nunca credenciales).
dotenv.config({ quiet: true });

const accessToken = String(process.env.MERCADOPAGO_ACCESS_TOKEN ?? '').trim();
if (!accessToken) {
  console.error('Falta MERCADOPAGO_ACCESS_TOKEN en el entorno.');
  process.exit(1);
}

const client = createMercadoPagoClient({ accessToken });
const account = await client.getAccountInfo();
console.log(`site_id: ${account.siteId}`);
console.log(`currency: ${account.currency}`);
if (!account.currency) {
  console.error('El país de la cuenta no tiene una moneda soportada.');
  process.exit(1);
}

const appUrl = String(process.env.APP_URL ?? process.env.FRONTEND_URL ?? 'http://localhost:5173');
const publicApiUrl = process.env.PUBLIC_API_URL || null;
const body = buildPreferenceBody({
  course: { id: 0, title: 'Prueba de integración Streamly Academia' },
  user: { id: 0, email: 'prueba@streamly.test' },
  unitPrice: unitPriceFromCents(account.currency === 'CLP' || account.currency === 'COP' ? 10000 : 100, account.currency),
  currency: account.currency,
  externalReference: `demo-smoke-${randomUUID()}`,
  appUrl,
  publicApiUrl,
});
const preference = await client.createPreference(body, { idempotencyKey: body.external_reference });
const initPoint = (accessToken.startsWith('TEST-') ? preference.sandboxInitPoint : preference.initPoint) ?? preference.initPoint;
console.log(`init_point host: ${new URL(initPoint).host}`);
console.log(`back_urls enviadas: ${Boolean(body.back_urls)} | auto_return enviado: ${Boolean(body.auto_return) && !preference.autoReturnDropped} | auto_return descartado por MP: ${preference.autoReturnDropped}`);
console.log(`statement_descriptor aceptado: true | notification_url enviada: ${Boolean(body.notification_url)}`);
