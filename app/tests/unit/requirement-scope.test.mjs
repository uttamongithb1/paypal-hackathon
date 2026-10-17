/**
 * Regression tests for requirement extraction: a comparison cue belongs to the quantity it sits
 * next to. "a laptop under $900 with 16 GB RAM" caps the price and floors the RAM — reading the
 * whole-message cue would silently flip the RAM constraint to ≤ 16 GB and ground the agent on the
 * wrong products. See docs/ai_agent_spec.md §5.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRequirement } from '../../server/agent/requirement.mjs';

const parse = (message) => extractRequirement(message, {}).requirement;
const constraint = (requirement, key) => requirement.hardConstraints.find((c) => c.key === key);

test('a budget cue does not leak onto an attribute in the same sentence', () => {
  const r = parse('I need a laptop for full-stack development under $900 with 16GB RAM and a 512GB SSD');
  assert.equal(r.categorySlug, 'laptops');
  assert.equal(r.budgetMinor, 90000);
  assert.equal(constraint(r, 'ramGb').op, 'gte');
  assert.equal(constraint(r, 'ramGb').value, 16);
  assert.equal(constraint(r, 'storageGb').op, 'gte');
  assert.equal(constraint(r, 'storageGb').value, 512);
});

test('an explicit maximum on RAM is still honoured', () => {
  const r = parse('cheapest laptop 8GB RAM max');
  assert.equal(constraint(r, 'ramGb').op, 'lte');
  assert.equal(constraint(r, 'ramGb').value, 8);
});

test('trailing cues read through the attribute name ("16 GB RAM or more")', () => {
  const r = parse('laptop with 16GB RAM or more and up to $500');
  assert.equal(constraint(r, 'ramGb').op, 'gte');
  assert.equal(r.budgetMinor, 50000);
});

test('terabyte storage is converted, not read as 1 GB', () => {
  for (const message of ['laptop with RAM at least 32GB and a 1TB SSD', 'laptop under $700 with a 1TB SSD', 'laptop under $700 storage: 1tb']) {
    const r = parse(message);
    assert.equal(constraint(r, 'storageGb').value, 1024, message);
    assert.equal(constraint(r, 'storageGb').label, 'Storage ≥ 1 TB', message);
  }
});

test('a price is never mistaken for a spec quantity', () => {
  const r = parse('laptop under $700 storage: 1tb');
  assert.equal(r.budgetMinor, 70000, 'the $700 stays the budget');
  assert.equal(constraint(r, 'storageGb').value, 1024);
});

test('screen size follows the same scoping rule', () => {
  const under = parse('monitor under $400 with 27 inch screen');
  assert.equal(under.budgetMinor, 40000);
  assert.equal(constraint(under, 'screenIn').op, 'gte');

  const capped = parse('monitor no more than 24 inch, under $300');
  assert.equal(constraint(capped, 'screenIn').op, 'lte');
  assert.equal(constraint(capped, 'screenIn').value, 24);
});

/**
 * Budget multipliers. A shopper who types "under 10k" means ten thousand; reading the digits and
 * dropping the suffix produced a $10.00 budget, which matched nothing and made the agent look like
 * it had misheard. Reported from the live demo ("i need to buy a mobile phone under 10k" ->
 * "≤ $10.00").
 */
test('a k suffix multiplies the budget instead of being discarded', () => {
  assert.equal(parse('i need to buy a mobile phone under 10k').budgetMinor, 1_000_000);
  assert.equal(parse('phone under 10K').budgetMinor, 1_000_000);
});

test('fractional and spelled-out multipliers resolve to the same number', () => {
  assert.equal(parse('phone under 1.5k').budgetMinor, 150_000);
  assert.equal(parse('phone under 10 thousand').budgetMinor, 1_000_000);
  assert.equal(parse('headphones under 2 lakh').budgetMinor, 20_000_000);
  assert.equal(parse('laptop under 1 crore').budgetMinor, 1_000_000_000);
});

test('a plain number is still read as written', () => {
  assert.equal(parse('laptop under $900').budgetMinor, 90_000);
  assert.equal(parse('laptop under 900 for coding').budgetMinor, 90_000);
  assert.equal(parse('laptop under $1,200').budgetMinor, 120_000);
});

test('a following word is never mistaken for a multiplier', () => {
  // "900 monitors" must not become 900 million because the next word starts with an m.
  assert.equal(parse('monitors under 900 monitors').budgetMinor, 90_000);
  assert.equal(parse('laptop under 900 minimum 16 GB RAM').budgetMinor, 90_000);
});
