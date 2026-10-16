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
    // Merge the bounds *inside* `ts`: spreading two `{ ts: … }` objects makes the second overwrite
    // the first, which silently dropped `$gte` and returned all-time data for every range.
    const tsFilter = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
    const windowEvents = events.find(Object.keys(tsFilter).length ? { ts: tsFilter } : {});
    // An event belongs to a merchant if it is tagged with that merchant directly or (multi-store
    // events such as a cross-store comparison) lists it in `props.merchantIds`.
    const scoped = merchantId
      ? windowEvents.filter((e) => e.merchantId === merchantId || (e.props?.merchantIds ?? []).includes(merchantId))
      : windowEvents;
    const eventCounts = Object.fromEntries(names.map((n) => [n, scoped.filter((e) => e.name === n).length]));

    // The funnel is counted per session (analytics_spec §4: a "session" is `sessions._id`) and is
    // cumulative — a session that checked out is also counted in the cart and view steps. Counting
    // raw events instead lets a later step outrun an earlier one (a shopper can reach checkout from
    // a cart filled in an earlier session), which surfaces as a nonsense "Cart → checkout 150%".
    // Cumulative-by-session is monotone by construction, so F1 ≥ F2 ≥ F3 ≥ F4 always holds.
    const stageOf = { product_viewed: 1, cart_item_added: 2, checkout_started: 3, payment_captured: 4 };
    const deepest = new Map(); // sessionId → furthest stage reached (1 view · 2 cart · 3 checkout · 4 paid)
    for (const event of scoped) {
      const stage = stageOf[event.name];
      if (!stage) continue;
      const key = event.sessionId ?? `anon:${event._id}`;
      deepest.set(key, Math.max(deepest.get(key) ?? 0, stage));
    }
    const reached = (stage) => [...deepest.values()].filter((value) => value >= stage).length;
    const views = reached(1);
    const cartAdds = reached(2);
    const checkoutAttempts = reached(3);
    const purchases = reached(4);

    // analytics_spec §7: F1 ≥ F2 ≥ F3 ≥ F4 over the raw emit sites; a violation means an emit site
    // is under- or over-firing. Warn, never mutate, never fail the dashboard.
    const rawOrder = [eventCounts.product_viewed, eventCounts.cart_item_added, eventCounts.checkout_started, eventCounts.payment_captured];
    const emitViolations = rawOrder.slice(1).map((value, index) => (value > rawOrder[index] ? `${names[index]} < ${names[index + 1]}` : null)).filter(Boolean);
    if (emitViolations.length) {
      logger.warn('analytics.funnel_emit_mismatch', { merchantId: merchantId ?? null, violations: emitViolations, eventCounts });
    }

    const bps = (a, b) => (b > 0 ? Math.min(10000, Math.round((a / b) * 10000)) : 0);

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
      funnel: { views, cartAdds, checkoutAttempts, purchases, sessions: deepest.size },
      // Agent/AI telemetry behind the "is the AI actually doing anything?" dashboard tiles.
      // Recommendations are merchant-attributable; chat/turn/guardrail events are platform-level
      // (they carry no merchantId by design), so they are counted across the whole store and the
      // dashboard labels them as such rather than showing a false zero.
      counts: {
        recommendationShown: scoped.filter((e) => e.name === 'recommendation_shown').length,
        chatMessages: windowEvents.filter((e) => e.name === 'chat_message_sent').length,
        agentTurns: windowEvents.filter((e) => e.name === 'agent_turn_completed').length,
        guardrailsTriggered: windowEvents.filter((e) => e.name === 'guardrail_triggered').length,
        scope: merchantId ? 'merchant' : 'platform',
        events: eventCounts
      },
      reconcile: { emitViolations },
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

  /**
   * Invariant from analytics_spec §7: views ≥ cart adds ≥ checkout attempts ≥ purchases.
   * The funnel is cumulative per session, so a violation here means the aggregation itself broke —
   * the previous version tolerated `checkoutAttempts > cartAdds + views`, which is what let a
   * 150 % step rate reach the dashboard.
   */
  funnelViolations({ merchantId } = {}) {
    const { funnel } = this.dashboard({ merchantId });
    const violations = [];
    if (funnel.cartAdds > funnel.views) violations.push('cartAdds > views');
    if (funnel.checkoutAttempts > funnel.cartAdds) violations.push('checkoutAttempts > cartAdds');
    if (funnel.purchases > funnel.checkoutAttempts) violations.push('purchases > checkoutAttempts');
    return violations;
  }
}

export default AnalyticsService;
