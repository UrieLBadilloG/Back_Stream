import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

// Servidor FALSO de Mercado Pago solo para pruebas locales. Imita lo que usa el backend:
//   GET  /users/me                                (site_id)
//   POST /checkout/preferences                    (id, init_point, sandbox_init_point)
//   GET  /v1/payments/:id                         (objeto de pago; 404 {message,error,status,cause} si no existe)
//   GET  /v1/payments/search?external_reference=  ({ paging, results })
// Campos del pago según la referencia oficial de Mercado Pago: id, status, status_detail, transaction_amount,
// transaction_amount_refunded, currency_id, external_reference, payer.email, date_created, date_approved,
// date_last_updated, payment_type_id, payment_method_id, installments, metadata.
export function createFakeMercadoPago({ port, accessToken, siteId = 'MLM' }) {
  const payments = new Map();
  const preferences = [];
  const hits = { payment: 0, search: 0, me: 0, preference: 0 };
  const control = { failNextPreferences: 0, unauthorizedCalls: 0 };
  let nextPaymentId = 90000000000 + Math.floor(Math.random() * 1000000);

  const send = (response, status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
  };

  const readBody = (request) => new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null);
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      if (request.headers.authorization !== `Bearer ${accessToken}`) {
        control.unauthorizedCalls += 1;
        send(response, 401, { message: 'invalid_token', error: 'unauthorized', status: 401 });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/users/me') {
        hits.me += 1;
        send(response, 200, { id: 1234567, nickname: 'TEST_SELLER', site_id: siteId, country_id: siteId === 'MLM' ? 'MX' : 'XX' });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/checkout/preferences') {
        hits.preference += 1;
        const body = await readBody(request);
        if (control.failNextPreferences > 0) {
          control.failNextPreferences -= 1;
          send(response, 500, { message: 'internal_error', status: 500 });
          return;
        }
        if (!Array.isArray(body?.items) || !body.items.length || !(Number(body.items[0].unit_price) > 0)) {
          send(response, 400, { message: 'invalid items', error: 'bad_request', status: 400 });
          return;
        }
        if (body.auto_return && !body.back_urls?.success) {
          send(response, 400, { message: 'auto_return invalid. back_url.success must be defined', error: 'invalid_auto_return', status: 400 });
          return;
        }
        const id = `${1234567 + preferences.length}-${randomUUID()}`;
        preferences.push({ id, body, idempotencyKey: request.headers['x-idempotency-key'] ?? null });
        send(response, 201, {
          id,
          init_point: `https://www.mercadopago.com.mx/checkout/v1/redirect?pref_id=${id}`,
          sandbox_init_point: `https://sandbox.mercadopago.com.mx/checkout/v1/redirect?pref_id=${id}`,
          items: body.items,
          external_reference: body.external_reference,
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/payments/search') {
        hits.search += 1;
        const reference = url.searchParams.get('external_reference');
        const results = [...payments.values()].filter((payment) => payment.external_reference === reference).sort((a, b) => b.id - a.id);
        send(response, 200, { paging: { total: results.length, limit: 30, offset: 0 }, results });
        return;
      }
      const match = url.pathname.match(/^\/v1\/payments\/(\d+)$/);
      if (request.method === 'GET' && match) {
        hits.payment += 1;
        const payment = payments.get(match[1]);
        if (!payment) {
          send(response, 404, { message: 'Payment not found', error: 'not_found', status: 404, cause: [] });
          return;
        }
        send(response, 200, payment);
        return;
      }
      send(response, 404, { message: 'not_found', status: 404 });
    } catch {
      send(response, 400, { message: 'bad_request', status: 400 });
    }
  });

  return {
    payments,
    preferences,
    hits,
    control,
    start: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    }),
    stop: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
    // Crea un pago configurable. status: approved|pending|in_process|rejected|refunded|charged_back|cancelled.
    addPayment({ reference, amount, currency = 'MXN', status = 'approved', statusDetail, email = 'comprador@example.test', metadata, id } = {}) {
      const paymentId = String(id ?? nextPaymentId++);
      const now = new Date().toISOString();
      const payment = {
        id: Number(paymentId),
        status,
        status_detail: statusDetail ?? (status === 'approved' ? 'accredited' : status === 'rejected' ? 'cc_rejected_other_reason' : status === 'pending' ? 'pending_waiting_payment' : status === 'in_process' ? 'pending_contingency' : status),
        transaction_amount: Number(amount),
        transaction_amount_refunded: status === 'refunded' ? Number(amount) : 0,
        currency_id: currency,
        external_reference: reference,
        payer: { id: 987654, email },
        payment_type_id: 'credit_card',
        payment_method_id: 'visa',
        installments: 1,
        date_created: now,
        date_approved: status === 'approved' ? now : null,
        date_last_updated: now,
        metadata: metadata ?? {},
      };
      payments.set(paymentId, payment);
      return payment;
    },
    setStatus(id, status, extra = {}) {
      const payment = payments.get(String(id));
      if (!payment) throw new Error(`Pago falso ${id} no existe`);
      payment.status = status;
      payment.status_detail = status;
      payment.date_last_updated = new Date().toISOString();
      if (status === 'approved' && !payment.date_approved) payment.date_approved = payment.date_last_updated;
      if (status === 'refunded') payment.transaction_amount_refunded = payment.transaction_amount;
      Object.assign(payment, extra);
      return payment;
    },
  };
}
