/**
 * Seeding logic shared by scripts/seed.mjs, scripts/reset.mjs and the test suite.
 * Source of truth: ../data/seed.catalog.json (24 products, 3 merchants, 4 categories).
 */
import fs from 'node:fs';
import path from 'node:path';
import env from '../server/config/env.mjs';
import { hashPassword, objectId, sessionId as newSessionId, uuid } from '../server/lib/crypto.mjs';
import { formatMoney } from '../server/lib/money.mjs';

const CATALOG_PATH = path.join(env.appRoot, '..', 'data', 'seed.catalog.json');

export function loadCatalog() {
  return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
}

export function wipe(store) {
  for (const name of [
    'users', 'sessions', 'refresh_tokens', 'merchants', 'categories', 'products', 'price_history',
    'carts', 'quotes', 'orders', 'payment_attempts', 'inventory_holds', 'analytics_events',
    'webhook_events', 'idempotency_keys', 'chat_messages', 'counters'
  ]) {
    store.data[name] = [];
  }
  store.touch('users');
}

/** Inserts catalogue + demo users. Returns the id maps other scripts need. */
export function seedCatalogue(store, catalog) {
  const merchants = {};
  for (const merchant of catalog.merchants) {
    const row = store.collection('merchants').insert({ ...merchant, status: 'active' });
    merchants[merchant.slug] = row;
  }
  const categories = {};
  for (const category of catalog.categories) {
    const row = store.collection('categories').insert({ ...category, status: 'active' });
    categories[category.slug] = row;
  }
  const products = [];
  for (const product of catalog.products) {
    const merchant = merchants[product.merchantSlug];
    const category = categories[product.categorySlug];
    if (!merchant || !category) throw new Error(`Seed error: unknown merchant/category for ${product.slug}`);
    const schemaKeys = new Set(category.attributeSchema.map((a) => a.key));
    for (const key of Object.keys(product.attributes ?? {})) {
      if (!schemaKeys.has(key)) throw new Error(`Seed error: "${key}" is not in the ${product.categorySlug} attributeSchema`);
    }
    const row = store.collection('products').insert({
      slug: product.slug,
      title: product.title,
      brand: product.brand,
      sku: product.sku,
      merchantId: merchant._id,
      categoryId: category._id,
      priceMinor: product.priceMinor,
      compareAtPriceMinor: product.compareAtPriceMinor,
      currency: 'USD',
      stock: product.stock,
      attributes: product.attributes ?? {},
      specs: product.specs ?? [],
      pros: product.pros ?? [],
      cons: product.cons ?? [],
      badges: product.badges ?? [],
      images: product.images ?? [],
      description: product.description ?? '',
      shortDescription: product.shortDescription ?? '',
      warrantyMonths: product.warrantyMonths ?? 12,
      returnDays: product.returnDays ?? 14,
      ratingAvg: product.ratingAvg ?? 0,
      ratingCount: product.ratingCount ?? 0,
      soldCount: product.soldCount ?? 0,
      status: 'active'
    });
    products.push(row);
  }

  const users = {};
  for (const demo of catalog.demoUsers) {
    const merchant = demo.merchantSlug ? merchants[demo.merchantSlug] : null;
    const password = demo.passwordTemplate;
    users[demo.role] = store.collection('users').insert({
      role: demo.role,
      email: demo.email,
      emailLower: demo.email.toLowerCase(),
      passwordHash: hashPassword(password),
      displayName: demo.displayName,
      merchantId: merchant?._id,
      prefs: { theme: 'system' },
      status: 'active',
      lastSeenAt: new Date().toISOString()
    });
  }
  return { merchants, categories, products, users };
}

/** A signed-in session for a seeded user (so demo orders have a believable owner). */
export function sessionFor(store, user) {
  const session = store.collection('sessions').insert({
    _id: newSessionId(),
    userId: user._id,
    kind: 'user',
    chat: { requirement: null, requirementRevision: 0, lastCandidateProductIds: [], attachedProductIds: [], messageCount: 0 },
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString()
  });
  const cart = store.collection('carts').insert({
    ownerType: 'user',
    sessionId: session._id,
    userId: user._id,
    items: [],
    subtotalMinor: 0,
    currency: 'USD',
    status: 'active',
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString()
  });
  store.collection('sessions').updateOne({ _id: session._id }, { cartId: cart._id });
  return { session, cart };
}

/**
 * Demo orders generated through the REAL services (quote → order → PayPal simulator capture),
 * so the seeded state proves the flow works instead of faking rows.
 */
export async function seedDemoOrders(container, { merchant, products }) {
  const { store, catalogue, quote, order, payment, cart, analytics } = container;
  const customer = store.collection('users').findOne({ emailLower: 'customer@demo.dev' });
  const { session } = sessionFor(store, customer);
  const auth = { session, user: customer };
  const owner = { sessionId: session._id, userId: customer._id };

  const pick = (slug) => products.find((p) => p.slug === slug) ?? products[0];
  const results = { paid: null, failed: null, awaiting: null };

  // 1) Paid order (happy path through the simulator gateway).
  cart.addItem(owner, { productId: pick('ascent-book-14-pro')._id, quantity: 1 });
  cart.addItem(owner, { productId: pick('aeropeak-aero-anc-lite')._id, quantity: 1 });
  const q1 = quote.create({ ...owner, extendHolds: true });
  const o1 = await order.createFromQuote({ quoteId: q1.quote.id, quoteHash: q1.quote.hash, contact: { email: 'customer@demo.dev', name: 'Demo Customer' }, auth });
  const attempt1 = await payment.startAttempt(o1, {});
  const capture1 = await payment.capture({ orderId: o1._id, paypalOrderId: attempt1.paypalOrderId, auth, simulatedOutcome: 'approve' });
  results.paid = capture1.order;

  // 2) Failed then retried-to-success order (shows the retry path and two attempts).
  const o2 = await makeOrder(owner, [{ slug: 'novabook-air-13', quantity: 1 }], auth);
  const attempt2 = await payment.startAttempt(o2, {});
  try {
    await payment.capture({ orderId: o2._id, paypalOrderId: attempt2.paypalOrderId, auth, simulatedOutcome: 'decline' });
  } catch {
    /* expected decline */
  }
  const retry = await payment.retry({ orderId: o2._id, auth });
  await payment.capture({ orderId: o2._id, paypalOrderId: retry.paypalOrderId ?? attempt2.paypalOrderId, auth, simulatedOutcome: 'approve' });
  results.failed = order.toDto(order.find({ orderId: o2._id }));

  // 3) Awaiting payment (draft-ish) order — useful for demonstrating holds and expiry.
  const o3 = await makeOrder(owner, [{ slug: 'vview-27-qhd', quantity: 1 }], auth);
  await payment.startAttempt(o3, {});
  results.awaiting = order.toDto(order.find({ orderId: o3._id }));

  // 4) Abandoned carts (for the funnel and merchant curiosity).
  for (const slug of ['aeropeak-flight-pro', 'novatech-pulse-5-pro', 'vview-32-4k']) {
    const guest = store.collection('users').insert({ role: 'guest', displayName: 'Guest shopper', status: 'active' });
    const { session: gs } = sessionFor(store, guest);
    cart.addItem({ sessionId: gs._id }, { productId: pick(slug)._id, quantity: 1 });
  }

  analytics.emit('order_confirmed_viewed', { sessionId: session._id, userId: customer._id, orderId: results.paid.id, props: { orderId: results.paid.id, status: 'paid' } });

  async function makeOrder(ownerRef, lines, authRef) {
    for (const line of lines) cart.addItem(ownerRef, { productId: pick(line.slug)._id, quantity: line.quantity });
    const q = quote.create({ ...ownerRef, extendHolds: true });
    return order.createFromQuote({ quoteId: q.quote.id, quoteHash: q.quote.hash, contact: { email: 'customer@demo.dev', name: 'Demo Customer' }, auth: authRef });
  }

  return results;
}

/**
 * Synthetic analytics so the merchant dashboard is not empty (docs/analytics_spec.md §7).
 * Distribution follows a mild weekly curve; totals match the documented demo funnel.
 */
export function seedAnalytics(store, { products, merchants, days = 30 }) {
  const events = [];
  const now = Date.now();
  const dayMs = 86_400_000;
  const productList = products.filter((p) => p.status === 'active');
  const curve = [0.7, 0.85, 1.0, 1.1, 1.25, 1.35, 0.95]; // Sun..Sat

  const targets = { product_viewed: 1840, cart_item_added: 312, checkout_started: 96, payment_captured: 41 };
  const failures = { INSTRUMENT_DECLINED: 4, INSUFFICIENT_FUNDS: 2, CANCELED: 1 };
  let budget = 0;
  for (const weight of curve) budget += weight;

  for (const [name, total] of Object.entries(targets)) {
    for (let day = days - 1; day >= 0; day -= 1) {
      const date = new Date(now - day * dayMs);
      const weight = curve[date.getDay()] / budget;
      const dayCount = Math.max(1, Math.round(total * weight * (1 / (days / 7)) / 7));
      for (let i = 0; i < dayCount; i += 1) {
        const product = productList[(day * 7 + i) % productList.length];
        const ts = new Date(date.getTime() - (i * 137_000) % dayMs).toISOString();
        const sessionId = `seed_s_${day}_${i % 40}`;
        events.push({
          eventId: uuid(),
          name,
          ts,
          source: 'server',
          sessionId,
          merchantId: product.merchantId,
          productId: product._id,
          props:
            name === 'product_viewed'
              ? { productId: product._id, surface: 'grid' }
              : name === 'cart_item_added'
                ? { productId: product._id, quantity: 1, unitPriceMinor: product.priceMinor, surface: 'card' }
                : name === 'checkout_started'
                  ? { orderId: objectId(), orderNumber: `SP-2026-${String(100 + i).padStart(6, '0')}`, itemCount: 1 + (i % 3), totalMinor: product.priceMinor, attemptNo: 1, fromSurface: 'checkout' }
                  : { orderId: objectId(), amountMinor: product.priceMinor, captureIdSuffix: String(100000 + i).slice(-6) }
        });
      }
    }
  }

  for (const [reason, count] of Object.entries(failures)) {
    for (let i = 0; i < count; i += 1) {
      events.push({
        eventId: uuid(),
        name: 'payment_failed',
        ts: new Date(now - (i + 1) * 7 * 3600_000).toISOString(),
        source: 'server',
        sessionId: `seed_s_fail_${i}`,
        props: { orderId: objectId(), attemptNo: 1, reason }
      });
    }
  }

  store.collection('analytics_events').insertMany(events);
  return events.length;
}

/** Convenience wrapper used by seed.mjs / reset.mjs / tests. */
export async function seedAll(container, { demoOrders = false, analytics: withAnalytics = true } = {}) {
  wipe(container.store);
  const catalog = loadCatalog();
  const seeded = seedCatalogue(container.store, catalog);
  let demo = null;
  if (demoOrders) demo = await seedDemoOrders(container, { merchant: seeded.merchants['vertex-systems'], products: seeded.products });
  let analyticsCount = 0;
  if (withAnalytics) analyticsCount = seedAnalytics(container.store, { products: seeded.products, merchants: seeded.merchants });
  await container.store.flush();
  return { catalog, ...seeded, demo, analyticsCount };
}

export function summary(store) {
  const collections = store.stats();
  return Object.entries(collections)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name}: ${count}`)
    .join(' · ');
}

export function money(minor) {
  return formatMoney(minor);
}
