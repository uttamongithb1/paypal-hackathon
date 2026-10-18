/**
 * Order service: creation from a quote, immutable snapshots, the state machine guard, cancellation,
 * order history and merchant-side transitions.
 * Docs: ../docs/data_model.md §2.10 + §3, ../docs/api_spec.md §5–6
 */
import { ApiError } from '../lib/errors.mjs';
import { CANCELLABLE_STATUSES, ORDER_STATUS, PAYMENT_STATUS, assertTransition, canTransition } from '../domain/orderState.mjs';
import { formatMoney } from '../lib/money.mjs';
import env from '../config/env.mjs';

export class OrderService {
  constructor(store, { catalogue, quote, inventory, cart, analytics, payment }) {
    this.store = store;
    this.catalogue = catalogue;
    this.quote = quote;
    this.inventory = inventory;
    this.cart = cart;
    this.analytics = analytics;
    this.payment = payment;
  }

  get orders() {
    return this.store.collection('orders');
  }

  /**
   * Create the order the customer explicitly approved. Recomputes the quote first: if the money
   * moved, it refuses with QUOTE_STALE and a diff (never silently charges a new amount).
   */
  async createFromQuote({ quoteId, quoteHash, contact, shippingAddress, auth }) {
    const quoteDoc = this.quote.byId(quoteId);
    if (!quoteDoc) throw new ApiError('QUOTE_STALE', 'That quote has expired. Review your cart and try again.');
    if (quoteDoc.sessionId !== auth.session._id) throw new ApiError('FORBIDDEN', 'That quote belongs to another session.');

    const ownerCart = this.cart.getOrCreate({ sessionId: auth.session._id, userId: auth.user._id });
    // The holds backing this quote belong to this cart — excluding them is what stops a valid
    // checkout from reporting its own reservation as OUT_OF_STOCK.
    const fresh = this.quote.recomputeForLines(quoteDoc.lines, { excludeCartId: ownerCart._id, excludeOrderId: quoteDoc.orderId ?? null });
    if (fresh.unavailableLines.length) {
      throw new ApiError('ITEM_UNAVAILABLE', 'Some items are no longer available.', {
        details: { items: fresh.unavailableLines.map((l) => ({ productId: l.productId, title: l.title, reason: 'OUT_OF_STOCK' })) }
      });
    }
    if (quoteHash && quoteDoc.hash !== quoteHash) {
      throw new ApiError('QUOTE_STALE', 'Your quote changed. Please review the new total.', {
        details: { diff: this.quote.diff(quoteDoc, fresh) }
      });
    }
    if (quoteDoc.hash !== fresh.hash) {
      throw new ApiError('QUOTE_STALE', 'Prices changed since you reviewed this order.', { details: { diff: this.quote.diff(quoteDoc, fresh) } });
    }
    if (!contact?.email) throw new ApiError('VALIDATION_ERROR', 'An email address is required to place the order.');

    const cartDoc = ownerCart;
    const merchantIds = [...new Set(fresh.lines.map((l) => l.merchantId))];
    const order = this.orders.insert({
      orderNumber: this.store.nextOrderNumber(),
      userId: auth.user._id,
      sessionId: auth.session._id,
      merchantIds,
      status: ORDER_STATUS.AWAITING_PAYMENT,
      lines: fresh.lines.map((line) => {
        const product = this.catalogue.getRaw(line.productId);
        return {
          productId: line.productId,
          merchantId: line.merchantId,
          title: product.title,
          slug: product.slug,
          imageUrl: product.images?.[0]?.url,
          brand: product.brand,
          unitPriceMinor: line.unitPriceMinor,
          quantity: line.quantity,
          lineTotalMinor: line.lineTotalMinor,
          currency: 'USD',
          attributesSnapshot: product.attributes
        };
      }),
      amounts: {
        currency: 'USD',
        subtotalMinor: fresh.subtotalMinor,
        shippingMinor: fresh.shippingMinor,
        taxMinor: fresh.taxMinor,
        totalMinor: fresh.totalMinor,
        taxRateBps: env.taxRateBps
      },
      quoteId: quoteDoc._id,
      quoteHash: quoteDoc.hash,
      contact: { email: String(contact.email).toLowerCase(), name: contact.name },
      shippingAddress: shippingAddress ? {
        name: shippingAddress.name,
        line1: shippingAddress.line1,
        line2: shippingAddress.line2 ?? '',
        city: shippingAddress.city,
        state: shippingAddress.state,
        postalCode: shippingAddress.postalCode,
        countryCode: shippingAddress.countryCode
      } : null,
      payment: { provider: 'paypal', status: 'none', amountVerified: false, lastAttemptNo: 0 },
      timeline: [{ at: new Date().toISOString(), event: 'order_created', actor: 'user' }],
      expiresAt: new Date(Date.now() + env.quoteTtlMinutes * 60_000).toISOString()
    });

    this.quote.quotes.updateOne({ _id: quoteDoc._id }, { status: 'consumed', orderId: order._id });
    this.inventory.claimForOrder(cartDoc._id, order._id);
    this.analytics.emit('checkout_started', {
      sessionId: auth.session._id,
      userId: auth.user._id,
      merchantId: merchantIds[0],
      orderId: order._id,
      props: { orderId: order._id, orderNumber: order.orderNumber, itemCount: order.lines.length, totalMinor: order.amounts.totalMinor, attemptNo: 1, fromSurface: 'checkout' }
    });
    return order;
  }

  toDto(order) {
    const merchants = [...new Set(order.lines.map((l) => l.merchantId))]
      .map((id) => this.catalogue.merchant(id))
      .filter(Boolean)
      .map((m) => ({ id: m._id, name: m.name, supportEmail: m.supportEmail, policies: m.policies }));
    return {
      id: order._id,
      orderNumber: order.orderNumber,
      status: order.status,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      paidAt: order.paidAt ?? null,
      expiresAt: order.expiresAt ?? null,
      lines: order.lines.map((l) => ({ ...l, unitPriceDisplay: formatMoney(l.unitPriceMinor), lineTotalDisplay: formatMoney(l.lineTotalMinor) })),
      merchants,
      amounts: {
        ...order.amounts,
        display: {
          subtotal: formatMoney(order.amounts.subtotalMinor),
          shipping: formatMoney(order.amounts.shippingMinor),
          tax: formatMoney(order.amounts.taxMinor),
          total: formatMoney(order.amounts.totalMinor)
        }
      },
      contact: { email: order.contact?.email, name: order.contact?.name },
      shippingAddress: order.shippingAddress ?? null,
      payment: order.payment,
      timeline: order.timeline ?? []
    };
  }

  find({ orderId }) {
    const order = this.orders.findOne({ _id: orderId });
    if (!order) throw new ApiError('ORDER_NOT_FOUND', "We couldn't find that order.");
    return order;
  }

  /** Owner, session owner, merchant of any line, or admin. Cross-tenant reads 404 (no existence leak). */
  findAuthorised({ orderId, auth }) {
    const order = this.orders.findOne({ _id: orderId });
    if (!order) throw new ApiError('ORDER_NOT_FOUND', "We couldn't find that order.");
    const user = auth.user;
    if (!user) throw new ApiError('ORDER_NOT_FOUND', "We couldn't find that order.");
    const isOwner = order.userId === user._id;
    const isSessionOwner = order.sessionId === auth.session?._id;
    const isMerchant = user.role === 'merchant' && order.lines.some((l) => l.merchantId === user.merchantId);
    const isAdmin = user.role === 'admin';
    if (!isOwner && !isSessionOwner && !isMerchant && !isAdmin) throw new ApiError('ORDER_NOT_FOUND', "We couldn't find that order.");
    return order;
  }

  listForCustomer(auth, { status, page = 1, limit = 20 } = {}) {
    const user = auth.user;
    const filter = user.role === 'guest' ? { sessionId: auth.session._id } : { userId: user._id };
    if (status) filter.status = status;
    const rows = this.orders.find(filter, { sort: { createdAt: -1 } });
    const start = (Math.max(1, page) - 1) * limit;
    return { items: rows.slice(start, start + limit).map((o) => this.toDto(o)), total: rows.length, page, limit, hasMore: start + limit < rows.length };
  }

  listForMerchant(merchantId, { status, paymentStatus, q, page = 1, limit = 20 } = {}) {
    let rows = this.orders.find({ merchantIds: merchantId }, { sort: { createdAt: -1 } });
    if (status) rows = rows.filter((o) => o.status === status);
    if (paymentStatus) rows = rows.filter((o) => o.payment?.status === paymentStatus);
    if (q) {
      const needle = String(q).toLowerCase();
      rows = rows.filter((o) => o.orderNumber.toLowerCase().includes(needle) || (o.contact?.email ?? '').toLowerCase().includes(needle));
    }
    const total = rows.length;
    const start = (Math.max(1, page) - 1) * limit;
    return { items: rows.slice(start, start + limit).map((o) => this.toDto(o)), total, page, limit, hasMore: start + limit < total };
  }

  /** Every order on the platform, newest first — the admin's order queue. */
  listForAdmin({ status, paymentStatus, q, page = 1, limit = 25 } = {}) {
    let rows = this.orders.find({}, { sort: { createdAt: -1 } });
    if (status) rows = rows.filter((o) => o.status === status);
    if (paymentStatus) rows = rows.filter((o) => o.payment?.status === paymentStatus);
    if (q) {
      const needle = String(q).toLowerCase();
      rows = rows.filter((o) => o.orderNumber.toLowerCase().includes(needle)
        || (o.contact?.email ?? '').toLowerCase().includes(needle)
        || (o.merchantIds ?? []).some((id) => String(id).toLowerCase().includes(needle)));
    }
    const total = rows.length;
    const start = (Math.max(1, page) - 1) * limit;
    return {
      items: rows.slice(start, start + limit).map((o) => this.toDto(o)),
      total,
      page,
      limit,
      hasMore: start + limit < total
    };
  }

  timeline(orderId, event, actor = 'system', meta) {
    const order = this.find({ orderId });
    const entry = { at: new Date().toISOString(), event, actor, ...(meta ? { meta } : {}) };
    return this.orders.updateOne({ _id: order._id }, { $push: { timeline: entry } });
  }

  /** Only whitelisted transitions; payment_failed → paid is impossible by construction. */
  transition(orderId, to, { actor = 'system', meta } = {}) {
    const order = this.find({ orderId });
    assertTransition(order.status, to);
    const patch = { status: to };
    if (to === ORDER_STATUS.PAID) patch.paidAt = new Date().toISOString();
    if (to === ORDER_STATUS.CANCELLED) patch.cancelledAt = new Date().toISOString();
    if (to === ORDER_STATUS.SHIPPED) patch.shippedAt = new Date().toISOString();
    if (to === ORDER_STATUS.DELIVERED) patch.deliveredAt = new Date().toISOString();
    if (to === ORDER_STATUS.REFUNDED) patch.refundedAt = new Date().toISOString();
    const updated = this.orders.findOneAndUpdate({ _id: orderId }, { ...patch, $push: { timeline: { at: new Date().toISOString(), event: `status_${to}`, actor, ...(meta ? { meta } : {}) } } });
    return updated;
  }

  /**
   * Record refunds against an order.
   *
   * A multi-seller order holds one capture per seller, so a refund belongs to a capture. The order
   * only becomes `refunded` when every capture has been refunded; until then it stays in flight
   * with `payment.status = 'partially_refunded'`. A seller refunding their own share can no
   * longer mark a co-seller's lines — or their revenue — as refunded.
   */
  recordRefunds(orderId, { refunds = [], reason, actor = 'merchant', totalCaptures } = {}) {
    const order = this.find({ orderId });
    if (!refunds.length) throw new ApiError('INVALID_STATE', 'No refund was supplied for this order.');
    const existing = order.payment?.refunds ?? [];
    const all = [...existing, ...refunds.map((r) => ({ ...r, at: new Date().toISOString() }))];
    const refundedCaptureIds = new Set(all.map((r) => r.captureId));
    const captures = order.payment?.captures ?? [];
    const scope = totalCaptures ?? captures.length;
    const fullyRefunded = scope > 0 && refundedCaptureIds.size >= scope;

    this.orders.updateOne(
      { _id: orderId },
      { 'payment.refunds': all, 'payment.refundId': all[all.length - 1].refundId }
    );

    let updated;
    if (fullyRefunded) {
      updated = this.transition(orderId, ORDER_STATUS.REFUNDED, { actor, meta: { reason } });
      this.orders.updateOne({ _id: orderId }, { 'payment.status': PAYMENT_STATUS.REFUNDED });
    } else {
      this.orders.updateOne({ _id: orderId }, { 'payment.status': PAYMENT_STATUS.PARTIALLY_REFUNDED });
      this.timeline(orderId, 'order_partially_refunded', actor, {
        reason,
        refundedCaptures: refunds.length,
        totalCaptures: scope
      });
      updated = this.find({ orderId });
    }

    this.analytics.emit('order_refunded', {
      sessionId: order.sessionId,
      userId: order.userId,
      orderId,
      props: {
        orderId,
        reason,
        refundId: all[all.length - 1].refundId,
        amountMinor: refunds.reduce((sum, r) => sum + r.amountMinor, 0),
        full: fullyRefunded
      }
    });
    return updated;
  }

  cancel(orderId, { auth, actor = 'user' } = {}) {
    const order = auth ? this.findAuthorised({ orderId, auth }) : this.find({ orderId });
    if (!CANCELLABLE_STATUSES.includes(order.status)) {
      throw new ApiError('INVALID_STATE', `An order that is "${order.status}" cannot be cancelled.`);
    }
    this.inventory.release({ orderId, reason: 'order_cancelled' });
    if (order.payment?.paypalOrderId) {
      this.payment?.voidPayPalOrder?.(order.payment.paypalOrderId);
    }
    const updated = this.transition(orderId, ORDER_STATUS.CANCELLED, { actor, meta: { previousStatus: order.status } });
    this.analytics.emit('order_cancelled', { sessionId: order.sessionId, userId: order.userId, orderId, props: { orderId, previousStatus: order.status } });
    return updated;
  }

  markShipped(orderId, merchantId, tracking) {
    const order = this.find({ orderId });
    if (!order.lines.some((l) => l.merchantId === merchantId)) throw new ApiError('ORDER_NOT_FOUND', "We couldn't find that order.");
    const from = order.status === ORDER_STATUS.PAID ? ORDER_STATUS.PROCESSING : order.status;
    if (from !== order.status) this.transition(orderId, ORDER_STATUS.PROCESSING, { actor: 'merchant' });
    return this.transition(orderId, ORDER_STATUS.SHIPPED, { actor: 'merchant', meta: tracking ? { tracking } : undefined });
  }

  canPay(order) {
    return canTransition(order.status, ORDER_STATUS.PAYMENT_PROCESSING) || order.status === ORDER_STATUS.PAYMENT_PROCESSING;
  }

  /**
   * Revenue is what this merchant was actually paid, not the size of every basket they appear in.
   *
   * The old implementation added `amounts.totalMinor` for every order whose `merchantIds` contained
   * the merchant — so on a two-merchant basket, each merchant's dashboard counted the *other*
   * merchant's money as its own revenue. In a marketplace this is the number that must not be
   * wrong, and it directly contradicts the thing the product is selling: one cart, several
   * merchants, settled separately.
   *
   * Each order stores its settlement units, so the merchant's share is their own unit's amount.
   * Orders written before settlement units existed fall back to the order total, which is exact for
   * single-merchant baskets and is the only figure available for them.
   */
  revenue({ merchantId, from, to }) {
    const rows = this.orders.find({
      status: { $in: [ORDER_STATUS.PAID, ORDER_STATUS.PROCESSING, ORDER_STATUS.SHIPPED, ORDER_STATUS.DELIVERED] },
      ...(merchantId ? { merchantIds: merchantId } : {}),
      ...(from ? { paidAt: { $gte: from } } : {})
    });
    const share = (order) => {
      const units = order.payment?.settlement?.units;
      const captures = order.payment?.captures ?? [];
      // Gross: what this seller's own share of the basket was. A seller who is not part of the
      // order contributes nothing rather than the whole basket.
      let gross;
      if (merchantId && Array.isArray(units) && units.length) {
        gross = units.filter((unit) => unit.merchantId === merchantId).reduce((sum, unit) => sum + unit.amountMinor, 0);
      } else if (merchantId && captures.some((c) => c.merchantId)) {
        gross = captures.filter((c) => c.merchantId === merchantId).reduce((sum, c) => sum + (c.amountMinor ?? 0), 0);
      } else {
        gross = order.amounts.totalMinor;
      }
      // Money already sent back to the shopper is not revenue.
      const refunded = (order.payment?.refunds ?? [])
        .filter((r) => !merchantId || r.merchantId === merchantId)
        .reduce((sum, r) => sum + (r.amountMinor ?? 0), 0);
      return Math.max(0, gross - refunded);
    };
    const revenueMinor = rows.reduce((sum, order) => sum + share(order), 0);
    const refundedMinor = rows.reduce((sum, order) => sum + (order.payment?.refunds ?? [])
      .filter((r) => !merchantId || r.merchantId === merchantId)
      .reduce((s, r) => s + (r.amountMinor ?? 0), 0), 0);
    return {
      revenueMinor,
      refundedMinor,
      paidOrders: rows.length,
      avgOrderValueMinor: rows.length ? Math.round(revenueMinor / rows.length) : 0
    };
  }

  /**
   * The platform view: every seller, the gross merchandise value, and ShopPilot's commission.
   *
   * The commission is the whole point of a multi-seller settlement — the money the platform keeps
   * for routing a basket to several independent sellers — and until now it was computed in the
   * settlement plan and then shown to nobody. This is what makes the model legible instead of
   * merely implemented.
   */
  platformOverview() {
    const paid = this.orders.find({
      status: { $in: [ORDER_STATUS.PAID, ORDER_STATUS.PROCESSING, ORDER_STATUS.SHIPPED, ORDER_STATUS.DELIVERED] }
    });
    const refunded = this.orders.find({ status: ORDER_STATUS.REFUNDED });
    const refundedMinor = refunded.reduce((sum, order) => sum + (order.amounts?.totalMinor ?? 0), 0);

    const byMerchant = new Map();
    const add = (merchantId, patch) => {
      const current = byMerchant.get(merchantId) ?? {
        merchantId,
        orders: 0,
        grossMinor: 0,
        commissionMinor: 0,
        refundedMinor: 0,
        units: 0
      };
      for (const [key, value] of Object.entries(patch)) current[key] += value;
      byMerchant.set(merchantId, current);
    };

    for (const order of paid) {
      const units = order.payment?.settlement?.units ?? [];
      const refunds = order.payment?.refunds ?? [];
      for (const unit of units) {
        if (!unit.merchantId) continue;
        const refunded = refunds
          .filter((r) => r.merchantId === unit.merchantId)
          .reduce((sum, r) => sum + (r.amountMinor ?? 0), 0);
        add(unit.merchantId, {
          orders: 1,
          units: 1,
          grossMinor: unit.amountMinor,
          commissionMinor: unit.platformFeeMinor ?? 0,
          refundedMinor: refunded
        });
      }
    }

    const merchants = this.catalogue.merchants.find({}).map((merchant) => {
      const row = byMerchant.get(merchant._id) ?? {
        merchantId: merchant._id,
        orders: 0,
        grossMinor: 0,
        commissionMinor: 0,
        refundedMinor: 0,
        units: 0
      };
      return {
        merchantId: merchant._id,
        name: merchant.name,
        slug: merchant.slug,
        orders: row.orders,
        units: row.units,
        grossMinor: row.grossMinor,
        commissionMinor: row.commissionMinor,
        refundedMinor: row.refundedMinor,
        // PayPal's platform fee is deducted from the payee's unit: the seller is paid the unit
        // amount less the commission. "Gross" is what the shopper was charged for that seller's
        // goods; "net" is what actually reached the seller.
        netMinor: row.grossMinor - row.commissionMinor - row.refundedMinor,
        grossDisplay: formatMoney(row.grossMinor),
        commissionDisplay: formatMoney(row.commissionMinor),
        refundedDisplay: formatMoney(row.refundedMinor),
        netDisplay: formatMoney(row.grossMinor - row.commissionMinor - row.refundedMinor)
      };
    }).sort((a, b) => b.grossMinor - a.grossMinor);

    const grossMinor = merchants.reduce((sum, m) => sum + m.grossMinor, 0);
    const commissionMinor = merchants.reduce((sum, m) => sum + m.commissionMinor, 0);
    const netPaidMinor = merchants.reduce((sum, m) => sum + m.netMinor, 0);
    const splitOrders = this.orders.find({ 'payment.settlement.mode': 'split' }).length;
    const multiSellerOrders = this.orders.find({}).filter((o) => new Set(o.lines.map((l) => l.merchantId)).size > 1).length;

    return {
      currency: 'USD',
      merchants,
      sellerCount: merchants.length,
      paidOrders: paid.length,
      refundedOrders: refunded.length,
      refundedMinor,
      refundedDisplay: formatMoney(refundedMinor),
      grossMinor,
      grossDisplay: formatMoney(grossMinor),
      commissionMinor,
      commissionDisplay: formatMoney(commissionMinor),
      netPaidMinor,
      netPaidDisplay: formatMoney(netPaidMinor),
      commissionRateBps: grossMinor ? Math.round((commissionMinor * 10_000) / grossMinor) : 0,
      splitOrders,
      multiSellerOrders,
      revenueMinor: netPaidMinor,
      revenueDisplay: formatMoney(netPaidMinor),
      avgOrderValueMinor: paid.length ? Math.round(netPaidMinor / paid.length) : 0,
      avgOrderValueDisplay: formatMoney(paid.length ? Math.round(netPaidMinor / paid.length) : 0)
    };
  }

  overview(merchantId) {
    const revenue = this.revenue({ merchantId });
    const allOrders = this.orders.find({ merchantIds: merchantId }, { sort: { createdAt: -1 } });
    const checkoutAttempts = this.analytics.count('checkout_started', { merchantId });
    const purchases = this.analytics.count('payment_captured', { merchantId });
    return {
      ...revenue,
      currency: 'USD',
      revenueDisplay: formatMoney(revenue.revenueMinor),
      avgOrderValueDisplay: formatMoney(revenue.avgOrderValueMinor),
      conversionRateBps: checkoutAttempts ? Math.round((purchases / checkoutAttempts) * 10000) : 0,
      lowStock: this.catalogue.lowStock(3, merchantId),
      recentOrders: allOrders.slice(0, 5).map((o) => this.toDto(o)),
      totalOrders: allOrders.length
    };
  }
}

export default OrderService;
