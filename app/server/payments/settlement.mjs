/**
 * Multi-merchant settlement.
 *
 * A ShopPilot cart can hold lines from several independent sellers (5 of 7 seeded demo orders do).
 * PayPal's Orders v2 models this natively: one order, one approval, many `purchase_units` — each
 * with its own `payee` and an optional `payment_instruction.platform_fees` for the marketplace
 * commission. Without this the platform is the sole recipient of money that belongs to the sellers.
 * Reference: https://developer.paypal.com/docs/multiparty/checkout/multiseller-payments/
 *
 * This module is pure: it turns an order + merchant records into a settlement plan. It performs no
 * I/O and never talks to PayPal, so the arithmetic is unit-testable in isolation — which matters,
 * because the invariant is exact: the per-unit amounts must sum to the order total to the cent.
 * Docs: ../docs/payments_paypal.md
 */

/** Largest-remainder apportionment: split `amount` across `weights` with no money lost. */
export function apportion(amountMinor, weights) {
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (!weights.length) return [];
  if (totalWeight <= 0) {
    // Degenerate input (e.g. a zero-priced cart): give everything to the biggest line.
    return weights.map((_, index) => (index === 0 ? amountMinor : 0));
  }

  const exact = weights.map((w) => (amountMinor * w) / totalWeight);
  const floors = exact.map((value) => Math.floor(value));
  let remainder = amountMinor - floors.reduce((sum, value) => sum + value, 0);

  // Hand the leftover minor units to the largest fractional parts first, so the result is exact
  // and deterministic regardless of the order merchants happen to appear in.
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  const result = [...floors];
  for (const { index } of order) {
    if (remainder <= 0) break;
    result[index] += 1;
    remainder -= 1;
  }
  return result;
}

/**
 * Per-seller commission. Rounded to the nearest minor unit and clamped so a fee can never exceed
 * (or equal) the amount being charged — PayPal rejects a platform fee that consumes the whole unit.
 */
export function platformFeeFor(amountMinor, feeBps) {
  if (!feeBps || feeBps <= 0) return 0;
  const fee = Math.round((amountMinor * feeBps) / 10_000);
  return Math.max(0, Math.min(fee, amountMinor - 1));
}

/**
 * Build the settlement plan for an order.
 *
 * @param {object} order      order doc with `lines`, `amounts`, `merchantIds`
 * @param {object} options
 * @param {Map<string,object>|object} options.merchants  merchantId → merchant record
 * @param {'single'|'split'} options.mode
 * @param {number} [options.platformFeeBps]
 * @returns {{mode:string, units:Array, totals:object, reasons:string[]}}
 */
export function settlementPlan(order, { merchants = {}, mode = 'single', platformFeeBps = 0, payeeEmails = {} } = {}) {
  const lookup = merchants instanceof Map ? merchants : new Map(Object.entries(merchants));
  const reason = [];

  // Group lines by seller, preserving first-seen order for stable output.
  const groups = new Map();
  for (const line of order.lines ?? []) {
    const merchantId = line.merchantId ?? 'unknown';
    if (!groups.has(merchantId)) groups.set(merchantId, []);
    groups.get(merchantId).push(line);
  }

  const single = () => ({
    mode: 'single',
    reasons: reason,
    units: [{
      referenceId: null,
      merchantId: null,
      merchantName: null,
      payee: null,
      itemTotalMinor: order.amounts.subtotalMinor,
      taxMinor: order.amounts.taxMinor,
      shippingMinor: order.amounts.shippingMinor,
      amountMinor: order.amounts.totalMinor,
      platformFeeMinor: 0,
      items: (order.lines ?? []).map((line) => ({
        name: line.title, unitAmountMinor: line.unitPriceMinor, quantity: line.quantity, sku: line.productId
      }))
    }],
    totals: {
      amountMinor: order.amounts.totalMinor,
      platformFeeMinor: 0,
      sellerCount: groups.size
    }
  });

  if (mode !== 'split') return single();
  if (groups.size < 2) {
    reason.push('only one seller in this cart');
    return single();
  }

  // Every seller needs a resolvable payee, or PayPal would silently leave the platform as recipient.
  // The payee email can come from the environment (a real sandbox business account for the seller)
  // or from the merchant record. An environment address wins, so the demo can be pointed at real
  // accounts without touching the seed.
  const payeeOf = (record) => (record?.slug ? payeeEmails[record.slug] : null) || record?.payeeEmail || record?.email || null;
  const merchantList = [...groups.keys()].map((id) => ({ id, record: lookup.get(id) }));
  const missing = merchantList.filter(({ record }) => !payeeOf(record));
  if (missing.length) {
    reason.push(`${missing.length} seller(s) have no payee email configured`);
    return single();
  }

  const weights = merchantList.map(({ id }) => groups.get(id).reduce((sum, line) => sum + line.unitPriceMinor * line.quantity, 0));
  const itemTotals = apportion(order.amounts.subtotalMinor, weights);
  const taxShares = apportion(order.amounts.taxMinor, weights);
  const shippingShares = apportion(order.amounts.shippingMinor, weights);

  const units = merchantList.map(({ id, record }, index) => {
    const amountMinor = itemTotals[index] + taxShares[index] + shippingShares[index];
    return {
      referenceId: `m${index + 1}`,
      merchantId: id,
      merchantName: record.name ?? null,
      payee: {
        emailAddress: payeeOf(record),
        merchantId: record.paypalMerchantId ?? record.paypalMerchant ?? null
      },
      itemTotalMinor: itemTotals[index],
      taxMinor: taxShares[index],
      shippingMinor: shippingShares[index],
      amountMinor,
      platformFeeMinor: platformFeeFor(amountMinor, platformFeeBps),
      items: groups.get(id).map((line) => ({
        name: line.title, unitAmountMinor: line.unitPriceMinor, quantity: line.quantity, sku: line.productId
      }))
    };
  });

  // Exactness is the whole point: if these ever disagree, money is created or destroyed.
  const summed = units.reduce((sum, unit) => sum + unit.amountMinor, 0);
  if (summed !== order.amounts.totalMinor) {
    reason.push(`allocation mismatch (${summed} ≠ ${order.amounts.totalMinor})`);
    return single();
  }

  return {
    mode: 'split',
    reasons: reason,
    units,
    totals: {
      amountMinor: summed,
      platformFeeMinor: units.reduce((sum, unit) => sum + unit.platformFeeMinor, 0),
      sellerCount: units.length
    }
  };
}

/**
 * Verify a captured split order still matches the plan we intended to charge.
 * Returns per-unit checks so a partial or re-pointed capture can never be accepted.
 */
export function verifySettlement(order, response, { expected }) {
  const units = response?.purchase_units ?? [];
  if (!expected || expected.mode === 'single') {
    return { ok: true, mode: 'single', units: [] };
  }

  const checks = [];
  const byReference = new Map(units.map((unit) => [unit.reference_id, unit]));

  for (const expectedUnit of expected.units) {
    const actual = byReference.get(expectedUnit.referenceId);
    const capture = actual?.payments?.captures?.[0];
    const actualMinor = capture?.amount ? Math.round(Number(capture.amount.value) * 100) : null;
    const expectedPayee = String(expectedUnit.payee?.emailAddress ?? '').toLowerCase();
    const actualPayee = String(actual?.payee?.email_address ?? '').toLowerCase();

    checks.push({
      referenceId: expectedUnit.referenceId,
      merchantId: expectedUnit.merchantId,
      present: Boolean(actual),
      capturePresent: Boolean(capture?.id),
      amountOk: actualMinor !== null && actualMinor === expectedUnit.amountMinor,
      payeeOk: expectedPayee === '' || actualPayee === expectedPayee,
      captureStatusOk: capture?.status === 'COMPLETED'
    });
  }

  const extraUnits = units.length !== expected.units.length;
  const ok = !extraUnits && checks.every((c) => c.present && c.capturePresent && c.amountOk && c.payeeOk && c.captureStatusOk);

  return { ok, mode: expected.mode, units: checks, extraUnits, expectedCount: expected.units.length, actualCount: units.length };
}
