/**
 * Cart service. Live prices, server-side quantities, stock caps and change warnings.
 * Docs: ../docs/api_spec.md §4, ../docs/data_model.md §2.8
 */
import { ApiError } from '../lib/errors.mjs';
import { formatMoney } from '../lib/money.mjs';
import env from '../config/env.mjs';

export class CartService {
  constructor(store, { catalogue, inventory }) {
    this.store = store;
    this.catalogue = catalogue;
    this.inventory = inventory;
  }

  get carts() {
    return this.store.collection('carts');
  }

  find({ sessionId, userId }) {
    const filter = userId ? { userId, status: 'active' } : { sessionId, status: 'active' };
    return this.carts.findOne(filter);
  }

  getOrCreate({ sessionId, userId }) {
    const existing = this.find({ sessionId, userId });
    if (existing) return existing;
    return this.carts.insert({
      ownerType: userId ? 'user' : 'session',
      sessionId,
      userId: userId ?? undefined,
      items: [],
      subtotalMinor: 0,
      currency: 'USD',
      status: 'active',
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString()
    });
  }

  /** Cart → API shape with live prices and warnings. Never trusts stored totals. */
  toDto(cart) {
    const items = [];
    const warnings = [];
    let subtotalMinor = 0;

    for (const line of cart.items ?? []) {
      const product = this.catalogue.getRaw(line.productId);
      if (!product || product.status === 'archived' || product.stock <= 0) {
        warnings.push({
          code: 'ITEM_UNAVAILABLE',
          productId: line.productId,
          message: `${line.snapshot?.title ?? 'An item'} is no longer available and will be removed at checkout.`
        });
        items.push({
          productId: line.productId,
          title: line.snapshot?.title ?? 'Unavailable item',
          slug: line.snapshot?.slug,
          imageUrl: line.snapshot?.imageUrl,
          brand: line.snapshot?.brand,
          quantity: line.quantity,
          unitPriceMinor: product?.priceMinor ?? line.priceAtAddMinor ?? 0,
          lineTotalMinor: 0,
          availableStock: 0,
          maxQuantity: 0,
          unavailable: true,
          addedAt: line.addedAt
        });
        continue;
      }
      const available = this.inventory.availableFor(product._id, { excludeCartId: cart._id });
      const quantity = Math.min(line.quantity, Math.max(1, available || product.stock));
      const lineTotalMinor = product.priceMinor * quantity;
      subtotalMinor += lineTotalMinor;
      const merchant = this.catalogue.merchant(product.merchantId);
      if (line.priceAtAddMinor && line.priceAtAddMinor !== product.priceMinor) {
        warnings.push({
          code: 'PRICE_CHANGED',
          productId: product._id,
          fromMinor: line.priceAtAddMinor,
          toMinor: product.priceMinor,
          message: `The price of ${product.title} changed from ${formatMoney(line.priceAtAddMinor)} to ${formatMoney(product.priceMinor)}.`
        });
      }
      if (product.stock <= 3) {
        warnings.push({ code: 'LOW_STOCK', productId: product._id, message: `Only ${product.stock} left of ${product.title}.` });
      }
      items.push({
        productId: product._id,
        title: product.title,
        slug: product.slug,
        imageUrl: product.images?.[0]?.url,
        brand: product.brand,
        merchant: merchant ? { id: merchant._id, name: merchant.name } : null,
        quantity,
        unitPriceMinor: product.priceMinor,
        lineTotalMinor,
        unitPriceDisplay: formatMoney(product.priceMinor),
        lineTotalDisplay: formatMoney(lineTotalMinor),
        availableStock: available,
        maxQuantity: Math.min(env.maxLineQty, Math.max(1, available)),
        priceChangedFromMinor: line.priceAtAddMinor && line.priceAtAddMinor !== product.priceMinor ? line.priceAtAddMinor : null,
        addedAt: line.addedAt
      });
    }

    return {
      id: cart._id,
      itemCount: items.reduce((sum, i) => sum + (i.unavailable ? 0 : i.quantity), 0),
      subtotalMinor,
      currency: 'USD',
      display: formatMoney(subtotalMinor),
      items,
      warnings,
      freeShippingRemainingMinor: Math.max(0, env.shippingFreeThresholdMinor - subtotalMinor)
    };
  }

  addItem({ sessionId, userId }, { productId, quantity, addedVia = 'card' }) {
    const product = this.catalogue.getRaw(productId);
    if (!product) throw new ApiError('PRODUCT_NOT_FOUND', 'That product is not in the catalogue.');
    if (product.status !== 'active') throw new ApiError('PRODUCT_ARCHIVED', 'That product is no longer for sale.');
    const cart = this.getOrCreate({ sessionId, userId });
    const existing = (cart.items ?? []).find((i) => i.productId === productId);
    const available = this.inventory.availableFor(productId, { excludeCartId: cart._id });
    const requested = (existing?.quantity ?? 0) + quantity;
    if (available < 1) throw new ApiError('INSUFFICIENT_STOCK', `${product.title} is out of stock.`, { details: { productId, available: 0 } });
    if (requested > available) {
      const capped = Math.max(0, available);
      const clamped = Math.min(requested, Math.min(env.maxLineQty, capped));
      this.writeLine(cart, product, clamped, existing);
      throw new ApiError('INSUFFICIENT_STOCK', `Only ${capped} left of ${product.title} — your cart has been set to ${clamped}.`, {
        details: { productId, available: capped, applied: clamped }
      });
    }
    if (!existing && (cart.items ?? []).length >= env.maxCartLines) {
      throw new ApiError('CART_LINE_LIMIT', `A cart can hold up to ${env.maxCartLines} different products.`);
    }
    const next = Math.min(requested, env.maxLineQty);
    this.writeLine(cart, product, next, existing);
    return { cart: this.toDto(this.find({ sessionId, userId })), addedVia };
  }

  writeLine(cart, product, quantity, existing) {
    const items = [...(cart.items ?? [])];
    const snapshot = { title: product.title, slug: product.slug, imageUrl: product.images?.[0]?.url, brand: product.brand };
    if (existing) {
      const idx = items.findIndex((i) => i.productId === product._id);
      items[idx] = { ...items[idx], quantity, priceAtAddMinor: product.priceMinor, snapshot };
    } else {
      items.push({
        productId: product._id,
        merchantId: product.merchantId,
        quantity,
        priceAtAddMinor: product.priceMinor,
        snapshot,
        addedAt: new Date().toISOString()
      });
    }
    const subtotalMinor = items.reduce((sum, line) => {
      const live = this.catalogue.getRaw(line.productId);
      return sum + (live ? live.priceMinor * line.quantity : 0);
    }, 0);
    this.carts.updateOne({ _id: cart._id }, { items, subtotalMinor });
    return items;
  }

  setQuantity({ sessionId, userId }, productId, quantity) {
    const cart = this.getOrCreate({ sessionId, userId });
    const existing = (cart.items ?? []).find((i) => i.productId === productId);
    if (!existing) throw new ApiError('CART_ITEM_NOT_FOUND', 'That item is not in your cart.');
    if (quantity === 0) return this.removeItem({ sessionId, userId }, productId);
    const product = this.catalogue.getRaw(productId);
    const available = this.inventory.availableFor(productId, { excludeCartId: cart._id });
    if (quantity > available) {
      const applied = Math.max(1, Math.min(available, env.maxLineQty));
      this.writeLine(cart, product, applied, existing);
      throw new ApiError('INSUFFICIENT_STOCK', `Only ${available} left of ${product.title} — quantity set to ${applied}.`, {
        details: { productId, available, applied }
      });
    }
    this.writeLine(cart, product, Math.min(quantity, env.maxLineQty), existing);
    return { cart: this.toDto(this.find({ sessionId, userId })) };
  }

  removeItem({ sessionId, userId }, productId) {
    const cart = this.getOrCreate({ sessionId, userId });
    const items = (cart.items ?? []).filter((i) => i.productId !== productId);
    this.carts.updateOne({ _id: cart._id }, { items });
    this.inventory.release({ cartId: cart._id, reason: 'line_removed' });
    return { cart: this.toDto(this.find({ sessionId, userId })) };
  }

  clear({ sessionId, userId }) {
    const cart = this.getOrCreate({ sessionId, userId });
    this.carts.updateOne({ _id: cart._id }, { items: [], subtotalMinor: 0 });
    this.inventory.release({ cartId: cart._id, reason: 'cart_cleared' });
    return { cart: this.toDto(this.find({ sessionId, userId })) };
  }

  markConverted(cartId) {
    this.carts.updateOne({ _id: cartId }, { status: 'converted' });
    this.carts.insert({
      ownerType: 'session',
      sessionId: this.carts.findOne({ _id: cartId })?.sessionId,
      userId: this.carts.findOne({ _id: cartId })?.userId,
      items: [],
      subtotalMinor: 0,
      currency: 'USD',
      status: 'active',
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString()
    });
  }

  /** Guest → customer merge: sum quantities, cap at stock, drop unavailable lines (FR-1.4). */
  merge(sourceCart, targetCart) {
    const merged = [...(targetCart.items ?? [])];
    let addedQuantity = 0;
    for (const line of sourceCart.items ?? []) {
      const product = this.catalogue.getRaw(line.productId);
      if (!product || product.status !== 'active' || product.stock <= 0) continue;
      const existing = merged.find((i) => i.productId === line.productId);
      const available = this.inventory.availableFor(product._id, { excludeCartId: targetCart._id });
      const cap = Math.max(1, Math.min(available, env.maxLineQty));
      if (existing) {
        const before = existing.quantity;
        existing.quantity = Math.min(existing.quantity + line.quantity, cap);
        addedQuantity += existing.quantity - before;
      } else {
        const quantity = Math.min(line.quantity, cap);
        merged.push({ ...line, quantity });
        addedQuantity += quantity;
      }
    }
    this.carts.updateOne({ _id: targetCart._id }, { items: merged });
    this.carts.updateOne({ _id: sourceCart._id }, { status: 'abandoned', items: [] });
    return { addedQuantity, itemCount: merged.reduce((s, i) => s + i.quantity, 0) };
  }
}

export default CartService;
