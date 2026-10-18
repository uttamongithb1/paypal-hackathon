/**
 * Integration tests over real HTTP: session → cart → quote → order → declined capture → retry →
 * verified capture → paid, plus idempotency, webhooks and merchant scoping.
 * Each file boots its own server process with a throwaway store (tests/helpers/harness.mjs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, asCustomer, asNewCustomer, asMerchant, createClient, DEMO } from '../helpers/harness.mjs';

const server = await startServer({ seed: 'catalogue' });
test.after(async () => {
  await server.stop();
});

const { base } = server;

/**
 * Adds a laptop to the caller's cart. Products are ordered by stock (descending) so that tests
 * which do not care which model they buy always consume the roomiest one; pass `pick: 'lowest'`
 * when the test needs a scarce product (stock capping).
 */
async function addProductToCart(client, { quantity = 1, pick = 'highest' } = {}) {
  const products = await client.call('/products?category=laptops&limit=12');
  const byStock = [...products.body.items].sort((a, b) => b.stock - a.stock);
  const product = pick === 'lowest' ? byStock[byStock.length - 1] : pick === 'highest' ? byStock[0] : byStock[pick];
  const added = await client.call('/cart/items', { method: 'POST', body: { productId: product.id, quantity } });
  assert.equal(added.status, 200, `POST /cart/items is a 200 per docs/api_spec.md — got ${added.status} ${JSON.stringify(added.body)}`);
  return { product, cart: added.body.cart };
}

test('guest session issues a cart and a CSRF token, and mutations require the token', async () => {
  const client = createClient(base);
  const guest = await client.guest();
  assert.equal(guest.status, 200);
  assert.equal(guest.body.user.role, 'guest');
  assert.ok(guest.body.cart);
  assert.ok(client.cookies.get('csrf'), 'csrf cookie must be set for the double-submit check');

  const noCsrf = await client.call('/cart/items', { method: 'POST', body: { productId: 'x', quantity: 1 }, csrf: false });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.body.error.code, 'FORBIDDEN');
});

test('guest shopper can place an order by providing contact email without signing in', async () => {
  const client = createClient(base);
  await client.guest();
  const { product } = await addProductToCart(client, { quantity: 1 });
  const quote = await client.call('/checkout/quote', { method: 'POST', body: { extendHolds: true } });
  assert.equal(quote.status, 200);

  const orderRes = await client.call('/orders', {
    method: 'POST',
    body: {
      quoteId: quote.body.quote.id,
      quoteHash: quote.body.quote.hash,
      contact: { email: 'guest.shopper@demo.dev', name: 'Guest Shopper' }
    }
  });
  assert.equal(orderRes.status, 201, `guest order creation failed: ${JSON.stringify(orderRes.body)}`);
  assert.equal(orderRes.body.order.status, 'awaiting_payment');
  assert.equal(orderRes.body.order.contact.email, 'guest.shopper@demo.dev');
});

test('cart maths come from the server, not from the client', async () => {
  const client = await asNewCustomer(base, 'cart-maths');
  const { cart } = await addProductToCart(client, { quantity: 2 });
  const expected = cart.items.reduce((sum, item) => sum + item.lineTotalMinor, 0);
  assert.equal(cart.subtotalMinor, expected);
  assert.match(cart.display, /^\$/);
});

test('adding beyond stock caps the quantity and reports it', async () => {
  const client = await asNewCustomer(base, 'stock-cap');
  const { product } = await addProductToCart(client, { quantity: 1, pick: 'lowest' });
  const over = await client.call('/cart/items', { method: 'POST', body: { productId: product.id, quantity: 10 } });
  assert.equal(over.status, 409);
  assert.equal(over.body.error.code, 'INSUFFICIENT_STOCK');
  assert.ok(over.body.error.details.applied <= over.body.error.details.available);
});

test('quote → order → decline → retry → capture ends in exactly one verified payment', async () => {
  const client = await asNewCustomer(base, 'payment');
  await addProductToCart(client, { quantity: 1 });

  const quote = await client.call('/checkout/quote', { method: 'POST', body: { extendHolds: true } });
  assert.equal(quote.status, 200, JSON.stringify(quote.body));
  const amounts = quote.body.quote.amounts;
  assert.equal(amounts.totalMinor, amounts.subtotalMinor + amounts.shippingMinor + amounts.taxMinor);

  const idempotencyKey = `it-order-${Date.now()}`;
  const body = {
    quoteId: quote.body.quote.id,
    quoteHash: quote.body.quote.hash,
    contact: { email: DEMO.customer.email, name: 'Integration Test' }
  };
  const created = await client.call('/orders', { method: 'POST', body, headers: { 'idempotency-key': idempotencyKey } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const orderId = created.body.order.id;
  assert.match(created.body.order.orderNumber, /^SP-\d{4}-\d{6}$/);
  assert.equal(created.body.order.status, 'awaiting_payment');
  assert.ok(created.body.payment.paypalOrderId);

  const replay = await client.call('/orders', { method: 'POST', body, headers: { 'idempotency-key': idempotencyKey } });
  assert.equal(replay.status, created.status, 'a replay returns the stored response status');
  assert.equal(replay.headers.get('idempotent-replay'), 'true');
  assert.equal(replay.body.order.id, orderId);

  const declined = await client.call(`/payments/${orderId}/capture`, {
    method: 'POST',
    body: { paypalOrderId: created.body.payment.paypalOrderId, simulatedOutcome: 'decline' },
    headers: { 'idempotency-key': `it-cap-${orderId}-1` }
  });
  assert.equal(declined.status, 402);
  assert.equal(declined.body.error.code, 'PAYMENT_DECLINED');

  const afterDecline = await client.call(`/orders/${orderId}`);
  assert.equal(afterDecline.body.order.status, 'payment_failed');
  assert.equal(afterDecline.body.order.payment.paypalCaptureId, undefined);
  assert.ok(afterDecline.body.order.timeline.some((entry) => entry.event === 'status_payment_failed'), 'the timeline records the failed status transition');

  const retry = await client.call(`/payments/${orderId}/retry`, { method: 'POST', body: {} });
  assert.equal(retry.status, 201, JSON.stringify(retry.body));
  assert.equal(retry.body.payment.attemptNo, 2);

  const captured = await client.call(`/payments/${orderId}/capture`, {
    method: 'POST',
    body: { paypalOrderId: retry.body.payment.paypalOrderId, simulatedOutcome: 'approve' },
    headers: { 'idempotency-key': `it-cap-${orderId}-2` }
  });
  assert.equal(captured.status, 200, JSON.stringify(captured.body));
  assert.equal(captured.body.order.status, 'paid');
  assert.equal(captured.body.payment.amountVerified, true);
  assert.ok(captured.body.payment.captureId.startsWith('SIMCAP-'));

  const replayCapture = await client.call(`/payments/${orderId}/capture`, {
    method: 'POST',
    body: { paypalOrderId: retry.body.payment.paypalOrderId },
    headers: { 'idempotency-key': `it-cap-${orderId}-2` }
  });
  assert.equal(replayCapture.status, 200);
  assert.equal(replayCapture.headers.get('idempotent-replay'), 'true', 'the second click is an idempotent replay');
  assert.equal(replayCapture.body.payment.captureId, captured.body.payment.captureId, 'no second charge, same capture');
});

test('a mismatched capture amount never marks the order paid', async () => {
  const client = await asNewCustomer(base, 'mismatch');
  await addProductToCart(client, { quantity: 1 });
  const quote = await client.call('/checkout/quote', { method: 'POST', body: {} });
  const order = await client.call('/orders', {
    method: 'POST',
    body: { quoteId: quote.body.quote.id, quoteHash: quote.body.quote.hash, contact: { email: DEMO.customer.email, name: 'Mismatch' } },
    headers: { 'idempotency-key': `mismatch-${Date.now()}` }
  });
  const attempt = await client.call(`/payments/${order.body.order.id}/retry`, { method: 'POST', body: {} });
  const result = await client.call(`/payments/${order.body.order.id}/capture`, {
    method: 'POST',
    body: { paypalOrderId: attempt.body.payment.paypalOrderId, simulatedOutcome: 'amount_mismatch' },
    headers: { 'idempotency-key': `mismatch-cap-${order.body.order.id}` }
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'PAYMENT_VERIFICATION_FAILED', 'docs/api_spec.md §7: verification failures are 409 with details.checks');
  assert.equal(result.body.error.details.checks.amountOk, false, 'the failing check is reported for support');
  assert.equal(result.body.error.details.checks.orderRefOk, true);
  const after = await client.call(`/orders/${order.body.order.id}`);
  assert.notEqual(after.body.order.status, 'paid');
});

test('pending captures stay unverified and reconcile later without double charging', async () => {
  const client = await asNewCustomer(base, 'pending');
  await addProductToCart(client, { quantity: 1, pick: 3 });
  const quote = await client.call('/checkout/quote', { method: 'POST', body: {} });
  const order = await client.call('/orders', {
    method: 'POST',
    body: { quoteId: quote.body.quote.id, quoteHash: quote.body.quote.hash, contact: { email: DEMO.customer.email, name: 'Pending' } },
    headers: { 'idempotency-key': `pending-${Date.now()}` }
  });
  const orderId = order.body.order.id;
  const pending = await client.call(`/payments/${orderId}/capture`, {
    method: 'POST',
    body: { paypalOrderId: order.body.payment.paypalOrderId, simulatedOutcome: 'pending' },
    headers: { 'idempotency-key': `pending-cap-${orderId}` }
  });
  assert.equal(pending.status, 202);
  const status = await client.call(`/payments/${orderId}/status`);
  assert.equal(status.status, 200);
  assert.ok(['pending', 'requires_action'].includes(status.body.paymentStatus), `paymentStatus was ${status.body.paymentStatus}`);
  assert.notEqual(status.body.orderStatus, 'paid');
  const orderState = await client.call(`/orders/${orderId}`);
  assert.notEqual(orderState.body.order.status, 'paid');
});

test('webhooks are verified, deduplicated and never downgrade a paid order', async () => {
  const client = await asNewCustomer(base, 'webhook');
  await addProductToCart(client, { quantity: 1 });
  const quote = await client.call('/checkout/quote', { method: 'POST', body: {} });
  const order = await client.call('/orders', {
    method: 'POST',
    body: { quoteId: quote.body.quote.id, quoteHash: quote.body.quote.hash, contact: { email: DEMO.customer.email, name: 'Webhook' } },
    headers: { 'idempotency-key': `webhook-${Date.now()}` }
  });
  const orderId = order.body.order.id;
  await client.call(`/payments/${orderId}/capture`, {
    method: 'POST',
    body: { paypalOrderId: order.body.payment.paypalOrderId, simulatedOutcome: 'approve' },
    headers: { 'idempotency-key': `webhook-cap-${orderId}` }
  });

  const duplicate = await client.call(`/dev/paypal/webhook/${orderId}`, { method: 'POST', body: { eventType: 'PAYMENT.CAPTURE.COMPLETED' } });
  assert.equal(duplicate.status, 200);
  const after = await client.call(`/orders/${orderId}`);
  assert.equal(after.body.order.status, 'paid', 'a duplicate webhook must not downgrade a paid order');

  const unsigned = await fetch(`${base}/api/v1/webhooks/paypal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `evt_${Date.now()}`, event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {} })
  });
  assert.equal(unsigned.status, 200);
  const payload = await unsigned.json();
  assert.equal(payload.received, true);
});

test('merchant endpoints are role-scoped and expose the payment trail', async () => {
  const customer = await asCustomer(base);
  const forbidden = await customer.call('/merchant/overview');
  assert.equal(forbidden.status, 403);

  const merchant = await asMerchant(base);
  const overview = await merchant.call('/merchant/overview');
  assert.equal(overview.status, 200);
  // Shape per docs/api_spec.md §9.
  for (const key of ['revenueMinor', 'paidOrders', 'avgOrderValueMinor', 'conversionRateBps', 'lowStock', 'recentOrders']) {
    assert.ok(key in overview.body, `overview is missing ${key}`);
  }
  assert.ok(Array.isArray(overview.body.recentOrders));

  const analytics = await merchant.call('/merchant/analytics?range=30d');
  assert.equal(analytics.status, 200);
  const funnel = analytics.body.funnel;
  assert.ok(funnel.views >= funnel.cartAdds);
  assert.ok(funnel.cartAdds >= funnel.checkoutAttempts);
  assert.ok(funnel.checkoutAttempts >= funnel.purchases);

  const orders = await merchant.call('/merchant/orders?limit=5');
  assert.equal(orders.status, 200);
  if (orders.body.items.length) {
    const attempts = await merchant.call(`/merchant/orders/${orders.body.items[0].id}/attempts`);
    assert.equal(attempts.status, 200);
    assert.ok(Array.isArray(attempts.body.items));
  }
});

test('a merchant price change invalidates the quote instead of silently charging more', async () => {
  const merchant = await asMerchant(base);
  const mine = await merchant.call('/merchant/products?limit=50');
  const owned = mine.body.items.find((p) => p.stock >= 2);
  assert.ok(owned, 'the demo merchant must own at least one stocked product');

  const customer = await asNewCustomer(base, 'stale');
  const added = await customer.call('/cart/items', { method: 'POST', body: { productId: owned.id, quantity: 1 } });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const product = { id: owned.id, price: owned.price };
  const quote = await customer.call('/checkout/quote', { method: 'POST', body: {} });
  const newPrice = product.price.amountMinor + 5000;
  const updated = await merchant.call(`/merchant/products/${product.id}`, { method: 'PATCH', body: { priceMinor: newPrice } });
  assert.equal(updated.status, 200);

  const order = await customer.call('/orders', {
    method: 'POST',
    body: { quoteId: quote.body.quote.id, quoteHash: quote.body.quote.hash, contact: { email: DEMO.customer.email, name: 'Stale' } },
    headers: { 'idempotency-key': `stale-${Date.now()}` }
  });
  assert.equal(order.status, 409);
  assert.equal(order.body.error.code, 'QUOTE_STALE');
  await merchant.call(`/merchant/products/${product.id}`, { method: 'PATCH', body: { priceMinor: product.price.amountMinor } });
});

test('cancelling an unpaid order releases the stock hold', async () => {
  const client = await asNewCustomer(base, 'cancel');
  const { product } = await addProductToCart(client, { quantity: 1 });
  // REST product DTO exposes stock as a number (available = stock − active holds).
  const before = (await client.call(`/products/${product.slug}`)).body.product.stock;
  const quote = await client.call('/checkout/quote', { method: 'POST', body: {} });
  const held = (await client.call(`/products/${product.slug}`)).body.product.stock;
  assert.ok(held < before, 'quoting holds the unit, so availability drops');
  const order = await client.call('/orders', {
    method: 'POST',
    body: { quoteId: quote.body.quote.id, quoteHash: quote.body.quote.hash, contact: { email: DEMO.customer.email, name: 'Cancel' } },
    headers: { 'idempotency-key': `cancel-${Date.now()}` }
  });
  const cancelled = await client.call(`/orders/${order.body.order.id}/cancel`, { method: 'POST', body: { reason: 'customer_cancelled' } });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.order.status, 'cancelled');
  const released = (await client.call(`/products/${product.slug}`)).body.product.stock;
  assert.equal(released, before, 'cancelling releases the hold, so availability returns to the pre-quote value');
});

test('GET /version publishes exactly what the storefront needs to mount PayPal', async () => {
  // The browser SDK can only render Buttons when it learns the public client id here; in
  // simulator mode it must stay null so the UI shows the simulator controls instead.
  const res = await createClient(base).call('/version');
  assert.equal(res.status, 200);
  const body = res.body;
  for (const key of ['version', 'node', 'currency', 'paypalEnv', 'paypalMode', 'features']) {
    assert.ok(key in body, `/version is missing ${key}`);
  }
  assert.equal(body.paypalMode, 'simulator');
  assert.equal(body.paypalClientId, null, 'simulator mode must not advertise a client id');
  assert.equal(body.paypalSdkReady, false);
  assert.equal(body.currency, 'USD');
  assert.ok(body.features.analytics === true);
  assert.ok('liveLlm' in body.features, 'judges and the UI need to see whether a real model is on');
});

test('merchant can refund a paid order, transitioning state and updating payment', async () => {
  const customer = await asNewCustomer(base, 'refund-cust');
  const merchant = await asMerchant(base);
  const prods = await customer.call('/products?category=laptops&limit=20');
  const product = prods.body.items.find((p) => p.merchant?.slug === 'vertex-systems' || p.brand === 'Vertex Systems');
  await customer.call('/cart/items', { method: 'POST', body: { productId: product.id, quantity: 1 } });
  const quote = await customer.call('/checkout/quote', { method: 'POST', body: {} });
  const orderRes = await customer.call('/orders', {
    method: 'POST',
    body: { quoteId: quote.body.quote.id, quoteHash: quote.body.quote.hash, contact: { email: DEMO.customer.email, name: 'Refund Test' } }
  });
  const orderId = orderRes.body.order.id;
  await customer.call(`/payments/${orderId}/capture`, {
    method: 'POST',
    body: { paypalOrderId: orderRes.body.payment.paypalOrderId, simulatedOutcome: 'approve' }
  });

  const paidOrder = await customer.call(`/orders/${orderId}`);
  assert.equal(paidOrder.body.order.status, 'paid');

  const refundRes = await merchant.call(`/merchant/orders/${orderId}/refund`, {
    method: 'POST',
    body: { reason: 'Customer return' }
  });
  assert.equal(refundRes.status, 200, JSON.stringify(refundRes.body));
  assert.equal(refundRes.body.order.status, 'refunded');

  const afterRefund = await customer.call(`/orders/${orderId}`);
  assert.equal(afterRefund.body.order.status, 'refunded');
  assert.equal(afterRefund.body.order.payment.status, 'refunded');
  assert.ok(afterRefund.body.order.payment.refundId);
});


test('a second guest using an email that is already claimed still gets an order', async () => {
  // The shopper's email is claimed on the guest record, and emails are unique. A second guest on
  // the same device — or the same shopper coming back without signing in — used to get a 409
  // duplicate-key error and no order at all. The order only needs the address for its receipt.
  const email = 'repeat.shopper@demo.dev';
  const first = createClient(base);
  await first.guest();
  const products = await first.call('/products?limit=24');
  const product = products.body.items.filter((p) => p.stock > 3).sort((a, b) => b.stock - a.stock)[0];
  await first.call('/cart/items', { method: 'POST', body: { productId: product.id, quantity: 1 } });
  const firstQuote = await first.call('/checkout/quote', { method: 'POST', body: { extendHolds: true } });
  const firstOrder = await first.call('/orders', {
    method: 'POST',
    body: { quoteId: firstQuote.body.quote.id, quoteHash: firstQuote.body.quote.hash, contact: { email, name: 'Repeat Shopper' } }
  });
  assert.equal(firstOrder.status, 201, JSON.stringify(firstOrder.body));

  const second = createClient(base);
  await second.guest();
  const other = products.body.items.filter((p) => p.stock > 3).sort((a, b) => b.stock - a.stock)[1];
  await second.call('/cart/items', { method: 'POST', body: { productId: other.id, quantity: 1 } });
  const secondQuote = await second.call('/checkout/quote', { method: 'POST', body: { extendHolds: true } });
  const secondOrder = await second.call('/orders', {
    method: 'POST',
    body: { quoteId: secondQuote.body.quote.id, quoteHash: secondQuote.body.quote.hash, contact: { email, name: 'Repeat Shopper' } }
  });
  assert.equal(secondOrder.status, 201, `the second order failed: ${JSON.stringify(secondOrder.body)}`);
  assert.equal(secondOrder.body.order.contact.email, email);
});
