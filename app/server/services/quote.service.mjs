/**
 * Quote service: the authoritative server-side price breakdown (subtotal, shipping, tax, total),
 * with a content hash so a stale approval can never be paid.
 * Docs: ../prd.md §5.4.1, ../docs/data_model.md §2.9, ../docs/api_spec.md §5
 */
import { ApiError } from '../lib/errors.mjs';
import { formatMoney, shippingFor, taxFor } from '../lib/money.mjs';
import { stableHash } from '../lib/crypto.mjs';
import env from '../config/env.mjs';

/** One hash function for both quote creation and recomputation, so they can never disagree. */
export function quoteHash({ lines, subtotalMinor, shippingMinor, taxMinor, totalMinor, taxRateBps }) {
  return stableHash({
    lines: lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor })),
    subtotalMinor,
    shippingMinor,
    taxMinor,
    totalMinor,
    taxRateBps
  });
}

export class QuoteService {
  constructor(store, { catalogue, inventory, cart }) {
    this.store = store;
    this.catalogue = catalogue;
    this.inventory = inventory;
    this.cart = cart;
  }

  get quotes() {
    return this.store.collection('quotes');
  }

  /** Build a quote from the cart's live state. Rejects when nothing can be purchased. */
  create({ sessionId, userId, extendHolds = true }) {
    const cartDoc = this.cart.getOrCreate({ sessionId, userId });
    const cart = this.cart.toDto(cartDoc);
    const purchasable = cart.items.filter((i) => !i.unavailable);
    if (!purchasable.length) throw new ApiError('CART_EMPTY', 'Your cart is empty — add something to continue.');

    const lines = purchasable.map((item) => {
      const row = {
        productId: item.productId,
        merchantId: item.merchant?.id ?? this.catalogue.getRaw(item.productId)?.merchantId,
        title: item.title,
        quantity: item.quantity,
        unitPriceMinor: item.unitPriceMinor,
        lineTotalMinor: item.lineTotalMinor,
        availableStock: item.availableStock
      };
      const product = this.catalogue.getRaw(item.productId);
      if (product?.attributes?.oversized) row.oversized = true;
      return row;
    });

    const subtotalMinor = lines.reduce((sum, l) => sum + l.lineTotalMinor, 0);
    const hasOversized = lines.some((l) => l.oversized);
    const { feeMinor: shippingMinor, rule } = shippingFor(subtotalMinor, { hasOversized, env });
    const taxMinor = taxFor(subtotalMinor, env.taxRateBps);
    const totalMinor = subtotalMinor + shippingMinor + taxMinor;

    const warnings = cart.warnings.filter((w) => w.code !== 'LOW_STOCK' || true);
    if (cart.freeShippingRemainingMinor > 0 && shippingMinor > 0) {
      // Additive to the warning codes in docs/api_spec.md §5 (documented in app/README.md §"Deviations").
      warnings.push({
        code: 'SHIPPING_HINT',
        message: `Add ${formatMoney(cart.freeShippingRemainingMinor)} more to get free shipping.`
      });
    }

    const hash = quoteHash({ lines, subtotalMinor, shippingMinor, taxMinor, totalMinor, taxRateBps: env.taxRateBps });

    const quote = this.quotes.insert({
      cartId: cartDoc._id,
      sessionId,
      userId: userId ?? undefined,
      lines,
      subtotalMinor,
      shippingMinor,
      taxMinor,
      totalMinor,
      currency: 'USD',
      taxRateBps: env.taxRateBps,
      shippingRuleApplied: rule,
      warnings,
      hash,
      status: 'open',
      expiresAt: new Date(Date.now() + env.quoteTtlMinutes * 60_000).toISOString()
    });

    if (extendHolds) {
      this.inventory.createOrExtendHolds({ cartId: cartDoc._id, sessionId, lines });
    }

    return {
      quote: this.toDto(quote),
      holds: this.inventory.holds.find({ cartId: cartDoc._id, status: 'active' }).map((h) => ({ productId: h.productId, quantity: h.quantity, expiresAt: h.expiresAt }))
    };
  }

  toDto(quote) {
    return {
      id: quote._id,
      expiresAt: quote.expiresAt,
      currency: quote.currency,
      lines: quote.lines,
      amounts: {
        subtotalMinor: quote.subtotalMinor,
        shippingMinor: quote.shippingMinor,
        taxMinor: quote.taxMinor,
        totalMinor: quote.totalMinor,
        currency: quote.currency,
        taxRateBps: quote.taxRateBps,
        display: {
          subtotal: formatMoney(quote.subtotalMinor),
          shipping: formatMoney(quote.shippingMinor),
          tax: formatMoney(quote.taxMinor),
          total: formatMoney(quote.totalMinor)
        }
      },
      shippingRuleApplied: quote.shippingRuleApplied,
      warnings: quote.warnings ?? [],
      hash: quote.hash,
      status: quote.status
    };
  }

  byId(quoteId) {
    return this.quotes.findOne({ _id: quoteId });
  }

  /** Recompute fresh amounts for an order's lines — used before create, retry and capture. */
  /**
   * @param {Array<{productId:string, quantity:number}>} lines
   * @param {{ excludeCartId?: string, excludeOrderId?: string }} [options]
   *   Pass the cart/order that owns the holds: a quote must never look unavailable because of its
   *   own reservation (that is exactly the ITEM_UNAVAILABLE bug the checkout flow would hit).
   */
  recomputeForLines(lines, options = {}) {
    const rows = lines.map((line) => {
      const product = this.catalogue.getRaw(line.productId);
      if (!product || product.status !== 'active') return { ...line, unavailable: true };
      const available = this.inventory.availableFor(product._id, options);
      return {
        productId: line.productId,
        merchantId: product.merchantId,
        title: product.title,
        quantity: line.quantity,
        unitPriceMinor: product.priceMinor,
        lineTotalMinor: product.priceMinor * line.quantity,
        availableStock: available,
        unavailable: available < line.quantity,
        oversized: Boolean(product.attributes?.oversized)
      };
    });
    const available = rows.filter((r) => !r.unavailable);
    const subtotalMinor = available.reduce((sum, l) => sum + l.lineTotalMinor, 0);
    const { feeMinor: shippingMinor, rule } = shippingFor(subtotalMinor, { hasOversized: available.some((l) => l.oversized), env });
    const taxMinor = taxFor(subtotalMinor, env.taxRateBps);
    const totalMinor = subtotalMinor + shippingMinor + taxMinor;
    return {
      lines: available,
      unavailableLines: rows.filter((r) => r.unavailable),
      subtotalMinor,
      shippingMinor,
      taxMinor,
      totalMinor,
      taxRateBps: env.taxRateBps,
      shippingRuleApplied: rule,
      hash: quoteHash({ lines: available, subtotalMinor, shippingMinor, taxMinor, totalMinor, taxRateBps: env.taxRateBps })
    };
  }

  /** Diff between the approved quote and the live recomputation (drives 409 QUOTE_STALE). */
  diff(quote, fresh) {
    const changes = [];
    const byId = new Map(fresh.lines.map((l) => [l.productId, l]));
    for (const line of quote.lines) {
      const current = byId.get(line.productId);
      if (!current) {
        changes.push({ productId: line.productId, field: 'availability', from: line.unitPriceMinor, to: null, message: `${line.title} is no longer available.` });
        continue;
      }
      if (current.unitPriceMinor !== line.unitPriceMinor) {
        changes.push({
          productId: line.productId,
          field: 'priceMinor',
          fromMinor: line.unitPriceMinor,
          toMinor: current.unitPriceMinor,
          message: `${line.title} changed from ${formatMoney(line.unitPriceMinor)} to ${formatMoney(current.unitPriceMinor)}.`
        });
      }
    }
    if (quote.totalMinor !== fresh.totalMinor) {
      changes.push({ field: 'totalMinor', fromMinor: quote.totalMinor, toMinor: fresh.totalMinor, message: `Your total changed from ${formatMoney(quote.totalMinor)} to ${formatMoney(fresh.totalMinor)}.` });
    }
    return changes;
  }
}

export default QuoteService;
