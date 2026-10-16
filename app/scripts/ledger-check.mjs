#!/usr/bin/env node
/**
 * Invariant checks (I1–I10 in ../docs/data_model.md §4). Prints a report and exits non-zero on any
 * violation — run it before every demo and in CI.
 */
import { buildContainer } from '../server/container.mjs';
import env from '../server/config/env.mjs';

const container = await buildContainer();
const { store, catalogue, cart, inventory } = container;
const orders = store.collection('orders');
const products = store.collection('products');
const attempts = store.collection('payment_attempts');
const events = store.collection('analytics_events');

const checks = [];
const record = (id, description, violations, detail) => checks.push({ id, description, violations, detail });

// I1 + I2 — money math
const moneyViolations = [];
for (const order of orders.find({})) {
  const { subtotalMinor, shippingMinor, taxMinor, totalMinor, taxRateBps } = order.amounts;
  if (totalMinor !== subtotalMinor + shippingMinor + taxMinor) moneyViolations.push(`${order.orderNumber}: total ≠ subtotal + shipping + tax`);
  const expectedTax = Math.round((subtotalMinor * (taxRateBps ?? env.taxRateBps)) / 10000);
  if (taxMinor !== expectedTax) moneyViolations.push(`${order.orderNumber}: tax ${taxMinor} ≠ ${expectedTax}`);
  const lineSum = order.lines.reduce((sum, l) => sum + l.unitPriceMinor * l.quantity, 0);
  if (lineSum !== subtotalMinor) moneyViolations.push(`${order.orderNumber}: subtotal ${subtotalMinor} ≠ Σ lines ${lineSum}`);
}
record('I1-I2', 'Order money math (total = subtotal + shipping + tax, tax = round(subtotal × bps))', moneyViolations);

// I3 — never paid without a verified capture
const paidViolations = orders
  .find({ status: 'paid' })
  .filter((o) => !o.payment?.paypalCaptureId || o.payment?.amountVerified !== true)
  .map((o) => `${o.orderNumber}: paid without a verified capture`);
record('I3', 'No order is paid without a verified capture id', paidViolations);

// I4 — stock never negative, holds never exceed stock
const stockViolations = products.find({}).filter((p) => p.stock < 0).map((p) => `${p.slug}: stock ${p.stock}`);
for (const hold of store.collection('inventory_holds').find({ status: 'active' })) {
  const product = products.findOne({ _id: hold.productId });
  if (product && hold.quantity > product.stock) stockViolations.push(`${product.slug}: active hold ${hold.quantity} > stock ${product.stock}`);
}
record('I4', 'Stock is never negative and active holds never exceed stock', stockViolations);

// I5 — cart subtotal equals live prices
const cartViolations = [];
for (const doc of store.collection('carts').find({ status: 'active' })) {
  const dto = cart.toDto(doc);
  const expected = dto.items.filter((i) => !i.unavailable).reduce((sum, i) => sum + i.unitPriceMinor * i.quantity, 0);
  if (dto.subtotalMinor !== expected) cartViolations.push(`cart ${doc._id}: subtotal ${dto.subtotalMinor} ≠ ${expected}`);
}
record('I5', 'Cart subtotal is always recomputed from live prices', cartViolations);

// I6 — attempts are contiguous from 1 and belong to an order
const attemptViolations = [];
for (const order of orders.find({})) {
  const rows = attempts.find({ orderId: order._id }, { sort: { attemptNo: 1 } });
  rows.forEach((row, index) => {
    if (row.attemptNo !== index + 1) attemptViolations.push(`${order.orderNumber}: attempt numbers not contiguous (${rows.map((r) => r.attemptNo).join(',')})`);
  });
}
for (const attempt of attempts.find({})) {
  if (!orders.findOne({ _id: attempt.orderId })) attemptViolations.push(`attempt ${attempt._id}: orphaned (no order)`);
}
record('I6', 'Payment attempts are contiguous per order and never orphaned', attemptViolations);

// I7 — uniqueness
const uniquenessViolations = [];
const seen = (collection, field) => {
  const values = collection.find({}).map((d) => field.split('.').reduce((acc, k) => acc?.[k], d)).filter(Boolean);
  const dupes = values.filter((v, i) => values.indexOf(v) !== i);
  return [...new Set(dupes)];
};
for (const dupe of seen(orders, 'orderNumber')) uniquenessViolations.push(`duplicate orderNumber ${dupe}`);
for (const dupe of seen(orders, 'payment.paypalCaptureId')) uniquenessViolations.push(`duplicate captureId ${dupe}`);
for (const dupe of seen(products, 'slug')) uniquenessViolations.push(`duplicate slug ${dupe}`);
for (const dupe of seen(events, 'eventId')) uniquenessViolations.push(`duplicate analytics eventId ${dupe}`);
record('I7', 'Unique order numbers, capture ids, slugs and event ids', uniquenessViolations);

// I8 — nothing stuck in payment_processing for more than 30 minutes
const stuck = orders
  .find({ status: 'payment_processing' })
  .filter((o) => Date.now() - new Date(o.updatedAt).getTime() > 30 * 60_000)
  .map((o) => `${o.orderNumber}: processing since ${o.updatedAt}`);
record('I8', 'No order stuck in payment_processing beyond 30 minutes', stuck);

// I9 — analytics carry no PII
const piiKeys = ['email', 'name', 'address', 'phone', 'password', 'payerEmail'];
const piiViolations = [];
for (const event of events.find({})) {
  for (const key of Object.keys(event.props ?? {})) {
    if (piiKeys.some((p) => key.toLowerCase().includes(p))) piiViolations.push(`${event.name}: prop ${key}`);
  }
}
record('I9', 'No PII keys in analytics event props', piiViolations);

// I10 — funnel is monotonic
const funnelViolations = container.analytics.funnelViolations();
record('I10', 'Funnel is monotonic (views ≥ cart adds ≥ checkout attempts ≥ purchases)', funnelViolations);

// Extra: inventory availability never negative
const holdViolations = products.find({}).filter((p) => inventory.availableFor(p._id) < 0).map((p) => `${p.slug}: available < 0`);
record('I-extra', 'Available-to-sell is never negative', holdViolations);

const failed = checks.filter((c) => c.violations.length);
const total = checks.reduce((sum, c) => sum + c.violations.length, 0);

console.log('\n  ShopPilot AI — invariant report\n');
for (const check of checks) {
  const mark = check.violations.length ? '✗' : '✓';
  console.log(`  ${mark} ${check.id.padEnd(9)} ${check.description}`);
  for (const violation of check.violations.slice(0, 5)) console.log(`      • ${violation}`);
  if (check.violations.length > 5) console.log(`      • … ${check.violations.length - 5} more`);
}
console.log(`\n  ${total === 0 ? 'All invariants hold' : `${total} violation(s) found`}  ·  orders ${orders.count()} · attempts ${attempts.count()} · events ${events.count()}\n`);
await container.store.flush();
process.exit(failed.length ? 1 : 0);
