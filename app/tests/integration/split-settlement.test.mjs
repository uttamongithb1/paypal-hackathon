/**
 * Multi-merchant (split) settlement over real HTTP.
 *
 * The bug this covers: a cart spanning several sellers used to produce ONE purchase unit with no
 * `payee`, so PayPal would pay the platform account and the sellers would get nothing. These tests
 * pin the fixed behaviour end to end — one PayPal order, one unit per seller, per-unit captures,
 * every unit's amount summing exactly to the order total, and an honest fallback when the
 * account is not enabled for multi-seller payments.
 *
 * Docs: ../docs/payments_paypal.md (multi-seller section), WIN_PLAN.md F1.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, asNewCustomer } from '../helpers/harness.mjs';

const server = await startServer({ seed: 'catalogue', env: { PAYPAL_SETTLEMENT: 'split', PLATFORM_FEE_BPS: '500' } });
const fallbackServer = await startServer({ seed: 'catalogue', env: { PAYPAL_SETTLEMENT: 'auto', PAYPAL_SIM_SPLIT_UNSUPPORTED: 'true' } });
const singleServer = await startServer({ seed: 'catalogue', env: { PAYPAL_SETTLEMENT: 'single' } });

test.after(async () => {
  await server.stop();
  await fallbackServer.stop();
  await singleServer.stop();
});

/**
 * Puts one in-stock item from each of the two roomiest merchants in the cart.
 *
 * Products are picked by remaining stock because these tests run against one shared seeded
 * catalogue: a fixed pick list would sell the same product out and fail the later tests on
 * INSUFFICIENT_STOCK rather than on anything to do with settlement.
 */
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
  assert.equal(picks.length, howMany, `fixture needs ${howMany} merchants with stock, found ${picks.length}`);
  for (const product of picks) {
    const added = await client.call('/cart/items', { method: 'POST', body: { productId: product.id, quantity: 1 } });
    assert.equal(added.status, 200, JSON.stringify(added.body));
  }
  return picks;
}

async function placeOrder(client, { place = 1 } = {}) {
  const quote = await client.call('/checkout/quote', { method: 'POST', body: { extendHolds: true } });
  assert.equal(quote.status, 200, JSON.stringify(quote.body));
  const created = await client.call('/orders', {
    method: 'POST',
    body: { quoteId: quote.body.quote.id, quoteHash: quote.body.quote.hash, contact: { email: 'split@example.com', name: 'Split Tester' } }
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created;
}

const pay = (client, orderNumber, payment) => client.call(`/payments/${orderNumber}/capture`, {
  method: 'POST',
  body: { paypalOrderId: payment.paypalOrderId, simulatedOutcome: 'approve' }
});

test('a cart across two sellers produces one PayPal order with a unit per seller', async () => {
  const client = await asNewCustomer(server.base, 'split-two');
  await cartAcrossSellers(client);
  const created = await placeOrder(client);

  assert.equal(created.body.order.status, 'awaiting_payment');
  assert.equal(created.body.order.payment.status, 'created');
  assert.ok(created.body.payment.paypalOrderId, 'the buyer is handed a PayPal order to approve');

  const settlement = created.body.order.payment.settlement;
  assert.equal(settlement.mode, 'split', 'two sellers must settle as a split');
  assert.equal(settlement.units.length, 2);

  const total = created.body.order.amounts.totalMinor;
  const sum = settlement.units.reduce((s, u) => s + u.amountMinor, 0);
  assert.equal(sum, total, 'seller amounts must sum exactly to the order total');
  for (const unit of settlement.units) {
    assert.ok(unit.payeeEmail, 'every unit must name the account that gets paid');
    assert.ok(unit.platformFeeMinor >= 0 && unit.platformFeeMinor < unit.amountMinor, 'the commission may never consume the whole unit');
  }
  // Commission is proportional, and the total is reported for the merchant dashboard.
  const expectedFee = settlement.units.reduce((s, u) => s + Math.round((u.amountMinor * 500) / 10_000), 0);
  assert.equal(settlement.totals.platformFeeMinor, expectedFee);
});

test('capture records one completed payment per seller, summing to the order total', async () => {
  const client = await asNewCustomer(server.base, 'split-capture');
  await cartAcrossSellers(client);
  const created = await placeOrder(client);
  const total = created.body.order.amounts.totalMinor;

  const captured = await pay(client, created.body.order.id, created.body.payment);
  assert.equal(captured.status, 200, JSON.stringify(captured.body));
  assert.equal(captured.body.order.status, 'paid');
  assert.equal(captured.body.payment.amountVerified, true);

  const fresh = await client.call(`/orders/${created.body.order.id}`);
  const captures = fresh.body.order.payment.captures;
  assert.equal(captures.length, 2, 'each seller gets its own capture');
  assert.equal(captures.reduce((s, c) => s + c.amountMinor, 0), total, 'captures must reconcile to the total');
  assert.ok(captures.every((c) => c.status === 'COMPLETED'));
  assert.equal(new Set(captures.map((c) => c.id)).size, captures.length, 'capture ids are distinct');
});

test('the timeline records that settlement was split, so the demo can show it', async () => {
  const client = await asNewCustomer(server.base, 'split-timeline');
  await cartAcrossSellers(client);
  const created = await placeOrder(client);
  await pay(client, created.body.order.id, created.body.payment);

  const fresh = await client.call(`/orders/${created.body.order.id}`);
  const events = fresh.body.order.timeline.map((e) => e.event);
  assert.ok(events.includes('settlement_split'), `expected settlement_split in ${events.join(', ')}`);
  const entry = fresh.body.order.timeline.find((e) => e.event === 'settlement_split');
  assert.equal(entry.meta.sellers, 2);
  assert.ok(entry.meta.platformFeeMinor > 0);
});

test('a capability rejection falls back to one unit and says so, without breaking payment', async () => {
  const client = await asNewCustomer(fallbackServer.base, 'split-fallback');
  await cartAcrossSellers(client);
  const created = await placeOrder(client);

  const settlement = created.body.order.payment.settlement;
  assert.equal(settlement.mode, 'single', 'an account without the capability must not be sent a split order');
  assert.ok(settlement.reason.length > 0, 'the fallback must be explained, not silent');

  // The buyer experience is unaffected: the order still completes.
  const captured = await pay(client, created.body.order.id, created.body.payment);
  assert.equal(captured.status, 200, JSON.stringify(captured.body));
  assert.equal(captured.body.order.status, 'paid');

  const fresh = await client.call(`/orders/${created.body.order.id}`);
  const events = fresh.body.order.timeline.map((e) => e.event);
  assert.ok(events.includes('settlement_fallback'), `expected settlement_fallback in ${events.join(', ')}`);
});

test('PAYPAL_SETTLEMENT=single keeps the old single-unit behaviour byte for byte', async () => {
  const client = await asNewCustomer(singleServer.base, 'split-off');
  await cartAcrossSellers(client);
  const created = await placeOrder(client);

  assert.equal(created.body.order.payment.settlement.mode, 'single');
  assert.equal(created.body.order.payment.settlement.units.length, 1);

  const captured = await pay(client, created.body.order.id, created.body.payment);
  assert.equal(captured.status, 200, JSON.stringify(captured.body));
  const fresh = await client.call(`/orders/${created.body.order.id}`);
  assert.equal(fresh.body.order.payment.captures.length, 1);
  assert.equal(fresh.body.order.payment.captures[0].amountMinor, fresh.body.order.amounts.totalMinor);
});

/**
 * Settlement touches who gets paid, so it is exactly the place where scoping could accidentally
 * widen. `merchant@demo.dev` owns Vertex Systems; this pins that they see the split order they
 * took part in, and only that.
 */
test('split settlement does not widen what a seller can see', async () => {
  const buyer = await asNewCustomer(server.base, 'split-scope');
  const all = (await buyer.call('/products?limit=24')).body.items.filter((p) => p.stock > 0);
  const vertex = all.filter((p) => p.merchant?.name === 'Vertex Systems').sort((a, b) => b.stock - a.stock)[0];
  const other = all.filter((p) => p.merchant?.name !== 'Vertex Systems').sort((a, b) => b.stock - a.stock)[0];
  assert.ok(vertex && other, 'fixture needs one Vertex product and one from another seller');
  for (const product of [vertex, other]) {
    assert.equal((await buyer.call('/cart/items', { method: 'POST', body: { productId: product.id, quantity: 1 } })).status, 200);
  }
  const shared = await placeOrder(buyer);
  assert.equal(shared.body.order.payment.settlement.mode, 'split');
  await pay(buyer, shared.body.order.id, shared.body.payment);

  // A second order that Vertex has no part in, from a different buyer. (The cart is deliberately
  // left intact after checkout — the order's holds reserve those items — so a fresh buyer is used
  // to get a cart that contains nothing from Vertex.)
  const stranger = await asNewCustomer(server.base, 'split-stranger');
  const strangerItems = (await stranger.call('/products?limit=24')).body.items
    .filter((p) => p.stock > 0 && p.merchant?.name !== 'Vertex Systems')
    .sort((a, b) => b.stock - a.stock);
  assert.equal((await stranger.call('/cart/items', { method: 'POST', body: { productId: strangerItems[0].id, quantity: 1 } })).status, 200);
  const foreign = await placeOrder(stranger);
  assert.ok(!foreign.body.order.lines.some((l) => l.merchantId === shared.body.order.lines.find((x) => x.merchantId !== other.merchant.id).merchantId), 'the stranger’s order really has no Vertex line');

  const merchant = await buyer.call('/auth/login', { method: 'POST', body: { email: 'merchant@demo.dev', password: 'Merchant@12345' } });
  assert.equal(merchant.status, 200);

  const mine = await buyer.call('/merchant/orders?limit=100');
  assert.equal(mine.status, 200);
  const ids = (mine.body.items ?? []).map((o) => o.id ?? o.orderId ?? o.orderNumber);
  assert.ok(ids.includes(shared.body.order.id), 'the seller sees the order they were paid for');
  assert.ok(!ids.includes(foreign.body.order.id), 'the seller does not see an order they took no part in');

  // Per-order endpoints apply the same ownership check (routes.mjs: ORDER_NOT_FOUND).
  const direct = await buyer.call(`/merchant/orders/${foreign.body.order.id}/attempts`);
  assert.equal(direct.status, 404, 'fetching a stranger’s order by id is a 404, not a leak');
  const own = await buyer.call(`/merchant/orders/${shared.body.order.id}/attempts`);
  assert.equal(own.status, 200, 'the seller can open the order they were paid for');
  assert.ok(own.body.items.length > 0, 'and can see their own payment attempts');

  // Every seller in the shared order is a real, distinct payee — no unit silently points at Vertex.
  const units = shared.body.order.payment.settlement.units;
  assert.equal(new Set(units.map((u) => u.payeeEmail)).size, units.length, 'each unit pays a different seller');
});
