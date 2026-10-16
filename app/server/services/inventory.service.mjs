/**
 * Inventory: soft holds with TTL, available-to-sell, and atomic commits.
 * Docs: ../docs/data_model.md §2.12, ../docs/architecture.md §5.4 (atomic stock)
 */
import { HOLD_STATUS } from '../domain/orderState.mjs';
import { ApiError } from '../lib/errors.mjs';
import env from '../config/env.mjs';

export class InventoryService {
  constructor(store) {
    this.store = store;
  }

  get products() {
    return this.store.collection('products');
  }

  get holds() {
    return this.store.collection('inventory_holds');
  }

  /** Active holds that do not belong to `excludeCartId` (a shopper's own hold never blocks them). */
  activeHolds(productId, { excludeCartId = null, excludeOrderId = null } = {}) {
    return this.holds.find({
      productId,
      status: HOLD_STATUS.ACTIVE,
      ...(excludeCartId ? { cartId: { $ne: excludeCartId } } : {}),
      ...(excludeOrderId ? { orderId: { $ne: excludeOrderId } } : {})
    });
  }

  availableFor(productId, options = {}) {
    const product = this.products.findOne({ _id: productId });
    if (!product) return 0;
    const held = this.activeHolds(productId, options).reduce((sum, h) => sum + h.quantity, 0);
    return Math.max(0, product.stock - held);
  }

  availableForAll(productIds, options = {}) {
    return Object.fromEntries(productIds.map((id) => [id, this.availableFor(id, options)]));
  }

  /** Create or extend holds for a cart at quote time. Returns the hold rows. */
  createOrExtendHolds({ cartId, sessionId, lines, ttlMinutes = env.quoteTtlMinutes }) {
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
    const created = [];
    for (const line of lines) {
      const existing = this.holds.findOne({ cartId, productId: line.productId, status: HOLD_STATUS.ACTIVE });
      const available = this.availableFor(line.productId, { excludeCartId: cartId });
      if (available < line.quantity) {
        throw new ApiError('INSUFFICIENT_STOCK', `Only ${available} left of ${line.title ?? line.productId}.`, {
          details: { productId: line.productId, available, requested: line.quantity }
        });
      }
      if (existing) {
        created.push(this.holds.updateOne({ _id: existing._id }, { quantity: line.quantity, expiresAt }));
      } else {
        created.push(
          this.holds.insert({
            orderId: null,
            cartId,
            sessionId,
            productId: line.productId,
            merchantId: line.merchantId,
            quantity: line.quantity,
            status: HOLD_STATUS.ACTIVE,
            expiresAt
          })
        );
      }
    }
    // Drop holds for lines that were removed from the cart.
    const keep = new Set(lines.map((l) => l.productId));
    for (const stale of this.holds.find({ cartId, status: HOLD_STATUS.ACTIVE })) {
      if (!keep.has(stale.productId)) this.holds.updateOne({ _id: stale._id }, { status: HOLD_STATUS.RELEASED, releasedAt: new Date().toISOString() });
    }
    return created;
  }

  claimForOrder(cartId, orderId) {
    for (const hold of this.holds.find({ cartId, status: HOLD_STATUS.ACTIVE })) {
      this.holds.updateOne({ _id: hold._id }, { orderId });
    }
  }

  release({ orderId, cartId, reason = 'released' }) {
    const filter = { status: HOLD_STATUS.ACTIVE, ...(orderId ? { orderId } : { cartId }) };
    const released = this.holds.find(filter);
    for (const hold of released) {
      this.holds.updateOne({ _id: hold._id }, { status: HOLD_STATUS.RELEASED, releasedAt: new Date().toISOString(), reason });
    }
    return released.length;
  }

  /**
   * Commit holds on successful payment: decrements stock atomically per line with a stock >= qty
   * guard. Any failure rolls the whole commit back (no partial fulfilment) — data_model.md I4.
   */
  commitForOrder(orderId) {
    const holds = this.holds.find({ orderId, status: HOLD_STATUS.ACTIVE });
    if (!holds.length) return { committed: 0, failures: [] };
    const failures = [];
    let committed = 0;
    for (const hold of holds) {
      const updated = this.products.findOneAndUpdate(
        { _id: hold.productId, stock: { $gte: hold.quantity } },
        { $inc: { stock: -hold.quantity, soldCount: hold.quantity } }
      );
      if (!updated) {
        failures.push({ productId: hold.productId, quantity: hold.quantity, reason: 'STOCK_COMMIT_FAILED' });
        continue;
      }
      this.holds.updateOne({ _id: hold._id }, { status: HOLD_STATUS.COMMITTED, committedAt: new Date().toISOString() });
      committed += 1;
    }
    if (failures.length) {
      // Roll back what we already decremented so the invariant "no partial fulfilment" holds.
      for (const hold of holds.slice(0, committed)) {
        const done = this.holds.findOne({ _id: hold._id, status: HOLD_STATUS.COMMITTED });
        if (done) {
          this.products.updateOne({ _id: hold.productId }, { $inc: { stock: hold.quantity, soldCount: -hold.quantity } });
          this.holds.updateOne({ _id: hold._id }, { status: HOLD_STATUS.ACTIVE, committedAt: undefined });
        }
      }
      return { committed: 0, failures };
    }
    return { committed, failures };
  }

  /** Scheduler hook: expire holds and mark their orders expired. */
  releaseExpired(now = new Date()) {
    const expired = this.holds.find({ status: HOLD_STATUS.ACTIVE, expiresAt: { $lt: now.toISOString() } });
    for (const hold of expired) {
      this.holds.updateOne({ _id: hold._id }, { status: HOLD_STATUS.RELEASED, releasedAt: now.toISOString(), reason: 'expired' });
    }
    return expired;
  }

  activeHoldCount(productId) {
    return this.activeHolds(productId).reduce((sum, h) => sum + h.quantity, 0);
  }
}

export default InventoryService;
