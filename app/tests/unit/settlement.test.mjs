/**
 * Multi-merchant settlement: the arithmetic must be exact.
 *
 * If these ever fail, money is created or destroyed — so the apportionment is checked
 * exhaustively rather than by example. Docs: ../docs/payments_paypal.md
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { apportion, platformFeeFor, settlementPlan, verifySettlement } from '../../server/payments/settlement.mjs';

const MERCHANTS = {
  m1: { name: 'Vertex Systems', payeeEmail: 'vertex@example.com', paypalMerchantId: 'AAA' },
  m2: { name: 'NovaTech Retail', payeeEmail: 'nova@example.com', paypalMerchantId: 'BBB' },
  m3: { name: 'AudioPeak', payeeEmail: 'audio@example.com', paypalMerchantId: 'CCC' }
};

const order = (lines, amounts) => ({
  _id: 'o1',
  orderNumber: 'SP-2026-000001',
  lines,
  amounts: { currency: 'USD', ...amounts }
});

describe('apportion', () => {
  test('never loses or invents a minor unit, exhaustively', () => {
    for (let amount = 0; amount <= 400; amount += 1) {
      for (let a = 0; a <= 6; a += 1) {
        for (let b = 0; b <= 6; b += 1) {
          for (let c = 0; c <= 6; c += 1) {
            const parts = apportion(amount, [a, b, c]);
            assert.equal(parts.reduce((s, x) => s + x, 0), amount, `${amount} across [${a},${b},${c}] → ${parts}`);
            assert.ok(parts.every((p) => p >= 0 && Number.isInteger(p)), 'parts are non-negative integers');
          }
        }
      }
    }
  });

  test('handles zero-weight and single-recipient cases without dividing by zero', () => {
    assert.deepEqual(apportion(1000, [0, 0, 0]), [1000, 0, 0]);
    assert.deepEqual(apportion(1000, [5]), [1000]);
    assert.deepEqual(apportion(0, [1, 2]), [0, 0]);
  });

  test('is deterministic regardless of weight order', () => {
    const a = apportion(1001, [3, 3, 4]);
    const b = apportion(1001, [4, 3, 3]);
    assert.equal(a.reduce((s, x) => s + x, 0), 1001);
    assert.equal(b.reduce((s, x) => s + x, 0), 1001);
  });
});

describe('platformFeeFor', () => {
  test('never consumes the whole amount PayPal is asked to charge', () => {
    for (const amount of [0, 1, 2, 99, 100, 12345]) {
      for (const bps of [0, 1, 500, 9999, 10000, 20000]) {
        const fee = platformFeeFor(amount, bps);
        assert.ok(fee >= 0, 'fee is non-negative');
        assert.ok(fee < Math.max(1, amount), `${amount}@${bps} → ${fee} must leave something for the seller`);
      }
    }
  });

  test('is zero when no commission is configured', () => {
    assert.equal(platformFeeFor(50000, 0), 0);
    assert.equal(platformFeeFor(50000, -5), 0);
  });
});

describe('settlementPlan', () => {
  const order1 = order([
    { merchantId: 'm1', title: 'Laptop', unitPriceMinor: 64900, quantity: 1, productId: 'p1' },
    { merchantId: 'm2', title: 'Monitor', unitPriceMinor: 29900, quantity: 1, productId: 'p2' },
    { merchantId: 'm3', title: 'Headset', unitPriceMinor: 7999, quantity: 1, productId: 'p3' }
  ], { subtotalMinor: 102799, taxMinor: 8481, shippingMinor: 0, totalMinor: 111280 });

  test('splits into one unit per seller and sums exactly to the order total', () => {
    const plan = settlementPlan(order1, { merchants: MERCHANTS, mode: 'split', platformFeeBps: 500 });
    assert.equal(plan.mode, 'split');
    assert.equal(plan.units.length, 3);
    assert.equal(plan.units.reduce((s, u) => s + u.amountMinor, 0), order1.amounts.totalMinor);
    assert.equal(plan.units.reduce((s, u) => s + u.itemTotalMinor, 0), order1.amounts.subtotalMinor);
    assert.equal(plan.units.reduce((s, u) => s + u.taxMinor, 0), order1.amounts.taxMinor);
    assert.equal(plan.units.reduce((s, u) => s + u.shippingMinor, 0), order1.amounts.shippingMinor);
  });

  test('each unit carries a reference id and its seller payee', () => {
    const plan = settlementPlan(order1, { merchants: MERCHANTS, mode: 'split' });
    assert.deepEqual(plan.units.map((u) => u.referenceId), ['m1', 'm2', 'm3']);
    assert.equal(plan.units[0].payee.emailAddress, 'vertex@example.com');
    assert.equal(plan.units[0].payee.merchantId, 'AAA');
  });

  test('groups several lines from the same seller into one unit', () => {
    const shared = order([
      { merchantId: 'm1', title: 'A', unitPriceMinor: 1000, quantity: 2, productId: 'p1' },
      { merchantId: 'm1', title: 'B', unitPriceMinor: 500, quantity: 1, productId: 'p2' },
      { merchantId: 'm2', title: 'C', unitPriceMinor: 500, quantity: 1, productId: 'p3' }
    ], { subtotalMinor: 3000, taxMinor: 248, shippingMinor: 999, totalMinor: 4247 });
    const plan = settlementPlan(shared, { merchants: MERCHANTS, mode: 'split' });
    assert.equal(plan.units.length, 2, 'one unit per seller, not per line');
    assert.equal(plan.units[0].items.length, 2);
    assert.equal(plan.units.reduce((s, u) => s + u.amountMinor, 0), 4247);
  });

  test('disbursement-relevant commission is proportional to each seller', () => {
    const plan = settlementPlan(order1, { merchants: MERCHANTS, mode: 'split', platformFeeBps: 500 });
    const m1 = plan.units.find((u) => u.merchantId === 'm1');
    assert.equal(m1.platformFeeMinor, Math.round((m1.amountMinor * 500) / 10_000));
    assert.equal(plan.totals.platformFeeMinor, plan.units.reduce((s, u) => s + u.platformFeeMinor, 0));
  });

  test('falls back to a single unit for one seller, and says why', () => {
    const solo = order([{ merchantId: 'm1', title: 'A', unitPriceMinor: 5000, quantity: 1, productId: 'p1' }],
      { subtotalMinor: 5000, taxMinor: 413, shippingMinor: 999, totalMinor: 6412 });
    const plan = settlementPlan(solo, { merchants: MERCHANTS, mode: 'split' });
    assert.equal(plan.mode, 'single');
    assert.match(plan.reasons.join(' '), /one seller/i);
    assert.equal(plan.units[0].amountMinor, 6412);
  });

  test('falls back when a seller has no payee, rather than paying the platform by accident', () => {
    const plan = settlementPlan(order1, { merchants: { ...MERCHANTS, m2: { name: 'No Payee Ltd' } }, mode: 'split' });
    assert.equal(plan.mode, 'single');
    assert.match(plan.reasons.join(' '), /payee/i);
  });

  test("mode 'single' is a no-op even with several sellers", () => {
    const plan = settlementPlan(order1, { merchants: MERCHANTS, mode: 'single', platformFeeBps: 500 });
    assert.equal(plan.mode, 'single');
    assert.equal(plan.units.length, 1);
    assert.equal(plan.units[0].amountMinor, order1.amounts.totalMinor);
    assert.equal(plan.units[0].platformFeeMinor, 0);
    assert.equal(plan.totals.platformFeeMinor, 0);
  });
});

describe('verifySettlement', () => {
  const base = order([
    { merchantId: 'm1', title: 'A', unitPriceMinor: 5000, quantity: 1, productId: 'p1' },
    { merchantId: 'm2', title: 'B', unitPriceMinor: 3000, quantity: 1, productId: 'p2' }
  ], { subtotalMinor: 8000, taxMinor: 660, shippingMinor: 999, totalMinor: 9659 });

  const plan = settlementPlan(base, { merchants: MERCHANTS, mode: 'split' });
  const expected = { mode: 'split', units: plan.units.map((u) => ({ referenceId: u.referenceId, merchantId: u.merchantId, amountMinor: u.amountMinor, payee: u.payee })) };

  const response = (mutate = () => {}) => {
    const units = plan.units.map((u, index) => ({
      reference_id: u.referenceId,
      payee: { email_address: u.payee.emailAddress },
      payments: { captures: [{ id: `CAP${index}`, status: 'COMPLETED', amount: { currency_code: 'USD', value: (u.amountMinor / 100).toFixed(2) } }] }
    }));
    const other = { purchase_units: units };
    mutate(other);
    return other;
  };

  test('accepts a faithful capture', () => {
    assert.equal(verifySettlement(base, response(), { expected }).ok, true);
  });

  test('rejects a short amount on any single seller', () => {
    const result = verifySettlement(base, response((r) => { r.purchase_units[1].payments.captures[0].amount.value = '1.00'; }), { expected });
    assert.equal(result.ok, false);
    assert.equal(result.units[1].amountOk, false);
  });

  test('rejects money re-pointed to a different payee', () => {
    const result = verifySettlement(base, response((r) => { r.purchase_units[0].payee.email_address = 'attacker@example.com'; }), { expected });
    assert.equal(result.ok, false);
    assert.equal(result.units[0].payeeOk, false);
  });

  test('rejects a missing seller', () => {
    const result = verifySettlement(base, response((r) => { r.purchase_units.pop(); }), { expected });
    assert.equal(result.ok, false);
  });

  test('rejects an extra unit the plan never asked for', () => {
    const result = verifySettlement(base, response((r) => { r.purchase_units.push({ ...r.purchase_units[0], reference_id: 'm9' }); }), { expected });
    assert.equal(result.ok, false);
    assert.equal(result.extraUnits, true);
  });

  test('rejects a seller whose capture is not completed', () => {
    const result = verifySettlement(base, response((r) => { r.purchase_units[0].payments.captures[0].status = 'PENDING'; }), { expected });
    assert.equal(result.ok, false);
  });

  test('is a no-op for single-unit orders', () => {
    assert.equal(verifySettlement(base, response(), { expected: { mode: 'single' } }).ok, true);
  });
});
