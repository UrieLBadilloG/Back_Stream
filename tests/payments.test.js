import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import { computeAccessExpiry } from '../src/lib/access.js';
import { buildPreferenceBody, currencyForSite, unitPriceFromCents, verifyWebhookSignature } from '../src/lib/mercadopago.js';
import { createPaymentProcessor } from '../src/lib/payment-processor.js';

const NOW = new Date('2026-01-10T12:00:00.000Z');
const DAY_MS = 86400000;
const REF = '11111111-2222-4333-8444-555555555555';

// Almacén en memoria con la misma interfaz que payments-store.js. La transacción restaura el estado si algo lanza.
function createFakeStore({ accessDays = 45, enrollment, failGrant = false, initial = {} } = {}) {
  const state = {
    rows: new Map([[REF, { id: 1, userId: 7, courseId: 3, externalReference: REF, status: 'pending', statusDetail: null, mpPaymentId: null, amount: 49.99, currency: 'ARS', enrollmentId: null, approvedAt: null, needsReview: false, reviewReason: null, ...initial }]]),
    enrollment: enrollment ? { ...enrollment } : null,
    grantCalls: 0,
    writes: 0,
  };
  const snapshot = () => ({ rows: new Map([...state.rows].map(([key, row]) => [key, { ...row }])), enrollment: state.enrollment ? { ...state.enrollment } : null, grantCalls: state.grantCalls, writes: state.writes });
  const tx = {
    async lockByReference(reference) {
      const row = state.rows.get(reference);
      return row ? { ...row } : null;
    },
    async update(id, fields) {
      state.writes += 1;
      const row = [...state.rows.values()].find((item) => item.id === id);
      for (const [key, value] of Object.entries(fields)) {
        if (key === 'approvedNow') row.approvedAt = NOW;
        else if (key === 'rawStatusPayload') continue;
        else row[key] = value;
      }
    },
    async grantAccess() {
      state.grantCalls += 1;
      if (failGrant) throw new Error('fallo simulado');
      const expires = computeAccessExpiry({ accessDays, existingExpiresAt: state.enrollment ? state.enrollment.expiresAt : undefined, now: NOW });
      const renewed = Boolean(state.enrollment);
      state.enrollment = { id: 99, expiresAt: expires };
      return { enrollmentId: 99, expiresAtIso: expires ? expires.toISOString() : null, renewed };
    },
  };
  return {
    state,
    async transaction(fn) {
      const backup = snapshot();
      try {
        return await fn(tx);
      } catch (error) {
        state.rows = backup.rows;
        state.enrollment = backup.enrollment;
        state.grantCalls = backup.grantCalls;
        state.writes = backup.writes;
        throw error;
      }
    },
  };
}

const mpPayment = (overrides = {}) => ({ id: 1001, status: 'approved', status_detail: 'accredited', external_reference: REF, transaction_amount: 49.99, currency_id: 'ARS', metadata: { user_id: 7, course_id: 3 }, ...overrides });
const rowOf = (store) => store.state.rows.get(REF);

describe('procesador de pagos', () => {
  it('1. un pago aprobado otorga acceso una vez y deja la fila aprobada', async () => {
    const store = createFakeStore();
    const result = await createPaymentProcessor({ store }).processMercadoPagoPayment(mpPayment());
    assert.equal(result.accessGranted, true);
    assert.equal(rowOf(store).status, 'approved');
    assert.equal(rowOf(store).enrollmentId, 99);
    assert.equal(rowOf(store).mpPaymentId, '1001');
    assert.equal(store.state.grantCalls, 1);
  });

  it('2. repetir el mismo pago aprobado (webhook y verify) no otorga acceso dos veces', async () => {
    const store = createFakeStore();
    const processor = createPaymentProcessor({ store });
    await processor.processMercadoPagoPayment(mpPayment());
    const replay = await processor.processMercadoPagoPayment(mpPayment());
    assert.equal(replay.accessGranted, true);
    assert.equal(store.state.grantCalls, 1);
  });

  it('3. monto o moneda distintos marcan revisión, sin acceso ni aprobación', async () => {
    for (const override of [{ transaction_amount: 1 }, { currency_id: 'USD' }]) {
      const store = createFakeStore();
      const result = await createPaymentProcessor({ store }).processMercadoPagoPayment(mpPayment(override));
      assert.equal(result.accessGranted, false);
      assert.equal(rowOf(store).needsReview, true);
      assert.equal(rowOf(store).reviewReason, 'amount_mismatch');
      assert.equal(rowOf(store).status, 'pending');
      assert.equal(store.state.grantCalls, 0);
    }
  });

  it('4. una referencia desconocida no escribe nada', async () => {
    const store = createFakeStore();
    const result = await createPaymentProcessor({ store }).processMercadoPagoPayment(mpPayment({ external_reference: '99999999-2222-4333-8444-555555555555' }));
    assert.equal(result.handled, false);
    assert.equal(result.reason, 'unknown_reference');
    assert.equal(store.state.writes, 0);
    assert.equal(store.state.grantCalls, 0);
  });

  it('5. una referencia demo- nunca otorga acceso', async () => {
    const store = createFakeStore();
    const result = await createPaymentProcessor({ store }).processMercadoPagoPayment(mpPayment({ external_reference: 'demo-abc123' }));
    assert.equal(result.accessGranted, false);
    assert.equal(store.state.grantCalls, 0);
    assert.equal(store.state.writes, 0);
  });

  it('6. renovación: vence a now + días, nunca antes del vencimiento previo; indefinido queda null', () => {
    const expired = new Date(NOW.getTime() - 5 * DAY_MS);
    assert.equal(computeAccessExpiry({ accessDays: 45, existingExpiresAt: expired, now: NOW }).getTime(), NOW.getTime() + 45 * DAY_MS);
    const farFuture = new Date(NOW.getTime() + 100 * DAY_MS);
    assert.equal(computeAccessExpiry({ accessDays: 45, existingExpiresAt: farFuture, now: NOW }).getTime(), farFuture.getTime());
    assert.equal(computeAccessExpiry({ accessDays: 45, existingExpiresAt: undefined, now: NOW }).getTime(), NOW.getTime() + 45 * DAY_MS);
    assert.equal(computeAccessExpiry({ accessDays: null, existingExpiresAt: expired, now: NOW }), null);
    assert.equal(computeAccessExpiry({ accessDays: 45, existingExpiresAt: null, now: NOW }), null);
  });

  it('6b. un pago aprobado sobre una inscripción vencida renueva a now + días', async () => {
    const store = createFakeStore({ enrollment: { id: 99, expiresAt: new Date(NOW.getTime() - 5 * DAY_MS) } });
    const result = await createPaymentProcessor({ store }).processMercadoPagoPayment(mpPayment());
    assert.equal(result.renewed, true);
    assert.equal(result.expiresAt, new Date(NOW.getTime() + 45 * DAY_MS).toISOString());
  });

  it('7. rechazado y luego aprobado termina aprobado con un solo acceso; aprobado y luego rechazado sigue aprobado', async () => {
    const store = createFakeStore();
    const processor = createPaymentProcessor({ store });
    await processor.processMercadoPagoPayment(mpPayment({ id: 1000, status: 'rejected', status_detail: 'cc_rejected_other_reason' }));
    assert.equal(rowOf(store).status, 'rejected');
    await processor.processMercadoPagoPayment(mpPayment({ id: 1001 }));
    assert.equal(rowOf(store).status, 'approved');
    assert.equal(store.state.grantCalls, 1);
    await processor.processMercadoPagoPayment(mpPayment({ id: 1002, status: 'rejected' }));
    assert.equal(rowOf(store).status, 'approved');
    assert.equal(rowOf(store).mpPaymentId, '1001');
  });

  it('8. reembolso mantiene el acceso y marca revisión; un segundo pago aprobado es duplicado', async () => {
    const store = createFakeStore();
    const processor = createPaymentProcessor({ store });
    await processor.processMercadoPagoPayment(mpPayment());
    const refund = await processor.processMercadoPagoPayment(mpPayment({ status: 'refunded' }));
    assert.equal(refund.accessGranted, true);
    assert.equal(rowOf(store).needsReview, true);
    assert.equal(rowOf(store).reviewReason, 'refunded');
    assert.equal(store.state.enrollment.id, 99);
    await processor.processMercadoPagoPayment(mpPayment({ id: 2002 }));
    assert.equal(rowOf(store).reviewReason, 'duplicate_payment');
    assert.equal(store.state.grantCalls, 1);
  });

  it('9. un error al otorgar acceso deja la fila sin cambios (rollback)', async () => {
    const store = createFakeStore({ failGrant: true });
    await assert.rejects(createPaymentProcessor({ store }).processMercadoPagoPayment(mpPayment()), /fallo simulado/);
    assert.equal(rowOf(store).status, 'pending');
    assert.equal(rowOf(store).enrollmentId, null);
    assert.equal(rowOf(store).mpPaymentId, null);
  });

  it('metadatos que no coinciden se marcan para revisión sin otorgar acceso', async () => {
    const store = createFakeStore();
    await createPaymentProcessor({ store }).processMercadoPagoPayment(mpPayment({ metadata: { user_id: 8, course_id: 3 } }));
    assert.equal(rowOf(store).reviewReason, 'metadata_mismatch');
    assert.equal(store.state.grantCalls, 0);
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 'secreto-de-prueba';
  const sign = (manifest) => createHmac('sha256', secret).update(manifest).digest('hex');
  const header = (ts, v1) => `ts=${ts},v1=${v1}`;

  it('10. acepta una firma válida y rechaza las alteradas sin lanzar', () => {
    const ts = '1700000000';
    const valid = header(ts, sign(`id:123456;request-id:req-1;ts:${ts};`));
    assert.equal(verifyWebhookSignature({ signatureHeader: valid, requestId: 'req-1', dataId: '123456', secret }), true);
    assert.equal(verifyWebhookSignature({ signatureHeader: valid, requestId: 'req-1', dataId: '123456', secret: 'otro' }), false);
    assert.equal(verifyWebhookSignature({ signatureHeader: valid, requestId: 'req-1', dataId: '123457', secret }), false);
    assert.equal(verifyWebhookSignature({ signatureHeader: `v1=${sign('x')}`, requestId: 'req-1', dataId: '123456', secret }), false);
    assert.equal(verifyWebhookSignature({ signatureHeader: `ts=${ts}`, requestId: 'req-1', dataId: '123456', secret }), false);
    assert.equal(verifyWebhookSignature({ signatureHeader: header(ts, 'abcd'), requestId: 'req-1', dataId: '123456', secret }), false);
    assert.equal(verifyWebhookSignature({ signatureHeader: undefined, requestId: 'req-1', dataId: '123456', secret }), false);
  });

  it('omite del manifest el par cuyo valor falta', () => {
    const ts = '1700000000';
    const noRequestId = header(ts, sign(`id:123456;ts:${ts};`));
    assert.equal(verifyWebhookSignature({ signatureHeader: noRequestId, requestId: null, dataId: '123456', secret }), true);
  });
});

describe('modelo de dinero', () => {
  it('11. unitPriceFromCents y currencyForSite', () => {
    assert.equal(unitPriceFromCents(4999, 'ARS'), 49.99);
    assert.equal(unitPriceFromCents(4999, 'CLP'), 50);
    assert.equal(unitPriceFromCents(4900, 'COP'), 49);
    assert.throws(() => unitPriceFromCents(40, 'CLP'), (error) => error.statusCode === 422);
    assert.throws(() => unitPriceFromCents(0, 'ARS'), (error) => error.statusCode === 422);
    assert.equal(currencyForSite('MLC'), 'CLP');
    assert.equal(currencyForSite('XXX'), null);
  });
});

describe('buildPreferenceBody', () => {
  const base = { course: { id: 3, title: 'Derecho digital' }, user: { id: 7, email: 'alumna@example.com' }, unitPrice: 49.99, currency: 'ARS', externalReference: REF };

  it('12. omite notification_url y auto_return con URLs locales o http', () => {
    const local = buildPreferenceBody({ ...base, appUrl: 'http://localhost:5173', publicApiUrl: 'http://localhost:3000' });
    assert.equal(local.auto_return, undefined);
    assert.equal(local.notification_url, undefined);
    assert.equal(local.back_urls.success, 'http://localhost:5173/pago/resultado');
    const http = buildPreferenceBody({ ...base, appUrl: 'http://academia.example.com', publicApiUrl: 'http://api.example.com' });
    assert.equal(http.auto_return, undefined);
    assert.equal(http.notification_url, undefined);
  });

  it('12. incluye ambos con https público y toma monto y moneda de los argumentos', () => {
    const body = buildPreferenceBody({ ...base, appUrl: 'https://academia.example.com/', publicApiUrl: 'https://api.example.com/' });
    assert.equal(body.auto_return, 'approved');
    assert.equal(body.notification_url, 'https://api.example.com/api/payments/webhook');
    assert.equal(body.items[0].unit_price, 49.99);
    assert.equal(body.items[0].currency_id, 'ARS');
    assert.equal(body.external_reference, REF);
    assert.deepEqual(body.metadata, { user_id: 7, course_id: 3 });
  });
});
