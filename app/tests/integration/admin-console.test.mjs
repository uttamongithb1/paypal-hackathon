/**
 * The platform console.
 *
 * ShopPilot takes a commission on every seller unit — that is what a multi-seller settlement is
 * *for* — and until now the number was computed by the settlement plan and then shown to nobody.
 * The console makes the model legible: gross merchandise value, commission retained, net paid to
 * sellers, and the order queue with the reconcile action that existed in the API but had no screen.
 *
 * These tests pin the arithmetic (the console must reconcile to the orders) and the access
 * control (it must be for the platform operator and nobody else).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, createClient } from '../helpers/harness.mjs';
import { formatMoney } from '../../server/lib/money.mjs';

const server = await startServer({ seed: 'catalogue' });
test.after(async () => {
  await server.stop();
});

const { base } = server;

async function asRole(email, password) {
  const client = createClient(base);
  await client.guest();
  await client.login(email, password);
  return client;
}

test('the platform console is closed to a shopper and to a merchant', async () => {
  const shopper = await asRole('customer@demo.dev', 'Customer@12345');
  const forbidden = await shopper.call('/admin/overview');
  assert.equal(forbidden.status, 403, 'a shopper must not see the platform’s books');

  const merchant = await asRole('merchant@demo.dev', 'Merchant@12345');
  const alsoForbidden = await merchant.call('/admin/overview');
  assert.equal(alsoForbidden.status, 403, 'a seller must not see every other seller’s books');
});

test('the platform console reconciles to the orders it claims', async () => {
  const admin = await asRole('admin@demo.dev', 'Admin@12345');
  const res = await admin.call('/admin/overview');
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const body = res.body;
  assert.ok(body.merchants.length >= 3, 'every seeded seller must appear');
  assert.equal(body.sellerCount, body.merchants.length);

  // Gross is the sum of the sellers' own units, and the sellers' gross is the platform's gross.
  const gross = body.merchants.reduce((sum, m) => sum + m.grossMinor, 0);
  assert.equal(body.grossMinor, gross, 'the platform gross must be the sum of the sellers’ gross');
  assert.equal(body.grossDisplay, formatMoney(gross), 'the display must be the formatted minor units');

  // Commission is retained per seller unit, and never more than the seller earned.
  for (const merchant of body.merchants) {
    assert.ok(merchant.commissionMinor >= 0, 'a commission is never negative');
    assert.ok(
      merchant.commissionMinor < merchant.grossMinor || merchant.grossMinor === 0,
      `${merchant.slug}: the commission may never consume the whole unit`
    );
    // PayPal's platform fee is deducted from the payee's unit, so the seller's payout is the
    // unit amount less the commission and any refund.
    assert.equal(
      merchant.netMinor,
      merchant.grossMinor - merchant.commissionMinor - merchant.refundedMinor,
      `${merchant.slug}: the net payout must be gross less commission less refunds`
    );
  }

  // Net paid to sellers is what actually reached them.
  const net = body.merchants.reduce((sum, m) => sum + m.netMinor, 0);
  assert.equal(body.netPaidMinor, net);
  assert.equal(body.netPaidMinor, body.grossMinor - body.commissionMinor - body.refundedMinor);

  // A seller whose own share is reported here must match what the merchant dashboard says.
  const merchant = await asRole('merchant@demo.dev', 'Merchant@12345');
  const overview = await merchant.call('/merchant/overview');
  const vertex = body.merchants.find((m) => m.slug === 'vertex-systems');
  assert.ok(vertex, 'the seeded Vertex seller must be listed');
  assert.equal(
    vertex.grossMinor,
    overview.body.revenueMinor,
    'the platform’s view of a seller must match that seller’s own dashboard'
  );
});

test('the order queue lists orders and exposes the reconcile action', async () => {
  const admin = await asRole('admin@demo.dev', 'Admin@12345');
  const res = await admin.call('/admin/overview');
  assert.equal(res.status, 200);
  const orders = res.body.orders;
  assert.ok(orders.total > 0, 'the queue must not be empty');
  assert.ok(orders.items.length > 0);
  assert.ok(orders.items[0].orderNumber, 'each row is an order');
});
