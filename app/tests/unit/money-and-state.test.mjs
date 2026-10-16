/**
 * Pure unit tests: money maths, the order state machine and requirement/intent parsing.
 * These pin the contracts from prd.md §5.4.1 and docs/data_model.md so a refactor cannot quietly
 * change what a customer is charged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney, shippingFor, taxFor, toMinor, toPayPalAmount, freeShippingRemaining } from '../../server/lib/money.mjs';
import { ORDER_STATUS, canTransition, assertTransition } from '../../server/domain/orderState.mjs';
import { extractRequirement, requirementChanged, describeRequirement, requirementChips } from '../../server/agent/requirement.mjs';
import { detectIntent } from '../../server/agent/orchestrator.mjs';
import env from '../../server/config/env.mjs';

test('tax is round(subtotal × 825bps) and never floats', () => {
  assert.equal(taxFor(87900, env.taxRateBps), 7252); // 87900 × 0.0825 = 7251.75 → 7252
  assert.equal(taxFor(175800, env.taxRateBps), 14504);
  assert.equal(taxFor(15000, env.taxRateBps), 1238);
  assert.equal(taxFor(0, env.taxRateBps), 0);
});

test('shipping bands match the spec (free ≥ $500, $9.99 ≥ $200, else $14.99, oversized +$19.99)', () => {
  assert.equal(shippingFor(87900, { env }).feeMinor, 0);
  assert.equal(shippingFor(50000, { env }).feeMinor, 0);
  assert.equal(shippingFor(49999, { env }).feeMinor, 999);
  assert.equal(shippingFor(20000, { env }).feeMinor, 999);
  assert.equal(shippingFor(19999, { env }).feeMinor, 1499);
  assert.equal(shippingFor(19999, { env, hasOversized: true }).feeMinor, 1499 + 1999);
});

test('the documented end-to-end totals are reproducible', () => {
  const one = { subtotal: 87900 };
  const two = { subtotal: 175800 };
  const three = { subtotal: 15000 };
  assert.equal(one.subtotal + shippingFor(one.subtotal, { env }).feeMinor + taxFor(one.subtotal, env.taxRateBps), 95152);
  assert.equal(two.subtotal + shippingFor(two.subtotal, { env }).feeMinor + taxFor(two.subtotal, env.taxRateBps), 190304);
  assert.equal(three.subtotal + shippingFor(three.subtotal, { env }).feeMinor + taxFor(three.subtotal, env.taxRateBps), 17737);
});

test('money helpers convert and format without float drift', () => {
  assert.equal(formatMoney(114529), '$1,145.29');
  assert.equal(formatMoney(0), '$0.00');
  assert.equal(toMinor(1299.99), 129999);
  assert.equal(toMinor('899'), 89900);
  assert.equal(toPayPalAmount(114529), '1145.29');
  assert.equal(freeShippingRemaining(29900, 50000), 20100);
  assert.equal(freeShippingRemaining(60000, 50000), 0);
});

test('order state machine: legal transitions only, terminal states stay terminal', () => {
  assert.ok(canTransition(ORDER_STATUS.AWAITING_PAYMENT, ORDER_STATUS.PAYMENT_PROCESSING));
  assert.ok(canTransition(ORDER_STATUS.PAYMENT_PROCESSING, ORDER_STATUS.PAID));
  // A failed attempt must pass back through payment_processing — it can never jump to paid.
  assert.ok(canTransition(ORDER_STATUS.PAYMENT_FAILED, ORDER_STATUS.PAYMENT_PROCESSING));
  assert.equal(canTransition(ORDER_STATUS.PAYMENT_FAILED, ORDER_STATUS.PAID), false);
  assert.ok(canTransition(ORDER_STATUS.PAID, ORDER_STATUS.PROCESSING));
  assert.ok(canTransition(ORDER_STATUS.PROCESSING, ORDER_STATUS.SHIPPED));
  assert.ok(canTransition(ORDER_STATUS.SHIPPED, ORDER_STATUS.DELIVERED));
  assert.equal(canTransition(ORDER_STATUS.CANCELLED, ORDER_STATUS.PAID), false);
  assert.equal(canTransition(ORDER_STATUS.EXPIRED, ORDER_STATUS.PAID), false);
  assert.equal(canTransition(ORDER_STATUS.DRAFT, ORDER_STATUS.PAID), false);
  assert.throws(() => assertTransition(ORDER_STATUS.CANCELLED, ORDER_STATUS.PAID), /ORDER_NOT_PAYABLE|Cannot move/);
});

test('requirement extraction reads the G-01 sentence exactly', () => {
  const { requirement } = extractRequirement('I need a laptop for full-stack development under $900, at least 16 GB RAM, 512 GB SSD, good battery life', {
    attributeSchemas: { laptops: [{ key: 'ramGb' }, { key: 'storageGb' }, { key: 'batteryWh' }, { key: 'weightG' }] }
  });
  assert.equal(requirement.categorySlug, 'laptops');
  assert.equal(requirement.budgetMinor, 90000);
  const ram = requirement.hardConstraints.find((c) => c.key === 'ramGb');
  const storage = requirement.hardConstraints.find((c) => c.key === 'storageGb');
  assert.equal(ram.op, 'gte');
  assert.equal(ram.value, 16);
  assert.equal(storage.value, 512);
  assert.ok(requirement.softPreferences.some((p) => p.key === 'batteryWh'));
});

test('a budget change is a revision; a soft preference is not', () => {
  const first = extractRequirement('a laptop under $900').requirement;
  const second = extractRequirement('actually make it under $650 instead', { previous: first }).requirement;
  assert.equal(requirementChanged(first, second), true);
  assert.equal(second.budgetMinor, 65000);
  const third = extractRequirement('and I like light laptops', { previous: second }).requirement;
  assert.equal(requirementChanged(second, third), false);
});

test('describeRequirement + requirementChips are what the UI shows', () => {
  const { requirement } = extractRequirement('laptop under $900 with at least 16 GB RAM', {
    attributeSchemas: { laptops: [{ key: 'ramGb' }] }
  });
  const description = describeRequirement(requirement);
  assert.match(description, /laptops/);
  assert.match(description, /\$900\.00/);
  const chips = requirementChips({ ...requirement, revision: 1 });
  assert.ok(chips.some((chip) => chip.kind === 'budget'));
  assert.ok(chips.some((chip) => chip.kind === 'hard' && chip.key === 'ramGb'));
});

test('intent routing covers the golden prompts', () => {
  assert.equal(detectIntent('I need a laptop for full-stack development under $900 with 16 GB RAM'), 'discover');
  assert.equal(detectIntent('compare the top 2'), 'compare');
  assert.equal(detectIntent('add 2 of the second one to my cart'), 'cart_add');
  assert.equal(detectIntent('what is in my cart?'), 'cart_view');
  assert.equal(detectIntent('remove the monitor from my cart'), 'cart_remove');
  assert.equal(detectIntent('checkout'), 'checkout');
  assert.equal(detectIntent('hello'), 'greeting');
  // A spec word only means "follow-up" when something is already on screen; otherwise it is a search.
  assert.equal(detectIntent('does it have a backlit keyboard?'), 'discover');
  assert.equal(detectIntent('does it have a backlit keyboard?', { candidateIds: ['a'] }), 'followup');
});
