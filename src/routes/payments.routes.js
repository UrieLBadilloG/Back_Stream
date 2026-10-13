import { randomUUID } from 'node:crypto';

import { Router } from 'express';

import { pool } from '../config/database.js';
import { env } from '../config/env.js';
import { describeAccess, enrollmentAccessColumns } from '../lib/access.js';
import { assert, httpError } from '../lib/http-error.js';
import { buildPreferenceBody, createMercadoPagoClient, unitPriceFromCents, verifyWebhookSignature, ZERO_DECIMAL } from '../lib/mercadopago.js';
import { createPaymentProcessor } from '../lib/payment-processor.js';
import { createPaymentsStore, REVIEWABLE_STATUSES } from '../lib/payments-store.js';
import { isCourseManager } from '../lib/users.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rate-limit.js';

export const paymentsRouter = Router();
export const superPaymentsRouter = Router();
export const adminPaymentsRouter = Router();

const settings = env.payments;
const store = createPaymentsStore(pool);
const processor = createPaymentProcessor({ store });
const client = settings.mercadoPago.accessToken ? createMercadoPagoClient({ accessToken: settings.mercadoPago.accessToken, ...(settings.mercadoPago.apiBaseUrl ? { baseUrl: settings.mercadoPago.apiBaseUrl } : {}) }) : null;

const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MP_ID_PATTERN = /^\d{1,20}$/;

// Mercado Pago llega desde pocas IP y reintenta: el límite es holgado y solo frena abusos graves.
const webhookLimiter = createRateLimiter({ windowMs: 60000, max: 600 });
const verifyLimiter = createRateLimiter({ windowMs: 60000, max: 30, keyFn: (request) => `u${request.user?.id}` });
const checkoutLimiter = createRateLimiter({ windowMs: 60000, max: 20, keyFn: (request) => `u${request.user?.id}` });

let configCache = { value: null, expiresAt: 0 };

async function paymentsConfig() {
  if (!client) {
    return { enabled: false, currency: null, provider: 'mercadopago', decimals: null, reason: 'Los pagos con Mercado Pago todavía no están configurados.' };
  }
  if (configCache.value && configCache.expiresAt > Date.now()) return configCache.value;
  let value;
  let ttl = SUCCESS_TTL_MS;
  try {
    const account = await client.getAccountInfo();
    if (account.currency) {
      value = { enabled: true, currency: account.currency, provider: 'mercadopago', decimals: ZERO_DECIMAL.has(account.currency) ? 0 : 2 };
    } else {
      value = { enabled: false, currency: null, provider: 'mercadopago', decimals: null, reason: 'El país de la cuenta de Mercado Pago no es compatible.' };
      ttl = FAILURE_TTL_MS;
    }
  } catch {
    value = { enabled: false, currency: null, provider: 'mercadopago', decimals: null, reason: 'No pudimos conectar con Mercado Pago. Intenta más tarde.' };
    ttl = FAILURE_TTL_MS;
  }
  configCache = { value, expiresAt: Date.now() + ttl };
  return value;
}

function positiveId(value, label) {
  const id = Number(value);
  assert(Number.isSafeInteger(id) && id > 0, 400, `El identificador de ${label} no es válido.`);
  return id;
}

function accessGrantedOf(payment) {
  return Boolean(payment.approvedAt) && payment.enrollmentId !== null;
}

function serializePayment(payment) {
  return {
    id: payment.id,
    externalReference: payment.externalReference,
    status: payment.status,
    statusDetail: payment.statusDetail,
    amount: payment.amount,
    currency: payment.currency,
    createdAt: payment.createdAt,
    approvedAt: payment.approvedAt,
  };
}

function outcomeOf(status) {
  if (status === 'approved') return 'approved';
  if (['pending', 'in_process', 'in_mediation', 'authorized'].includes(status)) return 'pending';
  if (['rejected', 'cancelled'].includes(status)) return 'rejected';
  if (['refunded', 'charged_back'].includes(status)) return 'refunded';
  return 'unknown';
}

paymentsRouter.get('/config', async (_request, response) => {
  response.set('Cache-Control', 'public, max-age=60');
  response.json(await paymentsConfig());
});

paymentsRouter.post('/courses/:courseId/checkout', requireAuth, checkoutLimiter, async (request, response) => {
  const config = await paymentsConfig();
  if (!config.enabled) throw httpError(503, 'Los pagos no están disponibles en este momento.', true, 'PAYMENTS_DISABLED');
  const id = positiveId(request.params.courseId, 'curso');
  const [courses] = await pool.execute('SELECT id, slug, title, owner_id, status, price_cents FROM courses WHERE id = ? LIMIT 1', [id]);
  const course = courses[0];
  if (!course || course.status !== 'published') throw httpError(404, 'Curso no disponible para compra.');
  if (isCourseManager(request.user, course)) throw httpError(409, 'Eres administrador de este curso, no necesitas comprarlo.', true, 'COURSE_MANAGER');
  const priceCents = Number(course.price_cents);
  if (!(priceCents > 0)) throw httpError(422, 'Este curso es gratuito y no requiere pago.');
  const [enrollments] = await pool.execute(
    `SELECT e.id, ${enrollmentAccessColumns('e')} FROM enrollments e WHERE e.user_id = ? AND e.course_id = ? LIMIT 1`,
    [request.user.id, id],
  );
  if (enrollments[0] && !describeAccess(enrollments[0]).isExpired) throw httpError(409, 'Ya tienes acceso vigente a este curso.', true, 'ALREADY_ENROLLED');

  const unitPrice = unitPriceFromCents(priceCents, config.currency);
  const reusable = await store.findReusablePending({ userId: request.user.id, courseId: id, amountCents: priceCents, currency: config.currency });
  if (reusable) {
    response.status(201).json({ paymentId: reusable.id, preferenceId: reusable.preferenceId, initPoint: reusable.checkoutUrl, externalReference: reusable.externalReference, amount: reusable.amount, currency: reusable.currency });
    return;
  }

  const externalReference = randomUUID();
  // Primero el registro 'pending' (sin preferencia) y después Mercado Pago: nunca hay una preferencia sin registro.
  const paymentId = await store.insertPending({
    userId: request.user.id, courseId: id, preferenceId: null, checkoutUrl: null, externalReference,
    amountCents: priceCents, amount: unitPrice, currency: config.currency, payerEmail: request.user.email,
  });
  let preference;
  let initPoint;
  try {
    const body = buildPreferenceBody({ course, user: request.user, unitPrice, currency: config.currency, externalReference, appUrl: settings.appUrl, publicApiUrl: settings.publicApiUrl });
    preference = await client.createPreference(body, { idempotencyKey: externalReference });
    const useSandbox = settings.mercadoPago.accessToken.startsWith('TEST-');
    initPoint = (useSandbox ? preference.sandboxInitPoint : preference.initPoint) ?? preference.initPoint;
    if (!initPoint) throw httpError(502, 'No pudimos comunicarnos con Mercado Pago. Intenta de nuevo.', true, 'PAYMENT_PROVIDER_ERROR');
    await store.attachPreference(paymentId, { preferenceId: preference.id, checkoutUrl: initPoint });
  } catch (error) {
    await store.markCheckoutFailed(paymentId).catch(() => {});
    throw error;
  }
  response.status(201).json({ paymentId, preferenceId: preference.id, initPoint, externalReference, amount: unitPrice, currency: config.currency });
});

paymentsRouter.post('/verify', requireAuth, verifyLimiter, async (request, response) => {
  const externalReference = String(request.body?.externalReference ?? '');
  assert(UUID_PATTERN.test(externalReference), 400, 'La referencia de pago no es válida.');
  const paymentIdInput = request.body?.paymentId === undefined || request.body?.paymentId === null || request.body?.paymentId === '' ? null : String(request.body.paymentId);
  assert(paymentIdInput === null || MP_ID_PATTERN.test(paymentIdInput), 400, 'El identificador de pago no es válido.');

  const existing = await store.findByReference(externalReference);
  if (!existing || existing.userId !== request.user.id) throw httpError(404, 'Pago no encontrado.');
  if (!client) throw httpError(503, 'Los pagos no están disponibles en este momento.', true, 'PAYMENTS_DISABLED');

  let mpPayment = null;
  if (paymentIdInput) {
    mpPayment = await client.getPayment(paymentIdInput);
    if (!mpPayment) throw httpError(404, 'No encontramos ese pago en Mercado Pago.');
    if (mpPayment.external_reference !== externalReference) throw httpError(400, 'El pago no corresponde a esta compra.');
  } else {
    const results = await client.searchPaymentsByReference(externalReference);
    mpPayment = results.find((item) => item.status === 'approved') ?? results[0] ?? null;
  }
  if (mpPayment) await processor.processMercadoPagoPayment(mpPayment);

  const payment = await store.findByReference(externalReference);
  if (!payment || payment.userId !== request.user.id) throw httpError(404, 'Pago no encontrado.');
  const [courses] = await pool.execute('SELECT id, slug, title FROM courses WHERE id = ? LIMIT 1', [payment.courseId]);
  if (!courses[0]) throw httpError(404, 'El curso de este pago ya no existe.');
  response.json({
    payment: serializePayment(payment),
    course: { id: Number(courses[0].id), slug: courses[0].slug, title: courses[0].title },
    accessGranted: accessGrantedOf(payment),
    outcome: outcomeOf(payment.status),
  });
});

paymentsRouter.post('/webhook', webhookLimiter, async (request, response, next) => {
  const body = request.body ?? {};
  const type = String(request.query.type ?? body.type ?? request.query.topic ?? body.topic ?? '');
  const rawId = request.query['data.id'] ?? body.data?.id ?? (type === 'payment' ? request.query.id : undefined);
  const dataId = rawId === undefined || rawId === null ? '' : String(rawId);
  if (type !== 'payment' || !MP_ID_PATTERN.test(dataId)) {
    response.json({ received: true });
    return;
  }
  if (!client) {
    next(httpError(503, 'Los pagos no están disponibles en este momento.', true, 'PAYMENTS_DISABLED'));
    return;
  }
  const secret = settings.mercadoPago.webhookSecret;
  if (secret && !verifyWebhookSignature({ signatureHeader: request.get('x-signature'), requestId: request.get('x-request-id'), dataId, secret })) {
    response.status(401).json({ status: 'error', message: 'Firma no válida.' });
    return;
  }
  try {
    const mpPayment = await client.getPayment(dataId);
    if (!mpPayment) {
      console.log(`[payments] webhook payment=${dataId} outcome=not_found`);
      response.json({ received: true });
      return;
    }
    const result = await processor.processMercadoPagoPayment(mpPayment);
    console.log(`[payments] webhook payment=${dataId} outcome=${result.handled ? (result.flagged ?? (result.accessGranted ? 'access' : 'stored')) : result.reason}`);
    response.json({ received: true });
  } catch {
    console.error(`[payments] webhook payment=${dataId} outcome=error`);
    next(httpError(500, 'No pudimos procesar la notificación.', false));
  }
});

paymentsRouter.get('/mine', requireAuth, async (request, response) => {
  const payments = await store.listMine(request.user.id);
  response.json({
    payments: payments.map((payment) => ({
      ...serializePayment(payment),
      amountCents: payment.amountCents,
      accessGranted: accessGrantedOf(payment),
      course: { id: payment.courseId, slug: payment.courseSlug, title: payment.courseTitle },
    })),
  });
});

async function listPayments(request, response, ownerId) {
  const status = request.query.status === undefined || request.query.status === '' ? '' : String(request.query.status);
  assert(status === '' || status === 'review' || REVIEWABLE_STATUSES.includes(status), 400, 'El estado de pago no es válido.');
  const pageSize = request.query.pageSize === undefined ? 20 : Number(request.query.pageSize);
  const page = request.query.page === undefined ? 1 : Number(request.query.page);
  assert(Number.isSafeInteger(pageSize) && pageSize >= 1 && pageSize <= 50, 400, 'El tamaño de página debe estar entre 1 y 50.');
  assert(Number.isSafeInteger(page) && page >= 1 && page <= 100000, 400, 'La página no es válida.');
  const result = await store.listScoped({ ownerId, status, page, pageSize });
  const config = await paymentsConfig();
  response.json({
    payments: result.rows.map((row) => ({
      id: Number(row.id),
      externalReference: row.external_reference,
      status: row.status,
      statusDetail: row.status_detail,
      amount: Number(row.amount),
      currency: row.currency,
      needsReview: Boolean(row.needs_review),
      reviewReason: row.review_reason,
      createdAt: row.created_at,
      approvedAt: row.approved_at,
      student: { id: Number(row.student_id), fullName: row.student_name, email: row.student_email },
      course: { id: Number(row.course_id), title: row.course_title, ownerName: row.owner_name },
    })),
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
    totals: result.totals.map((row) => ({ status: row.status, count: Number(row.count), amount: Number(row.amount) })),
    currency: config.currency ?? result.rows[0]?.currency ?? null,
  });
}

superPaymentsRouter.get('/', requireAuth, requireRole('super_admin'), (request, response) => listPayments(request, response, null));

adminPaymentsRouter.get('/', requireAuth, requireRole('admin', 'super_admin'), (request, response) => (
  listPayments(request, response, request.user.role === 'super_admin' ? null : request.user.id)
));
