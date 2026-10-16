/**
 * Analytics service — fire-and-forget event capture plus the aggregation queries behind the
 * merchant dashboard. Docs: ../docs/analytics_spec.md
 */
import { uuid } from '../lib/crypto.mjs';
import { validateEvent } from '../domain/analyticsEvents.mjs';
import logger from '../lib/logger.mjs';
import env from '../config/env.mjs';

export class AnalyticsService {
  constructor(store) {
    this.store = store;
    this.rejected = 0;
  }

  /** Never throws into the request path. */
  emit(name, { sessionId, userId, merchantId, productId, orderId, props = {}, dedupeKey, ts } = {}) {
    if (!env.featureAnalytics) return null;
    try {
      const { ok, props: clean } = validateEvent({ name, props });
      if (!ok) {
        this.rejected += 1;
        logger.warn('analytics.event.rejected', { name, reason: validateEvent({ name, props }).reason });
        return null;
      }
      const event = {
        eventId: uuid(),
        name,
        ts: ts ?? new Date().toISOString(),
        source: 'server',
        sessionId,
        userId,
        merchantId,
        productId,
        orderId,
        props: clean,
        ...(dedupeKey ? { dedupeKey } : {})
      };
      if (dedupeKey && this.store.collection('analytics_events').findOne({ dedupeKey })) return null;
      this.store.collection('analytics_events').insert(event);
      return event;
    } catch (err) {
      logger.error('analytics.emit.failed', { name, error: err.message });
      return null;
    }
  }

  /** Client-supplied events (beacon). Deduplicated by eventId; invalid events dropped. */
  ingestClient(events, context = {}) {
    const accepted = [];
    for (const incoming of events ?? []) {
      const { ok, props } = validateEvent(incoming);
      if (!ok) {
        this.rejected += 1;
        continue;
      }
      if (this.store.collection('analytics_events').findOne({ eventId: incoming.eventId })) continue;
      accepted.push({
        eventId: incoming.eventId,
        name: incoming.name,
        ts: incoming.ts ?? new Date().toISOString(),
        source: 'client',
        sessionId: context.sessionId,
        userId: context.userId,
        productId: props.productId,
        props
      });
    }
    if (accepted.length) this.store.collection('analytics_events').insertMany(accepted);
    return { accepted: accepted.length };
  }

  count(name, { from, to, merchantId } = {}) {
    const filter = { name };
    if (from) filter.ts = { ...(filter.ts ?? {}), $gte: from };
    if (to) filter.ts = { ...(filter.ts ?? {}), $lte: to };
    if (merchantId) filter.merchantId = merchantId;
    return this.store.collection('analytics_events').count(filter);
  }

  /** Funnel + rates + timeseries + per-product performance + payment health. */
  dashboard({ merchantId, from, to, tz = 'UTC' } = {}) {
    const events = this.store.collection('analytics_events');
    const names = ['product_viewed', 'cart_item_added', 'checkout_started', 'payment_captured'];
    const counts = Object.fromEntries(names.map((n) => [n, this.count(n, { from, to, merchantId })]));
    const views = counts.product_viewed;
    const cartAdds = counts.cart_item_added;
    const checkoutAttempts = counts.checkout_started;
    const purchases = counts.payment_captured;

    const bps = (a, b) => (b > 0 ? Math.round((a / b) * 10000) : 0);

    const dayKey = (iso) => iso.slice(0, 10);
    const byDay = new Map();
    for (const event of events.find({ ts: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) }, ...(merchantId ? { merchantId } : {}) })) {
      if (!names.includes(event.name)) continue;
      const key = dayKey(event.ts);
      const bucket = byDay.get(key) ?? { date: key, views: 0, cartAdds: 0, checkoutAttempts: 0, purchases: 0 };
      if (event.name === 'product_viewed') bucket.views += 1;
      if (event.name === 'cart_item_added') bucket.cartAdds += 1;
      if (event.name === 'checkout_started') bucket.checkoutAttempts += 1;
      if (event.name === 'payment_captured') bucket.purchases += 1;
      byDay.set(key, bucket);
    }
    const timeseries = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));

    const productStats = new Map();
    for (const event of events.find({ ...(from ? { ts: { $gte: from } } : {}), ...(merchantId ? { merchantId } : {}) })) {
      if (!['product_viewed', 'cart_item_added', 'payment_captured'].includes(event.name)) continue;
      const id = event.productId ?? event.props?.productId;
      if (!id) continue;
      const stat = productStats.get(id) ?? { productId: id, views: 0, cartAdds: 0, purchases: 0 };
      if (event.name === 'product_viewed') stat.views += 1;
      if (event.name === 'cart_item_added') stat.cartAdds += 1;
      if (event.name === 'payment_captured') stat.purchases += 1;
      productStats.set(id, stat);
    }
    const products = [...productStats.values()]
      .map((stat) => {
        const product = this.store.collection('products').findOne({ _id: stat.productId });
        return {
          ...stat,
          title: product?.title ?? 'Unknown product',
          slug: product?.slug,
          viewToPurchaseBps: bps(stat.purchases, stat.views)
        };
      })
      .sort((a, b) => b.views - a.views)
      .slice(0, 10);

    const attempts = this.store.collection('payment_attempts').find({});
    const reasons = new Map();
    for (const attempt of attempts) {
      if (attempt.status === 'failed' && attempt.failureReason) {
        reasons.set(attempt.failureReason, (reasons.get(attempt.failureReason) ?? 0) + 1);
      }
    }

    return {
      range: { from, to, tz },
      funnel: { views, cartAdds, checkoutAttempts, purchases },
      rates: {
        viewToCartBps: bps(cartAdds, views),
        cartToCheckoutBps: bps(checkoutAttempts, cartAdds),
        checkoutToPaidBps: bps(purchases, checkoutAttempts),
        viewToPurchaseBps: bps(purchases, views)
      },
      timeseries,
      products,
      paymentHealth: {
        attempts: attempts.length,
        captured: attempts.filter((a) => a.status === 'succeeded').length,
        failed: attempts.filter((a) => a.status === 'failed').length,
        pending: attempts.filter((a) => a.status === 'pending').length,
        failureReasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count)
      }
    };
  }

  /** Invariant from analytics_spec §7: views ≥ cart adds ≥ checkout attempts ≥ purchases. */
  funnelViolations({ merchantId } = {}) {
    const counts = this.dashboard({ merchantId }).funnel;
    const violations = [];
    if (counts.cartAdds > counts.views) violations.push('cartAdds > views');
    if (counts.checkoutAttempts > counts.cartAdds + counts.views) violations.push('checkoutAttempts > cartAdds');
    if (counts.purchases > counts.checkoutAttempts) violations.push('purchases > checkoutAttempts');
    return violations;
  }
}

export default AnalyticsService;
