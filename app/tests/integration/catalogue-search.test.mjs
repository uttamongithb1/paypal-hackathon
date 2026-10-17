/**
 * Catalogue search — the visible box, not the agent.
 *
 * The agent parses intent before it searches, so it handled "cheap phone" and "headphones under
 * $200" from day one. The plain search box did not: it required *every* token to appear somewhere
 * in the record, so "gaming laptop" returned 0 results on a catalogue holding six laptops, and
 * "cheap phone" returned 0 while three phones sat in stock. The box is the first thing a visitor
 * touches, so the failure was the most visible one on the site.
 *
 * Two behaviours are pinned here:
 *   1. a partial match beats an empty grid, and matching happens on word boundaries — "phone"
 *      must not match "headphone", which plain substring matching did
 *   2. a price cue becomes a real price filter rather than another word to match
 *
 * It also covers the availability ordering: a shop should not open with something nobody can buy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, asNewCustomer } from '../helpers/harness.mjs';

const server = await startServer({ seed: 'catalogue' });

test.after(async () => {
  await server.stop();
});

const { base } = server;
const search = async (client, q) => client.call('/products?q=' + encodeURIComponent(q));

const titlesOf = (payload) => (payload.items ?? []).map((p) => p.title.toLowerCase());

test('"gaming laptop" finds laptops instead of nothing', async () => {
  const client = await asNewCustomer(base, 'search-gaming');
  const res = await search(client, 'gaming laptop');
  assert.equal(res.status, 200);
  assert.ok(res.body.total > 0, 'a two-word phrase must not empty the grid');
  // The head noun decides the category. Before the matcher was fixed this returned 0 results;
  // after the first fix it returned results but ranked monitors above laptops, because a monitor
  // described as "gaming" scored the same as a laptop matching "laptop".
  const categories = (res.body.items ?? []).map((p) => (p.category?.name ?? '').toLowerCase());
  const laptops = categories.filter((c) => c === 'laptops').length;
  assert.ok(laptops >= 3, `expected laptops to dominate, got ${categories.join(', ')}`);
  assert.equal(categories[0], 'laptops', `the best match should be a laptop, got ${categories[0]}`);
});

test('fillers are ignored: "cheap phone" still finds phones', async () => {
  const client = await asNewCustomer(base, 'search-cheap');
  const res = await search(client, 'cheap phone');
  assert.ok(res.body.total > 0);
  for (const title of titlesOf(res.body)) {
    assert.ok(!title.includes('headphone'), `"phone" must not match "headphone": ${title}`);
  }
});

test('a price cue becomes a filter, not a keyword', async () => {
  const client = await asNewCustomer(base, 'search-budget');
  const res = await search(client, 'headphones under 200');
  assert.ok(res.body.total > 0, 'the budget phrase should still return the cheap headphones');
  for (const item of res.body.items) {
    assert.ok(item.price.amountMinor <= 20000, `${item.title} costs ${item.price.display}, over the stated budget`);
  }
});

test('"below", "less than" and "up to" read the same as "under"', async () => {
  const client = await asNewCustomer(base, 'search-phrases');
  for (const phrase of ['monitor below 300', 'monitor less than 300', 'monitor up to 300']) {
    const res = await search(client, phrase);
    for (const item of res.body.items) {
      assert.ok(item.price.amountMinor <= 30000, `${phrase} → ${item.title} at ${item.price.display}`);
    }
  }
});

test('a budget in thousands is expanded, not read as 2 dollars', async () => {
  const client = await asNewCustomer(base, 'search-thousands');
  const res = await search(client, 'laptop under $2k');
  assert.ok(res.body.total > 0);
  for (const item of res.body.items) assert.ok(item.price.amountMinor <= 200000);
});

test('a partial word still finds the product', async () => {
  const client = await asNewCustomer(base, 'search-partial');
  const res = await search(client, 'lap');
  assert.ok(res.body.total > 0, 'typing "lap" should match a laptop');
});

test('the default order never leads with something out of stock', async () => {
  const client = await asNewCustomer(base, 'search-sort');
  const res = await client.call('/products?limit=50');
  const items = res.body.items ?? [];
  const firstOutOfStock = items.findIndex((p) => p.availability === 'out_of_stock' || p.availability === 'sold_out');
  if (firstOutOfStock !== -1) {
    const after = items.slice(firstOutOfStock);
    assert.ok(
      after.every((p) => p.availability === 'out_of_stock' || p.availability === 'sold_out'),
      'no in-stock product may sort below an out-of-stock one'
    );
  }
});
