/**
 * Webhook recovery for single- and multi-seller orders, over real HTTP.
 *
 * The bug this covers: `PAYMENT.CAPTURE.COMPLETED` used to build a one-unit synthetic capture even
 * for a split order, so V8 could never pass; and the handler did not await `applyCapture`, so the
 * webhook could report "applied" before the paid transition (or its failure) was durable. A webhook
 * must verify the FULL PayPal order, not the single capture resource in the event.
 *
 * These tests drive the real sandbox gateway against a local fake PayPal (PAYPAL_API_BASE_URL), so
 * signature verification, Orders v2 GET, and the service verification path are all exercised without
 * calling PayPal or spending sandbox calls in CI.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, asNewCustomer } from '../helpers/harness.mjs';

const WEBHOOK_ID = 'wh-test';
const VALID_SIG = 'valid-signature';

/** Minimal PayPal stand-in: OAuth, create order, GET order, capture, verify-webhook-signature. */
async function fakePayPal() {
  const orders = new Map();
  let seq = 0;
  let failGetOnce = false;
  const json = (res, status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://paypal.local');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    if (raw) {
      try { body = JSON.parse(raw); } catch { body = Object.fromEntries(new URLSearchParams(raw)); }
    }

    if (url.pathname === '/v1/oauth2/token') {
      return json(res, 200, { access_token: 'fake-token', expires_in: 3600, token_type: 'Bearer' });
    }
    if (url.pathname === '/v1/notifications/verify-webhook-signature') {
      // Real PayPal 400s when a signature field is missing. Mimic that so the missing-header
      // regression genuinely reproduces the old 500 (the gateway must short-circuit before this).
      if (!body.transmission_sig) return json(res, 400, { name: 'INVALID_REQUEST', message: 'Missing required signature field.' });
      const ok = body.webhook_id === WEBHOOK_ID && body.transmission_sig === VALID_SIG;
      return json(res, 200, { verification_status: ok ? 'SUCCESS' : 'FAILURE' });
    }
    if (url.pathname === '/v2/checkout/orders' && req.method === 'POST') {
      seq += 1;
      const id = `FAKE-${String(seq).padStart(6, '0')}`;
      orders.set(id, {
        id,
        status: 'CREATED',
        intent: body.intent,
        purchase_units: body.purchase_units,
        payer: { payer_id: 'FAKEPAYER', email_address: 'buyer@example.com' }
      });
      return json(res, 201, { id, status: 'CREATED' });
    }
    const getMatch = /^\/v2\/checkout\/orders\/([^/]+)$/.exec(url.pathname);
    if (getMatch && req.method === 'GET') {
      if (failGetOnce) {
        failGetOnce = false;
        return json(res, 404, { name: 'RESOURCE_NOT_FOUND' });
      }
      const order = orders.get(getMatch[1]);
      return order ? json(res, 200, order) : json(res, 404, { name: 'RESOURCE_NOT_FOUND' });
    }
    const captureMatch = /^\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(url.pathname);
    if (captureMatch && req.method === 'POST') {
      const order = orders.get(captureMatch[1]);
      if (!order) return json(res, 404, { name: 'RESOURCE_NOT_FOUND' });
      completeOrder(order.id);
      return json(res, 200, order);
    }
    return json(res, 404, { name: 'NOT_FOUND' });
  });

  /** Simulate PayPal capturing every purchase unit upstream (one capture per seller). */
  function completeOrder(paypalOrderId, mutate) {
    const order = orders.get(paypalOrderId);
    assert.ok(order, `fake PayPal has no order ${paypalOrderId}`);
    order.status = 'COMPLETED';
    order.purchase_units = order.purchase_units.map((unit, index) => ({
      ...unit,
      payments: {
        captures: [{
          id: `FAKECAP-${paypalOrderId}-${index}`,
          status: 'COMPLETED',
          amount: unit.amount,
          custom_id: unit.custom_id,
          invoice_id: unit.invoice_id,
          ...(unit.payee ? { payee: unit.payee } : {})
        }]
      }
    }));
    if (mutate) mutate(order);
    return order;
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, orders, completeOrder, failNextGet() { failGetOnce = true; } };
}

const paypal = await fakePayPal();
const app = await startServer({
  seed: 'catalogue',
  env: {
    PAYPAL_MODE: 'sandbox',
    PAYPAL_CLIENT_ID: 'fake-client',
    PAYPAL_CLIENT_SECRET: 'fake-secret',
    PAYPAL_API_BASE_URL: paypal.base,
    PAYPAL_WEBHOOK_ID: WEBHOOK_ID,
    PAYPAL_SETTLEMENT: 'split',
    PLATFORM_FEE_BPS: '500',
    PAYPAL_PAYEE_VERTEX_SYSTEMS: 'vertex@business.example.com',
    PAYPAL_PAYEE_NOVATECH_RETAIL: 'nova@business.example.com',
    PAYPAL_PAYEE_AUDIOPEAK: 'audio@business.example.com'
  }
});

test.after(async () => {
  await app.stop();
  await new Promise((resolve) => paypal.server.close(resolve));
});

async function cartAcrossSellers(client, howMany = 2) {
  const products = (await client.call('/products?limit=24')).body.items.filter((p) => p.stock > 0);
  const byMerchant = new Map();
  for (const p of products) {
    const name = p.merchant?.name;
    if (!name) continue;
    const best = byMerchant.get(name);
    if (!best || p.stock > best.stock) byMerchant.set(name, p);
  }
  const picks = [...byMerchant.values()].sort((a, b) => b.stock - a.stock).slice(0, howMany);
  assert.equal(picks.length, howMany);
  for (const product of picks) {
    const added = await client.call('/cart/items', { method: 'POST', body: { productId: product.id, quantity: 1 } });
    assert.equal(added.status, 200, JSON.stringify(added.body));
  }
  return picks;
}

async function placeOrder(client, sellers = 2) {
  await cartAcrossSellers(client, sellers);
  const quote = await client.call('/checkout/quote', { method: 'POST', body: { extendHolds: true } });
  assert.equal(quote.status, 200, JSON.stringify(quote.body));
  const created = await client.call('/orders', {
    method: 'POST',
    body: {
      quoteId: quote.body.quote.id,
      quoteHash: quote.body.quote.hash,
      contact: { email: 'webhook@example.com', name: 'Webhook Tester' }
    }
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body;
}

function captureEvent(paypalOrder, captureIndex = 0, eventId = `evt-${Date.now()}-${Math.random().toString(16).slice(2)}`) {
  const unit = paypalOrder.purchase_units[captureIndex];
  const capture = unit.payments.captures[0];
  return {
    id: eventId,
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource_type: 'capture',
    create_time: new Date().toISOString(),
    resource: {
      id: capture.id,
      status: capture.status,
      amount: capture.amount,
      custom_id: unit.custom_id,
      invoice_id: unit.invoice_id,
      supplementary_data: { related_ids: { order_id: paypalOrder.id } }
    }
  };
}

function webhookHeaders(signature = VALID_SIG) {
  return {
    'content-type': 'application/json',
    'paypal-transmission-id': 'transmission-1',
    'paypal-transmission-time': new Date().toISOString(),
    'paypal-cert-url': 'https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-TEST',
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-transmission-sig': signature
  };
}

async function postWebhook(event, signature = VALID_SIG) {
  const res = await fetch(`${app.base}/api/v1/webhooks/paypal`, {
    method: 'POST',
    headers: webhookHeaders(signature),
    body: JSON.stringify(event)
  });
  return { status: res.status, body: await res.json() };
}

test('a signed split-order capture webhook verifies the full PayPal order and marks the order paid', async () => {
  const client = await asNewCustomer(app.base, 'wh-split');
  const created = await placeOrder(client, 2);
  const orderId = created.order.id;
  const paypalOrderId = created.payment.paypalOrderId;
  assert.equal(created.order.payment.settlement.mode, 'split');

  // PayPal captured upstream, but our synchronous capture write was lost.
  const upstream = paypal.completeOrder(paypalOrderId);
  const result = await postWebhook(captureEvent(upstream, 0, 'evt-split-happy'));
  assert.equal(result.status, 200);
  assert.equal(result.body.received, true);

  const fresh = await client.call(`/orders/${orderId}`);
  assert.equal(fresh.body.order.status, 'paid', JSON.stringify(fresh.body.order.payment));
  assert.equal(fresh.body.order.payment.amountVerified, true);
  assert.equal(fresh.body.order.payment.captures.length, 2, 'every seller capture is persisted');
  const total = fresh.body.order.payment.captures.reduce((sum, c) => sum + c.amountMinor, 0);
  assert.equal(total, fresh.body.order.amounts.totalMinor);
  const capturedEvents = fresh.body.order.timeline.filter((e) => e.event === 'payment_captured');
  assert.equal(capturedEvents.length, 1, 'exactly one paid transition');
});

test('duplicate and concurrent split webhooks converge on one paid order', async () => {
  const client = await asNewCustomer(app.base, 'wh-dedupe');
  const created = await placeOrder(client, 2);
  const orderId = created.order.id;
  const upstream = paypal.completeOrder(created.payment.paypalOrderId);
  const event = captureEvent(upstream, 0, 'evt-split-dedupe');

  const concurrent = await Promise.all(Array.from({ length: 5 }, () => postWebhook(event)));
  assert.ok(concurrent.every((r) => r.status === 200));
  const replay = await postWebhook(event);
  assert.equal(replay.body.deduplicated, true);

  const fresh = await client.call(`/orders/${orderId}`);
  assert.equal(fresh.body.order.status, 'paid');
  assert.equal(fresh.body.order.timeline.filter((e) => e.event === 'payment_captured').length, 1);
  assert.equal(fresh.body.order.payment.captures.length, 2);
});

test('an invalid webhook signature never marks an order paid or fetches the order', async () => {
  const client = await asNewCustomer(app.base, 'wh-badsig');
  const created = await placeOrder(client, 2);
  const upstream = paypal.completeOrder(created.payment.paypalOrderId);
  const before = paypal.orders.get(upstream.id);
  const result = await postWebhook(captureEvent(upstream, 0, 'evt-bad-sig'), 'forged-signature');
  assert.equal(result.status, 200);
  assert.equal(result.body.received, true);

  const fresh = await client.call(`/orders/${created.order.id}`);
  assert.notEqual(fresh.body.order.status, 'paid');
  assert.equal(fresh.body.order.payment.amountVerified, false);
  assert.equal(before.status, 'COMPLETED', 'upstream state is untouched by verification');
});

test('a split webhook whose full order short-changes a seller is rejected', async () => {
  const client = await asNewCustomer(app.base, 'wh-short');
  const created = await placeOrder(client, 2);
  const upstream = paypal.completeOrder(created.payment.paypalOrderId, (order) => {
    const capture = order.purchase_units[1].payments.captures[0];
    capture.amount = { ...capture.amount, value: (Number(capture.amount.value) - 1).toFixed(2) };
  });
  await postWebhook(captureEvent(upstream, 0, 'evt-short'));
  const fresh = await client.call(`/orders/${created.order.id}`);
  assert.notEqual(fresh.body.order.status, 'paid');
  assert.equal(fresh.body.order.payment.amountVerified, false);
});

test('a split webhook missing one seller capture is rejected', async () => {
  const client = await asNewCustomer(app.base, 'wh-missing');
  const created = await placeOrder(client, 2);
  const upstream = paypal.completeOrder(created.payment.paypalOrderId, (order) => {
    order.purchase_units[1].payments.captures = [];
  });
  await postWebhook(captureEvent(upstream, 0, 'evt-missing'));
  const fresh = await client.call(`/orders/${created.order.id}`);
  assert.notEqual(fresh.body.order.status, 'paid');
});

test('a pending split capture stays unpaid until a later completed webhook verifies every seller', async () => {
  const client = await asNewCustomer(app.base, 'wh-pending');
  const created = await placeOrder(client, 2);
  const paypalOrderId = created.payment.paypalOrderId;
  const pending = paypal.completeOrder(paypalOrderId, (order) => {
    order.status = 'APPROVED';
    for (const unit of order.purchase_units) unit.payments.captures[0].status = 'PENDING';
  });
  await postWebhook(captureEvent(pending, 0, 'evt-pending'));
  let fresh = await client.call(`/orders/${created.order.id}`);
  assert.notEqual(fresh.body.order.status, 'paid');

  paypal.completeOrder(paypalOrderId);
  const completed = paypal.orders.get(paypalOrderId);
  await postWebhook(captureEvent(completed, 0, 'evt-pending-complete'));
  fresh = await client.call(`/orders/${created.order.id}`);
  assert.equal(fresh.body.order.status, 'paid');
  assert.equal(fresh.body.order.payment.captures.length, 2);
});

test('a single-seller webhook still recovers a paid order through the same verified path', async () => {
  const client = await asNewCustomer(app.base, 'wh-single');
  const created = await placeOrder(client, 1);
  assert.equal(created.order.payment.settlement.mode, 'single');
  const upstream = paypal.completeOrder(created.payment.paypalOrderId);
  await postWebhook(captureEvent(upstream, 0, 'evt-single'));
  const fresh = await client.call(`/orders/${created.order.id}`);
  assert.equal(fresh.body.order.status, 'paid');
  assert.equal(fresh.body.order.payment.captures.length, 1);
  assert.equal(fresh.body.order.payment.captures[0].amountMinor, fresh.body.order.amounts.totalMinor);
});

test('a failed webhook processing pass is retryable and converges on the retry', async () => {
  const client = await asNewCustomer(app.base, 'wh-retry');
  const created = await placeOrder(client, 2);
  const upstream = paypal.completeOrder(created.payment.paypalOrderId);
  const event = captureEvent(upstream, 0, 'evt-retry');

  // The full-order read fails once (PayPal 404/5xx). The pass must be recorded as errored, NOT as
  // successfully applied, and the order must stay unpaid.
  paypal.failNextGet();
  const first = await postWebhook(event);
  assert.equal(first.status, 200);
  assert.notEqual(first.body.deduplicated, true);
  let fresh = await client.call(`/orders/${created.order.id}`);
  assert.notEqual(fresh.body.order.status, 'paid', 'a failed read must not mark the order paid');

  // PayPal retries the same event id; the errored pass must be reprocessable and converge.
  const retry = await postWebhook(event);
  assert.equal(retry.status, 200);
  assert.notEqual(retry.body.deduplicated, true, 'an errored event must be reprocessable');
  fresh = await client.call(`/orders/${created.order.id}`);
  assert.equal(fresh.body.order.status, 'paid');
  assert.equal(fresh.body.order.payment.captures.length, 2);
  assert.equal(fresh.body.order.timeline.filter((e) => e.event === 'payment_captured').length, 1);
});

test('late approval and pending webhooks never downgrade a paid order', async () => {
  const client = await asNewCustomer(app.base, 'wh-late');
  const created = await placeOrder(client, 2);
  const paypalOrderId = created.payment.paypalOrderId;
  const upstream = paypal.completeOrder(paypalOrderId);
  await postWebhook(captureEvent(upstream, 0, 'evt-late-complete'));
  let fresh = await client.call(`/orders/${created.order.id}`);
  assert.equal(fresh.body.order.status, 'paid');

  const capture = upstream.purchase_units[0].payments.captures[0];
  await postWebhook({
    id: 'evt-late-approved',
    event_type: 'CHECKOUT.ORDER.APPROVED',
    resource_type: 'checkout-order',
    resource: { id: paypalOrderId, status: 'APPROVED' }
  });
  await postWebhook({
    id: 'evt-late-pending',
    event_type: 'PAYMENT.CAPTURE.PENDING',
    resource_type: 'capture',
    resource: { id: capture.id, status: 'PENDING', amount: capture.amount, supplementary_data: { related_ids: { order_id: paypalOrderId } } }
  });

  fresh = await client.call(`/orders/${created.order.id}`);
  assert.equal(fresh.body.order.status, 'paid', 'a late approval/pending must not downgrade a paid order');
  assert.equal(fresh.body.order.payment.status, 'captured');
  assert.equal(fresh.body.order.payment.amountVerified, true);
});

test('a webhook with no signature headers is answered 200 (unverified), never 500', async () => {
  // Regression: missing paypal-* signature headers used to reach PayPal verification with undefined
  // fields, which 400s and threw out of the endpoint as 500 — PayPal would then retry forever. The
  // gateway now short-circuits missing headers and ingestWebhook catches any verification error.
  const res = await fetch(`${app.base}/api/v1/webhooks/paypal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'evt-no-sig-headers', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource_type: 'capture', resource: { id: 'CAP-NOSIG' } })
  });
  assert.equal(res.status, 200, 'a bad webhook request must be answered 200, not 500');
  const body = await res.json();
  assert.equal(body.received, true);
});
