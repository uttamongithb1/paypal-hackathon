/**
 * Seeded history must reconcile with itself.
 *
 * The merchant dashboard used to show `PAID REVENUE $0.00` directly above a product table reading
 * `SOLD 356`, while the funnel claimed 41 purchases no order backed. Orders were never seeded:
 * `seedDemoOrders` routes through the real payment service, which would make live PayPal calls on a
 * host booting into sandbox mode, so the boot path skipped orders entirely.
 *
 * `seedDemoHistory` writes orders straight into the store and derives the reported figures from
 * them. These tests pin that derivation, because the failure mode is silent: numbers that merely
 * look plausible while contradicting each other.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildContainer } from '../../server/container.mjs';
import { seedAll } from '../../scripts/seed-lib.mjs';

async function seeded() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoppilot-history-'));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  const container = await buildContainer();
  const result = await seedAll(container, { demoOrders: false, history: true, analytics: true });
  if (previous === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previous;
  return { container, result, dir };
}

const { container, result, dir } = await seeded();
const { store, catalogue } = container;

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the store gets a history, not an empty order book', () => {
  const orders = store.collection('orders').find({});
  assert.equal(orders.length, 44, '41 paid + 2 awaiting payment + 1 expired');
  assert.equal(orders.filter((o) => o.status === 'paid').length, 41);
});

test('every paid order has a capture and a capture timestamp', () => {
  for (const order of store.collection('orders').find({ status: 'paid' })) {
    assert.equal(order.payment.status, 'captured', `${order.orderNumber} is paid but not captured`);
    assert.ok(order.payment.paypalCaptureId, `${order.orderNumber} has no capture id`);
    assert.ok(order.paidAt, `${order.orderNumber} has no paidAt`);
  }
});

test('settlement units always sum to the order total', () => {
  for (const order of store.collection('orders').find({})) {
    const units = order.payment.settlement?.units ?? [];
    assert.ok(units.length >= 1, `${order.orderNumber} has no settlement units`);
    const sum = units.reduce((total, unit) => total + unit.amountMinor, 0);
    assert.equal(sum, order.amounts.totalMinor, `${order.orderNumber}: units ${sum} ≠ total ${order.amounts.totalMinor}`);
  }
});

test('sold counts are the quantity actually sold, not a fixture number', () => {
  const soldFromOrders = new Map();
  for (const order of store.collection('orders').find({ status: 'paid' })) {
    for (const line of order.lines) {
      soldFromOrders.set(line.productId, (soldFromOrders.get(line.productId) ?? 0) + line.quantity);
    }
  }
  for (const product of store.collection('products').find({})) {
    assert.equal(
      product.soldCount ?? 0,
      soldFromOrders.get(product._id) ?? 0,
      `${product.title}: soldCount ${product.soldCount} but orders say ${soldFromOrders.get(product._id) ?? 0}`
    );
  }
  assert.equal(result.history.unitsSold, [...soldFromOrders.values()].reduce((a, b) => a + b, 0));
});

test('the merchant dashboard reports the revenue the orders actually contain', () => {
  const paid = store.collection('orders').find({ status: 'paid' });
  const merchantId = paid[0].lines[0].merchantId;
  const overview = container.order.overview(merchantId);
  assert.ok(overview.revenueMinor > 0, 'a shop with 41 paid orders cannot report zero revenue');
  assert.ok(overview.paidOrders > 0, 'and it cannot report zero paid orders');

  // The figure must be the sum of that merchant's own settlement units, not the whole shop's takings.
  let expected = 0;
  for (const order of paid) {
    for (const unit of order.payment.settlement?.units ?? []) {
      if (unit.merchantId === merchantId) expected += unit.amountMinor;
    }
  }
  assert.equal(overview.revenueMinor, expected, 'revenue must equal that merchant\'s settled amount');
});

test('order numbers are unique and sequential', () => {
  const numbers = store.collection('orders').find({}).map((o) => o.orderNumber);
  assert.equal(new Set(numbers).size, numbers.length);
  for (const number of numbers) assert.match(number, /^SP-\d{4}-\d{6}$/);
});

test('the seeded catalogue still serves every product after history is written', () => {
  const page = catalogue.search({ limit: 50 });
  assert.ok(page.total >= 20, `expected the full catalogue, got ${page.total}`);
});

test('history is marked as generated so it is never mistaken for a real transaction', () => {
  for (const order of store.collection('orders').find({})) {
    assert.equal(order.demo, true, `${order.orderNumber} is unmarked`);
  }
});
