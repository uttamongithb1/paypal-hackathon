/**
 * Money helpers. All money in the system is an integer number of minor units (USD cents).
 * Docs: ../prd.md §3 (money rule), ../docs/data_model.md (global rules)
 */
export function assertIntegerMinor(value, label = 'amount') {
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer in minor units, got ${value}`);
  return value;
}

export const toMinor = (dollars) => Math.round(Number(dollars) * 100);

export const fromMinor = (minor) => Number((minor / 100).toFixed(2));

/** PayPal wants a fixed 2-decimal string. */
export const toPayPalAmount = (minor) => (minor / 100).toFixed(2);

export function formatMoney(minor, currency = 'USD') {
  assertIntegerMinor(minor, 'formatMoney');
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, '0');
  const grouped = whole.toLocaleString('en-US');
  const symbol = currency === 'USD' ? '$' : '';
  return `${sign}${symbol}${grouped}.${cents}`;
}

/** Tax: round(subtotal × bps / 10000). Half-up, integer output. */
export const taxFor = (subtotalMinor, taxRateBps) => Math.round((subtotalMinor * taxRateBps) / 10000);

/**
 * Shipping rule table — ../prd.md §5.4.1
 * subtotal ≥ $500 → free · $200–$500 → $9.99 · < $200 → $14.99 · oversized items add $19.99
 */
export function shippingFor(subtotalMinor, { hasOversized = false, env }) {
  let fee;
  let rule;
  if (subtotalMinor >= env.shippingFreeThresholdMinor) {
    fee = 0;
    rule = 'free_over_500';
  } else if (subtotalMinor >= 20_000) {
    fee = env.shippingStandardMinor;
    rule = 'standard';
  } else {
    fee = env.shippingSmallOrderMinor;
    rule = 'small_order';
  }
  if (hasOversized) {
    fee += 1999;
    rule = rule === 'free_over_500' ? 'oversized_surcharge' : `${rule}+oversized`;
  }
  return { feeMinor: fee, rule };
}

/** Free shipping progress for the cart UI. */
export function freeShippingRemaining(subtotalMinor, thresholdMinor) {
  return Math.max(0, thresholdMinor - subtotalMinor);
}
