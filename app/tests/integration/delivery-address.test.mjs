/**
 * The delivery address, end to end.
 *
 * Everything in the catalogue is a physical good, so the checkout has to know where the parcel
 * goes — and PayPal needs the address to build its review page. This file follows the address
 * from the request body into the order, out to the DTO, and into the PayPal order we create, so
 * the hosted checkout is given something real to show the buyer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, createClient } from '../helpers/harness.mjs';

const server = await startServer({ seed: 'catalogue' });
test.after(async () => {
  await server.stop();
});

const { base } = server;

const ADDRESS = {
  name: 'Aarav Sharma',
  line1: '12 Brigade Road',
  line2: 'Flat 402',
  city: 'Gorakhpur',
  state: 'Uttar Pradesh',
  postalCode: '273001',
  countryCode: 'IN'
};

// Each order reserves stock, and a product whose stock just moved re-prices — which makes the
// next quote stale. Rotating over the roomiest products keeps every order independent.
let rotation = 0;
async function placeOrder(body) {
  const client = createClient(base);
  await client.guest();
  const products = await client.call('/products?limit=24');
  const roomy = products.body.items.filter((p) => p.stock > 3).sort((a, b) => b.stock - a.stock);
  const product = roomy[rotation % roomy.length];
  rotation += 1;
  await client.call('/cart/items', { method: 'POST', body: { productId: product.id, quantity: 1 } });
  const quote = await client.call('/checkout/quote', { method: 'POST', body: { extendHolds: true } });
  const created = await client.call('/orders', {
    method: 'POST',
    body: {
      quoteId: quote.body.quote.id,
      quoteHash: quote.body.quote.hash,
      contact: { email: 'shopper.address@demo.dev', name: 'Aarav Sharma' },
      ...body
    }
  });
  return { client, created };
}

test('an order keeps the delivery address it was placed with', async () => {
  const { created } = await placeOrder({ shippingAddress: ADDRESS });
  assert.equal(created.status, 201, `order creation failed: ${JSON.stringify(created.body)}`);
  assert.deepEqual(created.body.order.shippingAddress, {
    name: ADDRESS.name,
    line1: ADDRESS.line1,
    line2: ADDRESS.line2,
    city: ADDRESS.city,
    state: ADDRESS.state,
    postalCode: ADDRESS.postalCode,
    countryCode: ADDRESS.countryCode
  });
});

test('an order without an address is still allowed, and says so', async () => {
  const { created } = await placeOrder({});
  assert.equal(created.status, 201);
  assert.equal(created.body.order.shippingAddress, null);
});

test('a malformed address is rejected rather than silently dropped', async () => {
  const { created } = await placeOrder({ shippingAddress: { ...ADDRESS, countryCode: 'INDIA' } });
  assert.equal(created.status, 400);
  assert.equal(created.body.error.code, 'VALIDATION_ERROR');
});

test('the PayPal order carries the address and a return URL back to this order', async () => {
  const { client, created } = await placeOrder({ shippingAddress: ADDRESS });
  const orderId = created.body.order.id;

  const paypalOrder = await client.call(`/dev/paypal/order/${orderId}`);
  assert.equal(paypalOrder.status, 200, `the PayPal order was not created: ${JSON.stringify(paypalOrder.body)}`);

  const context = paypalOrder.body.experience_context;
  assert.ok(context, 'the PayPal order must carry an experience_context');
  assert.equal(context.shipping_preference, 'SET_PROVIDED_ADDRESS');
  assert.equal(context.return_url, `http://127.0.0.1:${new URL(base).port}/checkout/${orderId}?from=paypal`);
  assert.equal(context.cancel_url, `http://127.0.0.1:${new URL(base).port}/checkout/${orderId}?from=paypal&cancelled=1`);

  const unit = paypalOrder.body.purchase_units[0];
  assert.equal(unit.shipping.name.full_name, ADDRESS.name);
  assert.equal(unit.shipping.address.address_line_1, ADDRESS.line1);
  assert.equal(unit.shipping.address.admin_area_2, ADDRESS.city);
  assert.equal(unit.shipping.address.postal_code, ADDRESS.postalCode);
  assert.equal(unit.shipping.address.country_code, 'IN');
});

test('with no address of our own, PayPal is told to use the buyer wallet address', async () => {
  const { client, created } = await placeOrder({});
  const paypalOrder = await client.call(`/dev/paypal/order/${created.body.order.id}`);
  assert.equal(paypalOrder.body.experience_context.shipping_preference, 'GET_FROM_FILE');
  assert.equal(paypalOrder.body.purchase_units[0].shipping, undefined);
});
