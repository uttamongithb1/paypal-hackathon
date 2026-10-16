/**
 * Agent tool registry — the closed set of actions the agent may take.
 * Contracts: contracts/agent_tools.json (schemas) · docs/ai_agent_spec.md §4.
 * There is deliberately NO tool that can create, approve, capture or refund a payment.
 */
import { ApiError } from '../lib/errors.mjs';
import { formatMoney } from '../lib/money.mjs';
import { policyFor } from '../domain/policies.mjs';
import * as components from './components.mjs';

export class ToolRegistry {
  constructor(deps) {
    this.deps = deps;
    this.tools = {
      search_products: {
        label: 'Searching the catalogue',
        mutating: false,
        run: async (args, ctx) => this.searchProducts(args, ctx)
      },
      get_product: {
        label: 'Reading the product details',
        mutating: false,
        run: async (args, ctx) => this.getProduct(args, ctx)
      },
      compare_products: {
        label: 'Building a comparison',
        mutating: false,
        run: async (args, ctx) => this.compareProducts(args, ctx)
      },
      check_availability: {
        label: 'Checking live stock',
        mutating: false,
        run: async (args, ctx) => this.checkAvailability(args, ctx)
      },
      view_cart: {
        label: 'Opening your cart',
        mutating: false,
        run: async (args, ctx) => this.viewCart(args, ctx)
      },
      get_quote_estimate: {
        label: 'Estimating the total',
        mutating: false,
        run: async (args, ctx) => this.quoteEstimate(args, ctx)
      },
      add_to_cart: {
        label: 'Updating your cart',
        mutating: true,
        run: async (args, ctx) => this.addToCart(args, ctx)
      },
      update_cart_item: {
        label: 'Updating the quantity',
        mutating: true,
        run: async (args, ctx) => this.updateCartItem(args, ctx)
      },
      remove_cart_item: {
        label: 'Removing an item',
        mutating: true,
        requiresConfirmation: true,
        run: async (args, ctx) => this.removeCartItem(args, ctx)
      },
      clear_cart: {
        label: 'Emptying your cart',
        mutating: true,
        requiresConfirmation: true,
        run: async (args, ctx) => this.clearCart(args, ctx)
      },
      prepare_checkout: {
        label: 'Preparing your order',
        mutating: true,
        run: async (args, ctx) => this.prepareCheckout(args, ctx)
      },
      answer_policy: {
        label: 'Checking store policy',
        mutating: false,
        run: async (args) => this.answerPolicy(args)
      },
      remember_preference: {
        label: 'Noting your preference',
        mutating: true,
        run: async (args, ctx) => this.rememberPreference(args, ctx)
      },
      // Internal/forced tool (contracts/agent_tools.json#set_requirement): never offered to the
      // model in open conversation, but it is the only way the structured requirement is written.
      set_requirement: {
        label: 'Updating your requirements',
        mutating: true,
        internal: true,
        run: async (args, ctx) => this.setRequirement(args, ctx)
      }
    };
  }

  list() {
    return Object.entries(this.tools).map(([name, tool]) => ({ name, label: tool.label, mutating: tool.mutating }));
  }

  async call(name, args, ctx) {
    const tool = this.tools[name];
    if (!tool) {
      // Unknown tool names never execute — in-band error the model can recover from.
      return { ok: false, error: { code: 'UNKNOWN_TOOL', message: `No tool named "${name}".`, retryable: false } };
    }
    try {
      const result = await tool.run(args, ctx);
      return { ok: true, ...result };
    } catch (err) {
      if (err instanceof ApiError) {
        this.deps.analytics.emit('agent_tool_error', { sessionId: ctx.session._id, userId: ctx.user?._id, props: { tool: name, errorCode: err.code, durationMs: 0 } });
        return { ok: false, error: { code: err.code, message: err.message, retryable: err.status >= 500, details: err.details } };
      }
      this.deps.logger.error('tool.failed', { tool: name, error: err.message, requestId: ctx.requestId });
      return { ok: false, error: { code: 'INTERNAL', message: 'That lookup failed on our side.', retryable: true } };
    }
  }

  // ── Read tools ───────────────────────────────────────────────────────────
  async searchProducts(args, ctx) {
    const { catalogue } = this.deps;
    const result = catalogue.searchForAgent({
      query: args.query,
      categorySlug: args.categorySlug ?? ctx.requirement?.categorySlug ?? undefined,
      budgetMaxMinor: args.budgetMaxMinor ?? ctx.requirement?.budgetMinor ?? undefined,
      filters: args.filters ?? ctx.requirement?.hardConstraints?.filter((c) => c.kind === 'attribute') ?? [],
      softPreferences: args.softPreferences ?? ctx.requirement?.softPreferences ?? [],
      limit: Math.min(5, args.limit ?? 5)
    });
    return { result, components: [components.productCards({ products: result.products, revision: ctx.requirement?.revision ?? 0, relaxed: result.relaxed, assumptions: ctx.requirement?.assumptions ?? [] })], candidateIds: result.products.map((p) => p.id) };
  }

  async getProduct(args, ctx) {
    const product = this.deps.catalogue.getProduct({ productId: args.productId, slug: args.slug });
    return { result: product };
  }

  async compareProducts(args, ctx) {
    const result = this.deps.catalogue.compare(args.productIds, { focusKeys: args.focusKeys });
    return { result, components: [components.comparison({ comparison: result, revision: ctx.requirement?.revision ?? 0 })] };
  }

  async checkAvailability(args, ctx) {
    const items = args.productIds.map((productId) => {
      const product = this.deps.catalogue.getRaw(productId);
      if (!product) return { productId, stock: 0, availability: 'out_of_stock', archived: true };
      const stock = this.deps.inventory.availableFor(productId);
      const previous = ctx.session.chat?.lastPrices?.[productId];
      return {
        productId,
        title: product.title,
        stock,
        availability: stock <= 0 ? 'out_of_stock' : stock <= 3 ? 'low_stock' : 'in_stock',
        currentPriceMinor: product.priceMinor,
        previousPriceMinor: previous ?? undefined,
        priceChanged: previous !== undefined && previous !== product.priceMinor,
        archived: product.status !== 'active'
      };
    });
    return { result: { items } };
  }

  async viewCart(args, ctx) {
    const cart = this.deps.cart.toDto(this.deps.cart.getOrCreate({ sessionId: ctx.session._id, userId: ctx.user?._id }));
    return { result: { cart }, components: [components.cartSummary({ cart })], cartUpdated: cart };
  }

  async quoteEstimate(args, ctx) {
    const cart = this.deps.cart.toDto(this.deps.cart.getOrCreate({ sessionId: ctx.session._id, userId: ctx.user?._id }));
    if (!cart.itemCount) throw new ApiError('CART_EMPTY', 'Your cart is empty, so there is nothing to estimate yet.');
    const cartDoc = this.deps.cart.getOrCreate({ sessionId: ctx.session._id, userId: ctx.user?._id });
    const fresh = this.deps.quote.recomputeForLines(
      cart.items.filter((i) => !i.unavailable).map((i) => ({ productId: i.productId, quantity: i.quantity })),
      { excludeCartId: cartDoc._id }
    );
    return {
      result: {
        subtotalMinor: fresh.subtotalMinor,
        shippingMinor: fresh.shippingMinor,
        taxMinor: fresh.taxMinor,
        totalMinor: fresh.totalMinor,
        currency: 'USD',
        taxRateBps: fresh.taxRateBps ?? this.deps.env.taxRateBps,
        accurate: false,
        shippingRuleApplied: fresh.shippingRuleApplied,
        display: { subtotal: formatMoney(fresh.subtotalMinor), shipping: formatMoney(fresh.shippingMinor), tax: formatMoney(fresh.taxMinor), total: formatMoney(fresh.totalMinor) },
        warnings: cart.warnings
      }
    };
  }

  // ── Write tools ──────────────────────────────────────────────────────────
  async addToCart(args, ctx) {
    const { cart } = this.deps.cart.addItem({ sessionId: ctx.session._id, userId: ctx.user?._id }, {
      productId: args.productId,
      quantity: args.quantity,
      addedVia: 'agent'
    });
    this.deps.analytics.emit('cart_item_added', {
      sessionId: ctx.session._id,
      userId: ctx.user?._id,
      productId: args.productId,
      props: { productId: args.productId, quantity: args.quantity, unitPriceMinor: cart.items.find((i) => i.productId === args.productId)?.unitPriceMinor ?? 0, surface: 'agent' }
    });
    const line = cart.items.find((i) => i.productId === args.productId);
    return { result: { cart: { itemCount: cart.itemCount, subtotalMinor: cart.subtotalMinor, currency: cart.currency, display: cart.display }, line }, components: [components.cartSummary({ cart })], cartUpdated: cart };
  }

  async updateCartItem(args, ctx) {
    const { cart } = this.deps.cart.setQuantity({ sessionId: ctx.session._id, userId: ctx.user?._id }, args.productId, args.quantity);
    this.deps.analytics.emit('cart_updated', { sessionId: ctx.session._id, productId: args.productId, props: { productId: args.productId, fromQuantity: 0, toQuantity: args.quantity, surface: 'agent' } });
    return { result: { cart: { itemCount: cart.itemCount, subtotalMinor: cart.subtotalMinor, display: cart.display } }, components: [components.cartSummary({ cart })], cartUpdated: cart };
  }

  async removeCartItem(args, ctx) {
    if (!ctx.confirmed) return { result: { needsConfirmation: true, productId: args.productId }, requiresConfirmation: true };
    const { cart } = this.deps.cart.removeItem({ sessionId: ctx.session._id, userId: ctx.user?._id }, args.productId);
    this.deps.analytics.emit('cart_item_removed', { sessionId: ctx.session._id, productId: args.productId, props: { productId: args.productId, quantity: 1, surface: 'agent' } });
    return { result: { removed: { productId: args.productId }, cart: { itemCount: cart.itemCount, subtotalMinor: cart.subtotalMinor, display: cart.display } }, components: [components.cartSummary({ cart })], cartUpdated: cart };
  }

  async clearCart(args, ctx) {
    if (!ctx.confirmed) return { result: { needsConfirmation: true }, requiresConfirmation: true };
    const { cart } = this.deps.cart.clear({ sessionId: ctx.session._id, userId: ctx.user?._id });
    return { result: { removedLines: 0, cart }, components: [components.cartSummary({ cart })], cartUpdated: cart };
  }

  /**
   * Creates a draft order + holds. NEVER creates a PayPal order — that only happens when the user
   * presses "Approve & Pay" on the checkout page (api_spec.md §5).
   */
  async prepareCheckout(args, ctx) {
    if (!args.confirm) return { result: { needsConfirmation: true } };
    const { quote } = this.deps.quote.create({ sessionId: ctx.session._id, userId: ctx.user?._id, extendHolds: true });
    const order = await this.deps.order.createFromQuote({
      quoteId: quote.id,
      quoteHash: quote.hash,
      contact: { email: args.contactEmail ?? ctx.user?.email },
      auth: { session: ctx.session, user: ctx.user }
    });
    this.deps.analytics.emit('quote_requested', { sessionId: ctx.session._id, orderId: order._id, props: { itemCount: order.lines.length, totalMinor: order.amounts.totalMinor } });
    const dto = this.deps.order.toDto(order);
    return { result: { orderId: dto.id, orderNumber: dto.orderNumber, amounts: dto.amounts, expiresAt: dto.expiresAt, requiresApproval: true, approvalUrl: `/checkout/${dto.id}`, quote }, components: [components.checkoutCard({ order: dto, quote })], cartUpdated: null };
  }

  async answerPolicy(args) {
    const policy = policyFor(args.topic);
    if (!policy) throw new ApiError('VALIDATION_ERROR', `No policy stored for "${args.topic}".`);
    return { result: { topic: args.topic, text: policy.text, updatedAt: policy.updatedAt, source: 'policies.ts' } };
  }

  /**
   * Writes the structured requirement. `attributes` blocks are an open bag whose usable keys come
   * from the category schema: unknown keys are dropped and reported back as assumptions.
   */
  async setRequirement(args, ctx) {
    const category = args.categorySlug ? this.deps.catalogue.category(args.categorySlug) : null;
    if (args.categorySlug && !category) {
      throw new ApiError('UNFILTERABLE_ATTRIBUTE', `There is no category called "${args.categorySlug}".`);
    }
    const allowed = new Set(Object.keys(category?.attributeSchema?.properties ?? {}));
    const dropped = [];
    const hardConstraints = [];
    for (const constraint of args.hardConstraints ?? []) {
      if (constraint.kind !== 'attribute') {
        hardConstraints.push(constraint);
        continue;
      }
      if (allowed.size && !allowed.has(constraint.key)) {
        dropped.push(constraint.key);
        continue;
      }
      hardConstraints.push(constraint);
    }
    const requirement = {
      revision: Math.max(1, Number(args.revision ?? 1)),
      categorySlug: args.categorySlug ?? null,
      budgetMinor: args.budgetMaxMinor ?? null,
      budgetIsUnspecified: Boolean(args.budgetIsUnspecified),
      useCase: args.useCase ?? null,
      quantity: Math.min(this.deps.env.maxLineQuantity ?? 10, Math.max(1, Number(args.quantity ?? 1))),
      hardConstraints,
      softPreferences: args.softPreferences ?? [],
      assumptions: args.assumptions ?? []
    };
    return {
      result: {
        stored: true,
        requirement,
        droppedAttributeKeys: dropped,
        assumptions: dropped.length ? [...(args.assumptions ?? []), `${dropped.join(', ')} is not a filterable attribute of ${args.categorySlug} — ignored.`] : args.assumptions ?? []
      },
      requirementPatch: requirement
    };
  }

  async rememberPreference(args, ctx) {
    const requirement = { ...(ctx.requirement ?? {}) };
    requirement.softPreferences = [...(requirement.softPreferences ?? []).filter((p) => p.key !== args.key), { key: args.key, direction: args.direction ?? 'higher_better', label: args.label ?? args.key, weight: 0.8 }];
    return { result: { stored: true, preference: { key: args.key, value: args.value } }, requirementPatch: requirement };
  }
}

export default ToolRegistry;
