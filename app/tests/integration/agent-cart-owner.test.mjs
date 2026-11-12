/**
 * Regression: the agent and the HTTP cart must address the SAME cart for a given shopper.
 *
 * The bug: the agent keyed cart writes by `ctx.user?._id`, but a guest user has an _id while the
 * HTTP layer keys a guest's cart by session (userId undefined). So a guest asking the assistant to
 * "add the cheapest to my cart" filled a user-keyed cart that GET /cart never read — the item
 * silently vanished. Both layers now normalise guest → session via the same cartOwner contract.
 *
 * Drives the deterministic agent (FEATURE_LIVE_LLM=false in the harness) over real HTTP.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, createClient, asCustomer } from '../helpers/harness.mjs';

const server = await startServer({ seed: 'catalogue' });
test.after(async () => { await server.stop(); });

/** Search, then ask the agent to add the cheapest candidate; return the add turn. */
async function agentAddCheapest(client) {
  await client.chat('show me laptops');
  return client.chat('add the cheapest to my cart');
}

test('a guest agent add_to_cart lands in the same cart GET /cart reads', async () => {
  const client = createClient(server.base);
  const guest = await client.guest();
  assert.equal(guest.body.user.role, 'guest');

  const turn = await agentAddCheapest(client);
  assert.ok(turn.tools.includes('add_to_cart'), `agent should have called add_to_cart, got [${turn.tools.join(', ')}]`);

  const cart = await client.call('/cart');
  assert.equal(cart.status, 200);
  assert.ok(cart.body.cart.itemCount >= 1, `guest cart must contain the agent-added item, got itemCount=${cart.body.cart.itemCount}`);
  assert.ok(cart.body.cart.subtotalMinor > 0, 'the shared cart must have a real subtotal');
});

test('a guest agent view_cart reports the item added over HTTP (one cart, both directions)', async () => {
  const client = createClient(server.base);
  await client.guest();
  const products = await client.call('/products?category=laptops&limit=6');
  const product = [...products.body.items].sort((a, b) => b.stock - a.stock)[0];
  await client.call('/cart/items', { method: 'POST', body: { productId: product.id, quantity: 1 } });

  const turn = await client.chat('view my cart');
  const summary = turn.components.find((c) => c?.type === 'cart_summary' || c?.cart);
  // The agent's view must see the HTTP-added item, not an empty user-keyed cart.
  const cart = await client.call('/cart');
  assert.equal(cart.body.cart.itemCount, 1);
  assert.ok(turn.text.length > 0, 'the agent responded about the cart');
});

test('a signed-in customer agent add_to_cart still lands in their user cart', async () => {
  const client = await asCustomer(server.base);
  const turn = await agentAddCheapest(client);
  assert.ok(turn.tools.includes('add_to_cart'), `agent should have called add_to_cart, got [${turn.tools.join(', ')}]`);
  const cart = await client.call('/cart');
  assert.equal(cart.status, 200);
  assert.ok(cart.body.cart.itemCount >= 1, `customer cart must contain the agent-added item, got ${cart.body.cart.itemCount}`);
});
