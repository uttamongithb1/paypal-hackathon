/**
 * The PayPal hosted checkout has to work in a browser, not just in a simulator.
 *
 * A create-order that leaves out `payment_source.paypal.experience_context` (and the
 * `return_url` / `cancel_url` inside it) opens a PayPal page that cannot send the buyer back to
 * the order: the approval dies on "Things don't appear to be working at the moment" and the order
 * stays unpaid forever. These tests hold the request shape in place, and the HTTP test holds the
 * delivery address end to end.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCreateOrderPayload,
  buildExperienceContext,
  buildPurchaseUnits,
  isCapabilityRejection,
  isShippingRejection
} from '../../server/payments/paypal.gateway.mjs';
import { checkoutReturnUrls, requestOrigin } from '../../server/lib/return-urls.mjs';

const ADDRESS = {
  name: 'Aarav Sharma',
  line1: '12 Brigade Road',
  line2: 'Flat 402',
  city: 'Gorakhpur',
  state: 'Uttar Pradesh',
  postalCode: '273001',
  countryCode: 'IN'
};

const order = (overrides = {}) => ({
  _id: 'o1',
  orderNumber: 'SP-2026-000001',
  lines: [{
    productId: 'p1',
    merchantId: 'm1',
    title: 'Ascent Book 14 Pro',
    sku: 'VS-AB14P',
    quantity: 1,
    unitPriceMinor: 87900,
    lineTotalMinor: 87900,
    currency: 'USD'
  }],
  amounts: { currency: 'USD', subtotalMinor: 87900, shippingMinor: 0, taxMinor: 0, totalMinor: 87900 },
  shippingAddress: null,
  ...overrides
});

const singlePlan = {
  mode: 'single',
  units: [{
    referenceId: null,
    merchantName: 'Vertex Systems',
    items: [{ name: 'Ascent Book 14 Pro', sku: 'VS-AB14P', quantity: 1, unitAmountMinor: 87900 }],
    itemTotalMinor: 87900,
    shippingMinor: 0,
    taxMinor: 0,
    amountMinor: 87900,
    platformFeeMinor: 0,
    payee: null
  }]
};

const RETURN_URL = 'https://shop.example/checkout/o1?from=paypal';
const CANCEL_URL = 'https://shop.example/checkout/o1?from=paypal&cancelled=1';

describe('PayPal create-order payload', () => {
  test('carries the buyer-facing settings in payment_source, not the deprecated application_context', () => {
    const payload = buildCreateOrderPayload(order(), singlePlan, { returnUrl: RETURN_URL, cancelUrl: CANCEL_URL });
    assert.equal(payload.application_context, undefined, 'application_context is deprecated — PayPal moved it to experience_context');
    assert.ok(payload.payment_source?.paypal?.experience_context, 'the order must carry payment_source.paypal.experience_context');
  });

  test('always sends a return and cancel URL, so PayPal can hand the buyer back', () => {
    const context = buildExperienceContext(order(), { returnUrl: RETURN_URL, cancelUrl: CANCEL_URL });
    assert.equal(context.return_url, RETURN_URL);
    assert.equal(context.cancel_url, CANCEL_URL);
    assert.equal(context.user_action, 'PAY_NOW');
    assert.equal(context.landing_page, 'LOGIN');
    assert.equal(context.brand_name, 'ShopPilot AI');
  });

  test('uses the address we collected, and says so in the shipping preference', () => {
    const context = buildExperienceContext(order({ shippingAddress: ADDRESS }), { returnUrl: RETURN_URL, cancelUrl: CANCEL_URL });
    assert.equal(context.shipping_preference, 'SET_PROVIDED_ADDRESS');
  });

  test('falls back to the buyer wallet address only when we have no address of our own', () => {
    const context = buildExperienceContext(order(), { returnUrl: RETURN_URL, cancelUrl: CANCEL_URL });
    assert.equal(context.shipping_preference, 'GET_FROM_FILE');
  });

  test('puts the delivery address on the purchase unit where PayPal expects it', () => {
    const payload = buildCreateOrderPayload(order({ shippingAddress: ADDRESS }), singlePlan, { returnUrl: RETURN_URL, cancelUrl: CANCEL_URL });
    const unit = payload.purchase_units[0];
    assert.equal(unit.shipping.name.full_name, ADDRESS.name);
    assert.equal(unit.shipping.address.address_line_1, ADDRESS.line1);
    assert.equal(unit.shipping.address.address_line_2, ADDRESS.line2);
    assert.equal(unit.shipping.address.admin_area_1, ADDRESS.state);
    assert.equal(unit.shipping.address.admin_area_2, ADDRESS.city);
    assert.equal(unit.shipping.address.postal_code, ADDRESS.postalCode);
    assert.equal(unit.shipping.address.country_code, 'IN');
  });

  test('omits the shipping block entirely when there is no address', () => {
    const payload = buildCreateOrderPayload(order(), singlePlan, { returnUrl: RETURN_URL, cancelUrl: CANCEL_URL });
    assert.equal(payload.purchase_units[0].shipping, undefined);
  });

  test('every purchase unit in a split order carries the same delivery address', () => {
    const splitPlan = {
      mode: 'split',
      units: [
        { ...singlePlan.units[0], referenceId: 'r1', amountMinor: 50000, itemTotalMinor: 50000 },
        { ...singlePlan.units[0], referenceId: 'r2', amountMinor: 37900, itemTotalMinor: 37900 }
      ]
    };
    const payload = buildCreateOrderPayload(
      order({ shippingAddress: ADDRESS, amounts: { currency: 'USD', subtotalMinor: 87900, shippingMinor: 0, taxMinor: 0, totalMinor: 87900 } }),
      splitPlan,
      { returnUrl: RETURN_URL, cancelUrl: CANCEL_URL }
    );
    assert.equal(payload.purchase_units.length, 2);
    for (const unit of payload.purchase_units) {
      assert.equal(unit.shipping.address.address_line_1, ADDRESS.line1);
    }
  });

  // Regression for the live DUPLICATE_INVOICE_ID failure: on an ephemeral disk (Render free tier)
  // every redeploy reseeds and the sequential orderNumber restarts, so invoice_id must NOT be the
  // orderNumber alone — a previous deployment already captured that number in the same PayPal
  // account. The order's internal _id is the globally-unique discriminator.
  test('invoice_id is unique per order instance even when the orderNumber is reused after a reseed', () => {
    const first = buildPurchaseUnits(order({ _id: 'o1', orderNumber: 'SP-2026-000045' }), singlePlan)[0];
    const afterRedeploy = buildPurchaseUnits(order({ _id: 'f4a9c2b1d8e706534219abce', orderNumber: 'SP-2026-000045' }), singlePlan)[0];
    assert.notEqual(first.invoice_id, afterRedeploy.invoice_id, 'reused orderNumber must not reuse invoice_id');
    assert.ok(first.invoice_id.startsWith('SP-2026-000045-'), 'invoice_id keeps the readable orderNumber prefix');
    assert.ok(afterRedeploy.invoice_id.endsWith('f4a9c2b1d8e706534219abce'));
  });

  test('custom_id stays the orderNumber so webhook + verification matching is unchanged', () => {
    const unit = buildPurchaseUnits(order({ _id: 'o1', orderNumber: 'SP-2026-000045' }), singlePlan)[0];
    assert.equal(unit.custom_id, 'SP-2026-000045');
  });

  test('split orders keep reference_id in invoice_id and append the unique order id', () => {
    const splitPlan = {
      mode: 'split',
      units: [
        { ...singlePlan.units[0], referenceId: 'r1', amountMinor: 50000, itemTotalMinor: 50000 },
        { ...singlePlan.units[0], referenceId: 'r2', amountMinor: 37900, itemTotalMinor: 37900 }
      ]
    };
    const units = buildPurchaseUnits(order({ _id: 'o1', orderNumber: 'SP-2026-000045' }), splitPlan);
    assert.equal(units[0].invoice_id, 'SP-2026-000045-r1-o1');
    assert.equal(units[1].invoice_id, 'SP-2026-000045-r2-o1');
    assert.equal(units[0].custom_id, 'SP-2026-000045:r1');
    assert.equal(units[1].custom_id, 'SP-2026-000045:r2');
  });

  test('invoice_id never exceeds the PayPal 127 character limit', () => {
    const longOrder = order({ _id: 'a'.repeat(24), orderNumber: `SP-2026-${'9'.repeat(110)}` });
    const unit = buildPurchaseUnits(longOrder, singlePlan)[0];
    assert.ok(unit.invoice_id.length <= 127);
  });
});

describe('isShippingRejection', () => {
  test('recognises an address PayPal refused', () => {
    assert.equal(isShippingRejection({ issue: 'MISSING_SHIPPING_ADDRESS', message: 'missing shipping address' }), true);
    assert.equal(isShippingRejection({ message: 'Invalid postal code' }), true);
  });

  test('does not mistake other failures for an address problem', () => {
    assert.equal(isShippingRejection({ issue: 'INSTRUMENT_DECLINED', message: 'The payment was declined' }), false);
    assert.equal(isShippingRejection({ issue: 'PLATFORM_FEES_NOT_SUPPORTED', message: 'not enabled' }), false);
  });
});

describe('isCapabilityRejection', () => {
  test('recognises the documented capability rejections', () => {
    assert.equal(isCapabilityRejection({ issue: 'PLATFORM_FEES_NOT_SUPPORTED', message: 'platform_fees not enabled' }), true);
    assert.equal(isCapabilityRejection({ issue: 'MSP_NOT_SUPPORTED', message: 'not eligible' }), true);
  });

  test('treats an unpayable payee account as a capability problem so the shopper can still buy', () => {
    assert.equal(isCapabilityRejection({ issue: 'PAYEE_ACCOUNT_INVALID', message: 'The payee account is invalid.' }), true);
    assert.equal(isCapabilityRejection({ issue: 'PAYEE_ACCOUNT_LOCKED_OR_CLOSED', message: 'The payee account is locked or closed.' }), true);
  });

  test('does not mistake a shopper funding failure for a capability problem', () => {
    assert.equal(isCapabilityRejection({ issue: 'INSTRUMENT_DECLINED', message: 'The payment was declined' }), false);
    assert.equal(isCapabilityRejection({ issue: 'INSUFFICIENT_FUNDS', message: 'Insufficient funds' }), false);
  });
});

describe('checkoutReturnUrls', () => {
  test('points both URLs at the order being paid for', () => {
    const urls = checkoutReturnUrls('https://shop.example', { _id: 'abc123' });
    assert.equal(urls.returnUrl, 'https://shop.example/checkout/abc123?from=paypal');
    assert.equal(urls.cancelUrl, 'https://shop.example/checkout/abc123?from=paypal&cancelled=1');
  });

  test('does not double the slash when the origin has a trailing one', () => {
    const urls = checkoutReturnUrls('https://shop.example/', { _id: 'abc123' });
    assert.equal(urls.returnUrl, 'https://shop.example/checkout/abc123?from=paypal');
  });
});

describe('requestOrigin', () => {
  const req = (headers, protocol = 'https') => ({ get: (name) => headers[name.toLowerCase()], protocol });

  test('uses the host the request arrived on', () => {
    assert.equal(requestOrigin(req({ host: 'paypal-hackathon.onrender.com' }), 'https://fallback.dev'), 'https://paypal-hackathon.onrender.com');
  });

  test('uses plain http in local development', () => {
    assert.equal(requestOrigin(req({ host: 'localhost:4000' }, 'http'), 'https://fallback.dev'), 'http://localhost:4000');
  });

  test('prefers the forwarded host, because the proxy may rewrite Host to an internal address', () => {
    const headers = { host: '10.0.0.5:8080', 'x-forwarded-host': 'paypal-hackathon.onrender.com' };
    assert.equal(requestOrigin(req(headers), 'https://fallback.dev'), 'https://paypal-hackathon.onrender.com');
  });

  test('takes the protocol from the forwarded header too', () => {
    const headers = { host: '10.0.0.5:8080', 'x-forwarded-host': 'paypal-hackathon.onrender.com', 'x-forwarded-proto': 'https' };
    assert.equal(requestOrigin(req(headers, 'http'), 'https://fallback.dev'), 'https://paypal-hackathon.onrender.com');
  });

  test('falls back when the request carries no usable host', () => {
    assert.equal(requestOrigin(req({}), 'https://fallback.dev'), 'https://fallback.dev');
  });
});
