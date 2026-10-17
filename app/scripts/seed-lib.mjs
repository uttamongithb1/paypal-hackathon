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

  // Target totals from docs/analytics_spec.md §7.
  const targets = { views: 1840, cartAdds: 312, checkoutAttempts: 96, purchases: 41 };
  const stepRates = {
    viewToCart: targets.cartAdds / targets.views,             // 0.170
    cartToCheckout: targets.checkoutAttempts / targets.cartAdds, // 0.308
    checkoutToPaid: targets.purchases / targets.checkoutAttempts // 0.427
  };
  const failures = { INSTRUMENT_DECLINED: 4, INSUFFICIENT_FUNDS: 2, CANCELED: 1 };

  // Deterministic PRNG so a reseeded demo is byte-identical on every machine.
  let seedState = 0x5eed1;
  const rand = () => ((seedState = (seedState * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  // Walk each *session* down the funnel instead of emitting each step as an independent daily
  // quota. Independent quotas floored every step at 1/day, so a 7-day window could show more
  // checkouts than cart adds — the spec's F1 ≥ F2 ≥ F3 ≥ F4 invariant (analytics_spec §7) was
  // violated by the seed data itself. Sessions make the funnel monotone in every window, and give
  // the session-scoped funnel real sessions to count.
  const totalBudget = curve.reduce((sum, weight) => sum + weight, 0);
  for (let day = days - 1; day >= 0; day -= 1) {
    const date = new Date(now - day * dayMs);
    const dayViews = Math.max(1, Math.round(targets.views * (curve[date.getDay()] / totalBudget) / (days / 7)));
    for (let i = 0; i < dayViews; i += 1) {
      const sessionId = `seed_s_${day}_${i % 60}`;
      const at = (minute) => new Date(date.getTime() - ((i * 137 + minute * 611) % 20_000) * 1000).toISOString();
      const product = productList[(day * 7 + i) % productList.length];
      events.push({
        eventId: uuid(), name: 'product_viewed', ts: at(9), source: 'server', sessionId,
        merchantId: product.merchantId, productId: product._id,
        props: { productId: product._id, surface: 'grid' }
      });
      if (rand() > stepRates.viewToCart) continue;
      events.push({
        eventId: uuid(), name: 'cart_item_added', ts: at(6), source: 'server', sessionId,
        merchantId: product.merchantId, productId: product._id,
        props: { productId: product._id, quantity: 1, unitPriceMinor: product.priceMinor, surface: 'card' }
      });
      if (rand() > stepRates.cartToCheckout) continue;
      const orderId = objectId();
      events.push({
        eventId: uuid(), name: 'checkout_started', ts: at(3), source: 'server', sessionId,
        merchantId: product.merchantId, productId: product._id,
        props: { orderId, orderNumber: `SP-2026-${String(100 + i).padStart(6, '0')}`, itemCount: 1 + (i % 3), totalMinor: product.priceMinor, attemptNo: 1, fromSurface: 'checkout' }
      });
      if (rand() > stepRates.checkoutToPaid) continue;
      events.push({
        eventId: uuid(), name: 'payment_captured', ts: at(1), source: 'server', sessionId,
        merchantId: product.merchantId, productId: product._id,
        props: { orderId, amountMinor: product.priceMinor, captureIdSuffix: String(100000 + i).slice(-6) }
      });
    }
  }

  // The agent is the product, but the seeder emitted no agent events at all — so the merchant
  // dashboard reported "0 agent turns · 0 recommendations shown" on a shop whose entire premise is
  // an agent. One turn per six views, with the recommendation attributed to the product the session
  // was already looking at, so the number is consistent with the funnel rather than invented.
  let agentTurns = 0;
  for (const event of [...events]) {
    if (event.name !== 'product_viewed') continue;
    if (rand() > 1 / 6) continue;
    agentTurns += 1;
    const at = new Date(new Date(event.ts).getTime() + 45_000).toISOString();
    events.push({
      eventId: uuid(), name: 'agent_turn_completed', ts: at, source: 'server', sessionId: event.sessionId,
      merchantId: event.merchantId,
      props: { toolCalls: 1 + Math.floor(rand() * 3), iterations: 1, durationMs: 1800 + Math.floor(rand() * 2600), stopped: false, profile: 'live' }
    });
    events.push({
      eventId: uuid(), name: 'recommendation_shown', ts: at, source: 'server', sessionId: event.sessionId,
      merchantId: event.merchantId, productId: event.productId,
      props: { productId: event.productId, rank: 1 + Math.floor(rand() * 3), reason: 'matched budget and category' }
    });
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
export async function seedAll(container, { demoOrders = false, history = false, analytics: withAnalytics = true } = {}) {
  wipe(container.store);
  const catalog = loadCatalog();
  const seeded = seedCatalogue(container.store, catalog);
  let demo = null;
  if (demoOrders) demo = await seedDemoOrders(container, { merchant: seeded.merchants['vertex-systems'], products: seeded.products });
  // `history` writes orders without touching PayPal, so a hosted instance can boot with a shop that
  // has a past. Without it the dashboard shows revenue of $0 beside products marked as sold.
  let historyResult = null;
  if (history) {
    historyResult = seedDemoHistory(container.store, {
      products: seeded.products,
      customers: Object.values(seeded.users),
      merchants: Object.values(seeded.merchants)
    });
  }
  let analyticsCount = 0;
  if (withAnalytics) analyticsCount = seedAnalytics(container.store, { products: seeded.products, merchants: seeded.merchants });
  await container.store.flush();
  return { catalog, ...seeded, demo, history: historyResult, analyticsCount };
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

/**
 * Historical orders, written straight into the store.
 *
 * The merchant dashboard had `paid revenue $0.00` beside a product table reading `SOLD 356`, and
 * the funnel claimed 41 purchases that no order backed. The contradiction was structural: analytics
 * were seeded from synthetic events, sold counts came from the catalogue fixture, and orders were
 * never seeded at all — `seedDemoOrders` routes through the real payment service, which would make
 * live PayPal calls on a host booting into sandbox mode.
 *
 * So this writes the orders directly and then *derives* the rest from them: every active product's
 * soldCount is the quantity actually sold in these orders, and the count of paid orders matches the
 * funnel's `purchases` target. One source, no disagreement.
 */
export function seedDemoHistory(store, { products, customers, merchants = [], days = 30, paidOrders = 41 } = {}) {
  const now = Date.now();
  const dayMs = 86_400_000;
  const active = products.filter((p) => p.status === 'active');
  const merchantsById = new Map(merchants.map((m) => [m._id, m]));
  const buyers = customers.filter((u) => u.role === 'customer');
  const TAX_BPS = 825;

  let seedState = 0x4f2a7;
  const rand = () => ((seedState = (seedState * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = (list) => list[Math.floor(rand() * list.length) % list.length];

  const orders = [];
  const sold = new Map();

  const build = (when, status) => {
    const lineCount = rand() < 0.28 ? 2 : 1;
    const chosen = [];
    while (chosen.length < lineCount) {
      const product = pick(active);
      if (!chosen.some((p) => p._id === product._id)) chosen.push(product);
    }
    const lines = chosen.map((product) => {
      const quantity = rand() < 0.22 ? 2 : 1;
      sold.set(product._id, (sold.get(product._id) ?? 0) + (status === 'paid' ? quantity : 0));
      return {
        productId: product._id,
        merchantId: product.merchantId,
        title: product.title,
        slug: product.slug,
        imageUrl: product.images?.[0] ?? null,
        brand: product.brand,
        unitPriceMinor: product.priceMinor,
        quantity,
        lineTotalMinor: product.priceMinor * quantity,
        currency: 'USD',
        attributesSnapshot: product.attributes ?? {}
      };
    });
    const subtotalMinor = lines.reduce((sum, l) => sum + l.lineTotalMinor, 0);
    const taxMinor = Math.round((subtotalMinor * TAX_BPS) / 10_000);
    const totalMinor = subtotalMinor + taxMinor;
    const merchantIds = [...new Set(lines.map((l) => l.merchantId))];

    // Split the total across merchants in proportion to their lines, giving the remainder to the
    // first unit so the units always sum to the total exactly.
    const perMerchant = new Map();
    for (const line of lines) perMerchant.set(line.merchantId, (perMerchant.get(line.merchantId) ?? 0) + line.lineTotalMinor);
    let allocated = 0;
    const units = [...perMerchant.entries()].map(([merchantId, amountMinor], index, all) => {
      const gross = index === all.length - 1 ? totalMinor - allocated : Math.round((amountMinor / subtotalMinor) * totalMinor);
      allocated += gross;
      const merchant = merchantsById.get(merchantId);
      return {
        referenceId: `m${index + 1}`,
        merchantId,
        merchantName: merchant?.name ?? 'Merchant',
        amountMinor: gross,
        platformFeeMinor: Math.round((gross * 500) / 10_000),
        payeeEmail: merchant?.payeeEmail ?? `${merchant?.slug ?? 'merchant'}@sandbox.demo`
      };
    });

    const buyer = pick(buyers);
    const orderId = objectId();
    const createdAt = new Date(when).toISOString();
    const isPaid = status === 'paid';
    const seq = store.nextSequence('orderNumber:2026');
    const orderNumber = `SP-2026-${String(seq).padStart(6, '0')}`;

    return {
      _id: orderId,
      createdAt,
      updatedAt: createdAt,
      orderNumber,
      userId: buyer?._id ?? null,
      sessionId: `seed_h_${orderId.slice(0, 10)}`,
      merchantIds,
      status,
      lines,
      amounts: { currency: 'USD', subtotalMinor, shippingMinor: 0, taxMinor, totalMinor, taxRateBps: TAX_BPS },
      quoteId: objectId(),
      quoteHash: 'h'.repeat(64),
      contact: { email: buyer?.email ?? 'customer@demo.dev', name: buyer?.displayName ?? 'Demo Customer' },
      payment: {
        provider: 'paypal',
        status: isPaid ? 'captured' : status === 'expired' ? 'failed' : 'created',
        amountVerified: isPaid,
        lastAttemptNo: 1,
        paypalOrderId: `SIMH-${orderId.slice(0, 12).toUpperCase()}`,
        settlement: { mode: units.length > 1 ? 'split' : 'single', units },
        ...(isPaid
          ? {
              paypalCaptureId: `SIMHCAP-${orderId.slice(0, 10).toUpperCase()}`,
              captures: [{ id: `SIMHCAP-${orderId.slice(0, 10).toUpperCase()}`, status: 'COMPLETED', amountMinor: totalMinor }],
              captureStatus: 'COMPLETED',
              payerId: 'SIMPAYER',
              capturedAt: createdAt
            }
          : {})
      },
      timeline: [{ at: createdAt, status: 'created', detail: 'Order created from quote' }],
      expiresAt: isPaid ? null : new Date(when + 15 * 60_000).toISOString(),
      paidAt: isPaid ? createdAt : null,
      // Marks history as generated so nobody mistakes it for a real transaction while reading the
      // store by hand. The UI treats these exactly like any other order.
      demo: true
    };
  };

  // The last three days stay unsettled: a couple awaiting payment and one expired, so "orders in
  // flight" is not zero and the expiry path is visible.
  for (let i = 0; i < paidOrders; i += 1) {
    const dayAgo = 3 + Math.floor(rand() * (days - 3));
    const when = now - dayAgo * dayMs - Math.floor(rand() * 20) * 3600_000;
    orders.push(build(when, 'paid'));
  }
  orders.push(build(now - 2 * 3600_000, 'awaiting_payment'));
  orders.push(build(now - 26 * 3600_000, 'awaiting_payment'));
  orders.push(build(now - 30 * 3600_000, 'expired'));

  orders.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  store.collection('orders').insertMany(orders);

  // soldCount is now a fact about the orders, not a fixture number.
  for (const product of products) {
    const count = sold.get(product._id) ?? 0;
    store.collection('products').updateOne({ _id: product._id }, { $set: { soldCount: count } });
  }

  return { orders: orders.length, paid: paidOrders, unitsSold: [...sold.values()].reduce((a, b) => a + b, 0) };
}
