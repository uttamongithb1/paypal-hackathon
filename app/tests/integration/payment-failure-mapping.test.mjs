/**
 * Capture-failure mapping, over real HTTP against a local fake PayPal (PAYPAL_API_BASE_URL).
 *
 * Regression for the live payment outage: a capture rejected with DUPLICATE_INVOICE_ID used to fall
 * through to UNKNOWN and mark the order payment_failed, hiding the cause and inviting a second
 * charge. It must now surface as ORDER_ALREADY_CAPTURED and route to reconciliation WITHOUT marking
 * the order failed. ORDER_NOT_APPROVED (capture before the buyer approved) must surface as an
 * actionable PAYER_ACTION_REQUIRED rather than a generic provider error.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, asNewCustomer } from '../helpers/harness.mjs';

/** Minimal PayPal stand-in whose next capture can be made to fail with a chosen issue. */
async function fakePayPal() {
  const orders = new Map();
  let seq = 0;
  let failCapture = null; // { issue, description }
  const json = (res, status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://paypal.local');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    if (raw) { try { body = JSON.parse(raw); } catch { body = {}; } }

    if (url.pathname === '/v1/oauth2/token') {
      return json(res, 200, { access_token: 'fake-token', expires_in: 3600, token_type: 'Bearer' });
    }
    if (url.pathname === '/v2/checkout/orders' && req.method === 'POST') {
      seq += 1;
      const id = `FAKE-${String(seq).padStart(6, '0')}`;
      orders.set(id, { id, status: 'CREATED', intent: body.intent, purchase_units: body.purchase_units });
      return json(res, 201, { id, status: 'CREATED' });
    }
    const captureMatch = /^\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(url.pathname);
    if (captureMatch && req.method === 'POST') {
      const order = orders.get(captureMatch[1]);
      if (!order) return json(res, 404, { name: 'RESOURCE_NOT_FOUND' });
      if (failCapture) {
        const { issue, description } = failCapture;
        failCapture = null;
        return json(res, 422, {
          name: 'UNPROCESSABLE_ENTITY',
          message: description,
          debug_id: `test-${issue}`,
          details: [{ issue, description }]
        });
      }
      order.status = 'COMPLETED';
      order.purchase_units = order.purchase_units.map((unit, index) => ({
        ...unit,
        payments: { captures: [{ id: `FAKECAP-${order.id}-${index}`, status: 'COMPLETED', amount: unit.amount, custom_id: unit.custom_id, invoice_id: unit.invoice_id }] }
      }));
      return json(res, 200, order);
    }
    return json(res, 404, { name: 'NOT_FOUND' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, failNextCapture(issue, description) { failCapture = { issue, description }; } };
}

const paypal = await fakePayPal();
const app = await startServer({
  seed: 'catalogue',
  env: {
    PAYPAL_MODE: 'sandbox',
    PAYPAL_CLIENT_ID: 'fake-client',
    PAYPAL_CLIENT_SECRET: 'fake-secret',
    PAYPAL_API_BASE_URL: paypal.base,
    PAYPAL_SETTLEMENT: 'single'
  }
});

test.after(async () => {
  await app.stop();
  await new Promise((resolve) => paypal.server.close(resolve));
});

/** A single-seller order ready to capture. */
async function placeSingleOrder(client) {
  const products = (await client.call('/products?limit=24')).body.items.filter((p) => p.stock > 0);
  const product = products.sort((a, b) => b.stock - a.stock)[0];
  const added = await client.call('/cart/items', { method: 'POST', body: { productId: product.id, quantity: 1 } });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const quote = await client.call('/checkout/quote', { method: 'POST', body: { extendHolds: true } });
  assert.equal(quote.status, 200, JSON.stringify(quote.body));
  const created = await client.call('/orders', {
    method: 'POST',
    body: { quoteId: quote.body.quote.id, quoteHash: quote.body.quote.hash, contact: { email: 'failmap@example.com', name: 'Failure Mapper' } }
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body;
}

const capture = (client, orderId) => client.call(`/payments/${orderId}/capture`, {
  method: 'POST',
  body: {},
  headers: { 'idempotency-key': `cap-${orderId}-${Date.now()}-${Math.random().toString(16).slice(2)}` }
});

test('DUPLICATE_INVOICE_ID surfaces as ORDER_ALREADY_CAPTURED and is NOT marked payment_failed', async () => {
  const client = await asNewCustomer(app.base, 'dup-invoice');
  const created = await placeSingleOrder(client);
  const orderId = created.order.id;
  paypal.failNextCapture('DUPLICATE_INVOICE_ID', 'Duplicate Invoice ID detected. To avoid a potential duplicate transaction your account setting requires that Invoice Id be unique for each transaction.');

  const result = await capture(client, orderId);
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.error.code, 'ORDER_ALREADY_CAPTURED');
  assert.match(result.body.error.message, /already paid|already captured/i);

  const fresh = await client.call(`/orders/${orderId}`);
  assert.notEqual(fresh.body.order.status, 'payment_failed', 'an order whose invoice already captured must not be reported as failed');
  assert.notEqual(fresh.body.order.status, 'paid', 'it is not confirmed paid until reconciliation verifies the capture');
  const reconcile = fresh.body.order.timeline.filter((e) => e.event === 'capture_already_exists');
  assert.equal(reconcile.length, 1, 'the duplicate is flagged for reconciliation');
  assert.equal(reconcile[0].meta?.needsReconcile, true);
});

test('ORDER_NOT_APPROVED surfaces as an actionable PAYER_ACTION_REQUIRED', async () => {
  const client = await asNewCustomer(app.base, 'not-approved');
  const created = await placeSingleOrder(client);
  const orderId = created.order.id;
  paypal.failNextCapture('ORDER_NOT_APPROVED', 'The order has not been approved by the payer.');

  const result = await capture(client, orderId);
  // The capture path reports payment failures as 402 (Payment Required); the actionable code/message
  // are what the shopper UI keys on, not the generic UNKNOWN it used to be.
  assert.equal(result.status, 402, JSON.stringify(result.body));
  assert.equal(result.body.error.code, 'PAYER_ACTION_REQUIRED');
  assert.match(result.body.error.message, /approve/i);

  const fresh = await client.call(`/orders/${orderId}`);
  assert.equal(fresh.body.order.status, 'payment_failed');
  assert.equal(fresh.body.order.payment.failureReason, 'ORDER_NOT_APPROVED', 'the real cause is recorded, not UNKNOWN');
});
