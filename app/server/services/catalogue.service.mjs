/**
 * Catalogue service: search, typed filters, deterministic ranking, comparison and merchant writes.
 * Docs: ../docs/api_spec.md §3, ../docs/ai_agent_spec.md §4.1–4.3, ../docs/data_model.md §2.6
 */
import { ApiError } from '../lib/errors.mjs';
import { formatMoney } from '../lib/money.mjs';
import env from '../config/env.mjs';
import { hashPii } from '../lib/crypto.mjs';

const SORTS = ['relevance', 'price_asc', 'price_desc', 'rating', 'newest', 'stock_desc'];

/** Ranking weights — DEC-01: configuration, not constants in logic. */
export const RANKING_WEIGHTS = { constraintFit: 0.3, softPreference: 0.25, quality: 0.15, pricePenalty: 0.2, stockRisk: 0.1 };

export const availabilityOf = (stock) => (stock <= 0 ? 'out_of_stock' : stock <= 3 ? 'low_stock' : 'in_stock');

const tolerance = (budgetMinor, graceBps = env.budgetGraceBps) => Math.round((budgetMinor * graceBps) / 10000);

export class CatalogueService {
  constructor(store) {
    this.store = store;
  }

  get products() {
    return this.store.collection('products');
  }

  get categories() {
    return this.store.collection('categories');
  }

  get merchants() {
    return this.store.collection('merchants');
  }

  category(slugOrId) {
    if (!slugOrId) return null;
    return this.categories.findOne({ $or: [{ slug: slugOrId }, { _id: slugOrId }] });
  }

  merchant(id) {
    return this.merchants.findOne({ _id: id });
  }

  attributeSchema(categorySlug) {
    return this.category(categorySlug)?.attributeSchema ?? [];
  }

  /** Injected by the container so DTOs can expose available-to-sell, not just on-hand stock. */
  attachInventory(inventory) {
    this.inventory = inventory;
  }

  /** Available-to-sell: stock minus every other shopper's active hold (docs/data_model.md §2.12). */
  availableStock(product, options = {}) {
    if (!this.inventory) return product.stock;
    return this.inventory.availableFor(product._id, options);
  }

  /**
   * Product document → API shape (docs/api_spec.md §3).
   * `stock` is available-to-sell for shoppers; merchant-facing callers pass { stockMode: 'on_hand' }.
   */
  toDto(product, { stockMode = 'available', availabilityOptions } = {}) {
    const merchant = this.merchant(product.merchantId);
    const category = this.category(product.categoryId);
    const priceMinor = product.priceMinor;
    const available = stockMode === 'on_hand' ? product.stock : this.availableStock(product, availabilityOptions);
    return {
      id: product._id,
      productId: product._id,
      slug: product.slug,
      title: product.title,
      brand: product.brand,
      sku: product.sku,
      merchant: merchant ? { id: merchant._id, name: merchant.name, slug: merchant.slug, policies: merchant.policies } : null,
      merchantId: product.merchantId,
      category: category ? { id: category._id, slug: category.slug, name: category.name } : null,
      categorySlug: category?.slug,
      price: {
        amountMinor: priceMinor,
        currency: product.currency,
        display: formatMoney(priceMinor, product.currency),
        compareAtMinor: product.compareAtPriceMinor ?? undefined,
        compareAtDisplay: product.compareAtPriceMinor ? formatMoney(product.compareAtPriceMinor, product.currency) : undefined
      },
      priceMinor,
      stock: available,
      stockOnHand: product.stock,
      available: this.availableStock(product, availabilityOptions),
      availability: availabilityOf(available),
      attributes: product.attributes,
      specs: product.specs,
      pros: product.pros,
      cons: product.cons,
      badges: product.badges ?? [],
      images: product.images,
      description: product.description,
      shortDescription: product.shortDescription,
      warrantyMonths: product.warrantyMonths,
      returnDays: product.returnDays,
      rating: { avg: product.ratingAvg, count: product.ratingCount },
      ratingAvg: product.ratingAvg,
      ratingCount: product.ratingCount,
      soldCount: product.soldCount ?? 0,
      status: product.status,
      updatedAt: product.updatedAt
    };
  }

  /**
   * Public search. Typed filters arrive as { ramGb_gte: 16 } or via the `filters` array from the agent.
   * Unknown/unfilterable keys are rejected (docs/data_model.md §2.6 query translation contract).
   */
  search({ q, category, merchantId, minPriceMinor, maxPriceMinor, inStock, attributes = {}, sort = 'relevance', page = 1, limit = 20, includeOutOfStock = false } = {}) {
    // A shop should never open with a product nobody can buy. The default and rating sorts put
    // in-stock items first and rank by rating inside each group; price and recency sorts are left
    // alone, because there the ordering is the point.
    const availabilityRank = (p) => (this.availableStock(p) > 0 ? 0 : 1);
    const categoryDoc = category ? this.category(category) : null;
    if (category && !categoryDoc) throw new ApiError('INVALID_CATEGORY', `Unknown category "${category}".`);

    const filter = {};
    if (categoryDoc) filter.categoryId = categoryDoc._id;
    if (merchantId) filter.merchantId = merchantId;

    const schema = categoryDoc?.attributeSchema ?? null;
    for (const [rawKey, value] of Object.entries(attributes)) {
      const m = /^([A-Za-z0-9]+)_(gte|lte|eq|in)$/.exec(rawKey);
      const key = m ? m[1] : rawKey;
      const op = m ? { gte: '$gte', lte: '$lte', eq: '$eq', in: '$in' }[m[2]] : '$eq';
      if (key === 'priceMinor') {
        filter.priceMinor = { ...(filter.priceMinor ?? {}), [op]: value };
        continue;
      }
      if (key === 'inStock') {
        if (value === true || value === 'true') filter.stock = { $gt: 0 };
        continue;
      }
      if (schema && !schema.some((a) => a.key === key && a.filterable)) {
        throw new ApiError('UNFILTERABLE_ATTRIBUTE', `"${key}" is not a filterable attribute of ${categoryDoc?.slug ?? 'this category'}.`, {
          details: { attribute: key, filterable: schema?.filter((a) => a.filterable).map((a) => a.key) ?? [] }
        });
      }
      filter[`attributes.${key}`] = { [op]: value };
    }
    if (typeof minPriceMinor === 'number') filter.priceMinor = { ...(filter.priceMinor ?? {}), $gte: minPriceMinor };
    if (typeof maxPriceMinor === 'number') filter.priceMinor = { ...(filter.priceMinor ?? {}), $lte: maxPriceMinor };

    // Only active products are shoppable; out-of-stock items are hidden unless explicitly asked for.
    const base = { ...filter, status: 'active' };
    if (!includeOutOfStock) {
      const withStock = { ...base, stock: { ...(base.stock ?? {}), $gt: 0 } };
      const inStockCount = this.products.count(withStock);
      if (inStockCount > 0 || !inStock) filter.stock = { ...(filter.stock ?? {}), $gt: 0 };
    }

    let results = this.products.find({ ...filter, status: 'active' });
    if (q) {
      const needle = String(q).toLowerCase();
      const tokens = needle.split(/\s+/).filter(Boolean);
      results = results.filter((p) => {
        const haystack = `${p.title} ${p.brand} ${p.shortDescription} ${p.description} ${(p.specs ?? []).map((s) => `${s.label} ${s.value}`).join(' ')}`.toLowerCase();
        const attributeText = Object.values(p.attributes ?? {}).join(' ').toLowerCase();
        return tokens.every((t) => haystack.includes(t) || attributeText.includes(t));
      });
    }

    if (!SORTS.includes(sort)) throw new ApiError('INVALID_SORT', `Unknown sort "${sort}".`, { details: { allowed: SORTS } });
    const sortSpec = {
      relevance: q ? undefined : { ratingAvg: -1 },
      price_asc: { priceMinor: 1 },
      price_desc: { priceMinor: -1 },
      rating: { ratingAvg: -1 },
      newest: { createdAt: -1 },
      stock_desc: { stock: -1 }
    }[sort];
    if (q && sort === 'relevance') {
      const tokens = String(q).toLowerCase().split(/\s+/).filter(Boolean);
      const score = (p) => tokens.reduce((acc, t) => acc + (p.title.toLowerCase().includes(t) ? 3 : 0) + (p.brand.toLowerCase().includes(t) ? 2 : 0), 0);
      results = [...results].sort((a, b) => score(b) - score(a) || b.ratingAvg - a.ratingAvg);
    } else if (sortSpec) {
      results = [...results].sort((a, b) => {
        for (const [k, dir] of Object.entries(sortSpec)) {
          if (a[k] === b[k]) continue;
          return (a[k] > b[k] ? 1 : -1) * (dir < 0 ? -1 : 1);
        }
        return 0;
      });
    } else {
      results = [...results].sort((a, b) => availabilityRank(a) - availabilityRank(b) || b.ratingAvg - a.ratingAvg);
    }

    const total = results.length;
    const start = (Math.max(1, page) - 1) * limit;
    const items = results.slice(start, start + limit).map((p) => this.toDto(p));

    const brands = new Map();
    for (const p of results) brands.set(p.brand, (brands.get(p.brand) ?? 0) + 1);
    const prices = results.map((p) => p.priceMinor);

    return {
      items,
      page: Math.max(1, page),
      limit,
      total,
      hasMore: start + limit < total,
      facets: {
        brands: [...brands.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count),
        priceRange: prices.length ? { minMinor: Math.min(...prices), maxMinor: Math.max(...prices) } : null
      }
    };
  }

  getProduct({ productId, slug }) {
    const filter = productId ? { _id: productId } : { slug };
    const product = this.products.findOne(filter);
    if (!product) throw new ApiError('PRODUCT_NOT_FOUND', 'That product is not in the catalogue.');
    return this.toDto(product);
  }

  getRaw(productId) {
    return this.products.findOne({ _id: productId });
  }

  /** Soft-deleted products stay in the DB so order history survives (data_model.md §6). */
  archive(productId, merchantId) {
    const product = this.products.findOne({ _id: productId, merchantId });
    if (!product) throw new ApiError('PRODUCT_NOT_FOUND', 'That product is not in your catalogue.');
    return this.products.updateOne({ _id: productId }, { status: 'archived', archivedAt: new Date().toISOString() });
  }

  createProduct(input, merchantId) {
    const category = this.category(input.categorySlug ?? input.categoryId);
    if (!category) throw new ApiError('INVALID_CATEGORY', 'Unknown category.');
    this.validateAttributes(category, input.attributes ?? {});
    const slug = input.slug ?? String(input.title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (this.products.findOne({ slug })) throw new ApiError('VALIDATION_ERROR', `Slug "${slug}" already exists.`, { status: 409 });
    return this.products.insert({
      slug,
      title: input.title,
      brand: input.brand ?? this.merchant(merchantId)?.name ?? 'Unknown',
      sku: input.sku ?? `${slug}-sku`,
      merchantId,
      categoryId: category._id,
      priceMinor: input.priceMinor,
      compareAtPriceMinor: input.compareAtPriceMinor,
      currency: 'USD',
      stock: input.stock ?? 0,
      attributes: input.attributes ?? {},
      specs: input.specs ?? [],
      pros: input.pros ?? [],
      cons: input.cons ?? [],
      badges: input.badges ?? [],
      images: input.images ?? [],
      description: input.description ?? '',
      shortDescription: input.shortDescription ?? '',
      warrantyMonths: input.warrantyMonths ?? 12,
      returnDays: input.returnDays ?? 14,
      ratingAvg: input.ratingAvg ?? 0,
      ratingCount: input.ratingCount ?? 0,
      soldCount: 0,
      status: input.status ?? 'active'
    });
  }

  validateAttributes(category, attributes) {
    const allowed = new Set((category.attributeSchema ?? []).map((a) => a.key));
    for (const key of Object.keys(attributes)) {
      if (!allowed.has(key)) {
        throw new ApiError('INVALID_ATTRIBUTE', `"${key}" is not part of the ${category.name} attribute schema.`, {
          details: { attribute: key, allowed: [...allowed] }
        });
      }
    }
  }

  /** Merchant update: writes price history (data_model.md §2.7) and refuses unknown attributes. */
  updateProduct(productId, merchantId, patch, actorId) {
    const product = this.products.findOne({ _id: productId, merchantId });
    if (!product) throw new ApiError('PRODUCT_NOT_FOUND', 'That product is not in your catalogue.');
    if (patch.attributes) this.validateAttributes(this.category(product.categoryId), { ...product.attributes, ...patch.attributes });

    const changes = [];
    for (const field of ['priceMinor', 'stock', 'status']) {
      if (patch[field] !== undefined && patch[field] !== product[field]) {
        changes.push({ field, from: product[field], to: patch[field] });
      }
    }
    const update = { ...patch };
    delete update.attributesOnly;
    const updated = this.products.updateOne({ _id: productId }, update);
    if (changes.length) {
      this.store.collection('price_history').insert({ productId, merchantId, changedBy: actorId, changes, reason: 'merchant_edit' });
    }
    return this.toDto(updated, { stockMode: 'on_hand' });
  }

  priceHistory(productId, merchantId) {
    const product = this.products.findOne({ _id: productId, merchantId });
    if (!product) throw new ApiError('PRODUCT_NOT_FOUND', 'That product is not in your catalogue.');
    return this.store.collection('price_history').find({ productId }, { sort: { createdAt: -1 }, limit: 100 });
  }

  /**
   * Deterministic ranking over candidates that already satisfy hard constraints.
   * The model never re-orders these — it only explains them (DEC-02).
   */
  rank(candidates, { requirement = {}, limit = 5 } = {}) {
    const budgetMinor = requirement.budgetMinor ?? null;
    const softPrefs = requirement.softPreferences ?? [];
    const hardConstraints = requirement.hardConstraints ?? [];

    const rangeFor = (key) => {
      const values = candidates.map((p) => Number(p.attributes?.[key] ?? p[key])).filter((v) => Number.isFinite(v));
      return values.length ? { min: Math.min(...values), max: Math.max(...values) } : { min: 0, max: 0 };
    };

    const scored = candidates.map((product) => {
      const matched = [];
      const unmet = [];
      for (const constraint of hardConstraints) {
        const label = constraint.label ?? constraint.key;
        const actual = constraint.kind === 'attribute' ? product.attributes?.[constraint.key] : undefined;
        const ok = this.satisfies(product, constraint);
        if (ok) matched.push(label);
        else unmet.push(label);
      }
      if (budgetMinor) {
        if (product.priceMinor <= budgetMinor) matched.push(`price ≤ ${formatMoney(budgetMinor)}`);
      }

      const softScores = softPrefs.map((pref) => {
        const { min, max } = rangeFor(pref.key);
        const raw = Number(product.attributes?.[pref.key] ?? product[pref.key] ?? 0);
        if (max === min) return 0.5;
        const normalised = (raw - min) / (max - min);
        return pref.direction === 'lower_better' ? 1 - normalised : normalised;
      });
      const softPreferenceFit = softScores.length ? softScores.reduce((a, b) => a + b, 0) / softScores.length : 0.5;

      const quality = Math.min(1, (product.ratingAvg / 5) * 0.7 + (Math.min(product.warrantyMonths ?? 12, 36) / 36) * 0.3);
      const pricePenalty = budgetMinor ? Math.min(1, product.priceMinor / budgetMinor) : 0.5;
      const stockRisk = product.stock <= 0 ? 1 : product.stock <= 3 ? 0.5 : 0;

      const score =
        RANKING_WEIGHTS.constraintFit * (hardConstraints.length ? matched.length / hardConstraints.length : 1) +
        RANKING_WEIGHTS.softPreference * softPreferenceFit +
        RANKING_WEIGHTS.quality * quality -
        RANKING_WEIGHTS.pricePenalty * pricePenalty -
        RANKING_WEIGHTS.stockRisk * stockRisk;

      return {
        product,
        matched,
        unmet: [...unmet, ...softPrefs.filter((_, i) => softScores[i] < 0.4).map((p) => p.label ?? p.key)],
        score: Number(Math.max(0, Math.min(1, score)).toFixed(4)),
        why: this.explain(product, { requirement, matched, budgetMinor })
      };
    });

    return scored
      .sort((a, b) => b.score - a.score || a.product.priceMinor - b.product.priceMinor || b.product.ratingAvg - a.product.ratingAvg)
      .slice(0, limit);
  }

  satisfies(product, constraint) {
    if (constraint.kind === 'inStock') return product.stock > 0;
    if (constraint.kind === 'warrantyMonths') return (product.warrantyMonths ?? 0) >= constraint.value;
    if (constraint.kind === 'merchant') return product.merchantId === constraint.value;
    const actual = product.attributes?.[constraint.key];
    if (actual === undefined || actual === null) return false;
    switch (constraint.op) {
      case 'gte': return Number(actual) >= Number(constraint.value);
      case 'lte': return Number(actual) <= Number(constraint.value);
      case 'eq': return actual === constraint.value;
      case 'in': return Array.isArray(constraint.value) && constraint.value.includes(actual);
      default: return false;
    }
  }

  /** Deterministic, data-derived one-liner. The model may rephrase, never invent. */
  explain(product, { requirement = {}, matched = [], budgetMinor = null } = {}) {
    const bits = [];
    if (requirement.categorySlug) bits.push(`${product.attributes?.ramGb ? `${product.attributes.ramGb} GB RAM, ` : ''}${product.attributes?.storageGb ? `${product.attributes.storageGb} GB storage` : ''}`.trim());
    if (budgetMinor && product.priceMinor <= budgetMinor) bits.push(`sits ${formatMoney(budgetMinor - product.priceMinor)} under your budget`);
    if (product.attributes?.batteryWh) bits.push(`${product.attributes.batteryWh} Wh battery`);
    if (product.attributes?.weightG) bits.push(`${(product.attributes.weightG / 1000).toFixed(2)} kg`);
    if (product.attributes?.cameraMp) bits.push(`${product.attributes.cameraMp} MP camera`);
    if (product.attributes?.noiseCancelling) bits.push('active noise cancelling');
    const detail = bits.filter(Boolean).slice(0, 2).join(', ');
    const constraintText = matched.slice(0, 3).join(', ');
    const why = [constraintText && `meets ${constraintText}`, detail].filter(Boolean).join('; ');
    return why || `Rated ${product.ratingAvg}/5 by ${product.ratingCount} buyers.`;
  }

  /**
   * Agent-facing search: applies hard constraints, then relaxes in a documented order and reports
   * exactly what it relaxed. Docs: ../docs/ai_agent_spec.md §4.1, ../prd.md §10.1–10.3
   */
  searchForAgent({ query, categorySlug, budgetMaxMinor, filters = [], softPreferences = [], limit = 5, relaxBudgetBps = env.budgetGraceBps, includeSlightlyOverBudget = true } = {}) {
    const relaxed = [];
    const category = categorySlug ? this.category(categorySlug) : null;
    if (categorySlug && !category) throw new ApiError('INVALID_CATEGORY', `Unknown category "${categorySlug}".`);

    let pool = this.products.find({ status: 'active', ...(category ? { categoryId: category._id } : {}) });
    const initialCount = pool.length;

    if (query) {
      const tokens = String(query).toLowerCase().split(/\s+/).filter(Boolean);
      const filtered = pool.filter((p) => {
        const haystack = `${p.title} ${p.brand} ${p.shortDescription} ${(p.specs ?? []).map((s) => s.value).join(' ')}`.toLowerCase();
        return tokens.some((t) => haystack.includes(t));
      });
      if (filtered.length) pool = filtered;
      else relaxed.push(`keyword "${query}"`);
    }

    const applyFilters = (items, list) =>
      items.filter((p) =>
        list.every((f) => {
          if (f.key === 'priceMinor') {
            if (f.op === 'lte') return p.priceMinor <= f.value;
            if (f.op === 'gte') return p.priceMinor >= f.value;
            return true;
          }
          const actual = p.attributes?.[f.key];
          if (actual === undefined) return false;
          if (f.op === 'gte') return Number(actual) >= Number(f.value);
          if (f.op === 'lte') return Number(actual) <= Number(f.value);
          if (f.op === 'eq') return actual === f.value;
          if (f.op === 'in') return Array.isArray(f.value) && f.value.includes(actual);
          return true;
        })
      );

    const inStock = pool.filter((p) => p.stock > 0);
    if (inStock.length) pool = inStock;
    else relaxed.push('in-stock availability');

    pool = applyFilters(pool, filters);
    if (!pool.length && filters.length) {
      // Relax the least important hard constraint first (last one added), then report it.
      for (let i = filters.length - 1; i >= 0 && !pool.length; i -= 1) {
        const dropped = filters[i];
        const kept = filters.filter((_, idx) => idx !== i);
        const attempt = applyFilters(pool.length ? pool : inStock, kept);
        if (attempt.length) {
          pool = attempt;
          relaxed.push(`dropped: ${dropped.label ?? dropped.key} ${dropped.op} ${dropped.value}`);
        }
      }
    }

    if (budgetMaxMinor) {
      const within = pool.filter((p) => p.priceMinor <= budgetMaxMinor);
      if (within.length) {
        pool = within;
      } else {
        const grace = tolerance(budgetMaxMinor, relaxBudgetBps);
        const stretch = pool.filter((p) => p.priceMinor <= budgetMaxMinor + grace);
        if (stretch.length && includeSlightlyOverBudget) {
          pool = stretch;
          relaxed.push(`budget +${Math.round(relaxBudgetBps / 100)}%`);
        } else {
          const cheapest = [...pool].sort((a, b) => a.priceMinor - b.priceMinor)[0];
          pool = cheapest ? [cheapest] : [];
          if (cheapest) relaxed.push(`budget (cheapest option is ${formatMoney(cheapest.priceMinor)})`);
        }
      }
    }

    const ranked = this.rank(pool, {
      limit,
      requirement: { budgetMinor: budgetMaxMinor, softPreferences, hardConstraints: filters.map((f) => ({ ...f, label: f.label ?? `${f.key} ${f.op} ${f.value}` })) }
    });

    const explain = [
      `${initialCount} candidate products`,
      filters.length ? `${pool.length} after hard filters` : null,
      relaxed.length ? `relaxed: ${relaxed.join('; ')}` : 'no relaxations needed'
    ].filter(Boolean).join(' → ');

    return {
      count: ranked.length,
      relaxed,
      explain,
      products: ranked.map((r) => ({
        ...this.toDto(r.product, { stockMode: 'on_hand' }),
        matched: r.matched,
        unmet: r.unmet,
        score: r.score,
        whyItFits: r.why,
        slightlyOverBudget: budgetMaxMinor ? r.product.priceMinor > budgetMaxMinor : false
      }))
    };
  }

  /** Comparison over the union of comparable attributes, ordered by the category schema rank. */
  compare(productIds, { focusKeys } = {}) {
    if (!Array.isArray(productIds) || productIds.length < 2 || productIds.length > 4) {
      throw new ApiError('VALIDATION_ERROR', 'Compare needs between 2 and 4 products.');
    }
    const dtos = productIds.map((id) => this.getProduct({ productId: id }));
    const categories = new Set(dtos.map((p) => p.categorySlug));
    const caveats = [];
    if (categories.size > 1) {
      caveats.push('These products are from different categories, so only shared attributes are compared directly.');
    }
    const schema = this.attributeSchema(dtos[0].categorySlug) ?? [];
    const keys = focusKeys?.length ? focusKeys : schema.map((a) => a.key);
    const rows = [];

    rows.push({
      key: 'priceMinor',
      label: 'Price',
      values: dtos.map((p) => {
        const min = Math.min(...dtos.map((d) => d.priceMinor));
        return { productId: p.id, raw: p.priceMinor, display: p.price.display, better: p.priceMinor === min };
      })
    });

    for (const attribute of schema.filter((a) => keys.includes(a.key) && a.comparable)) {
      const values = dtos.map((p) => ({ productId: p.id, raw: p.attributes?.[attribute.key] ?? null }));
      if (values.every((v) => v.raw === null)) continue;
      const numeric = values.map((v) => Number(v.raw)).filter((v) => Number.isFinite(v));
      const best = attribute.higherIsBetter === false ? Math.min(...numeric) : Math.max(...numeric);
      rows.push({
        key: attribute.key,
        label: attribute.label,
        unit: attribute.unit,
        higherIsBetter: attribute.higherIsBetter !== false,
        values: values.map((v) => ({
          productId: v.productId,
          raw: v.raw,
          display: v.raw === null ? 'not specified' : `${v.raw}${attribute.unit && attribute.unit !== 'in' ? ` ${attribute.unit}` : attribute.unit ? '"' : ''}`,
          better: Number.isFinite(Number(v.raw)) && Number(v.raw) === best
        }))
      });
    }

    rows.push({
      key: 'warrantyMonths',
      label: 'Warranty',
      unit: 'months',
      higherIsBetter: true,
      values: dtos.map((p) => ({ productId: p.id, raw: p.warrantyMonths, display: `${p.warrantyMonths} months`, better: p.warrantyMonths === Math.max(...dtos.map((d) => d.warrantyMonths)) }))
    });
    rows.push({
      key: 'stock',
      label: 'Availability',
      values: dtos.map((p) => ({ productId: p.id, raw: p.stock, display: `${p.stock} in stock`, better: p.stock > 0 && p.stock === Math.max(...dtos.map((d) => d.stock)) }))
    });

    const wins = new Map();
    for (const row of rows) for (const v of row.values) if (v.better) wins.set(v.productId, (wins.get(v.productId) ?? 0) + 1);
    const winner = [...wins.entries()].sort((a, b) => b[1] - a[1])[0];
    const cheapest = dtos.reduce((a, b) => (a.priceMinor <= b.priceMinor ? a : b));
    const summary = winner
      ? `${dtos.find((p) => p.id === winner[0]).title} leads on ${winner[1]} of ${rows.length} comparable rows; ${cheapest.title} is the cheapest at ${cheapest.price.display}.`
      : 'No single product wins every row.';

    return { products: dtos, rows, summary, caveats, winnerProductId: winner?.[0] ?? null };
  }

  /** Merchant-owned listing (tenant scoped). */
  listForMerchant(merchantId, { status, q, page = 1, limit = 50 } = {}) {
    const filter = { merchantId };
    if (status) filter.status = status;
    let docs = this.products.find(filter, { sort: { updatedAt: -1 } });
    if (q) {
      const needle = String(q).toLowerCase();
      docs = docs.filter((p) => `${p.title} ${p.sku}`.toLowerCase().includes(needle));
    }
    const total = docs.length;
    const start = (Math.max(1, page) - 1) * limit;
    return { items: docs.slice(start, start + limit).map((p) => this.toDto(p, { stockMode: 'on_hand' })), total, page, limit, hasMore: start + limit < total };
  }

  lowStock(threshold = 3, merchantId = null) {
    const filter = { status: 'active', stock: { $lte: threshold } };
    if (merchantId) filter.merchantId = merchantId;
    return this.products.find(filter, { sort: { stock: 1 }, limit: 20 }).map((p) => this.toDto(p));
  }

  updateRating(productId, ratingAvg, ratingCount) {
    return this.products.updateOne({ _id: productId }, { ratingAvg, ratingCount });
  }

  /** Used by tests + analytics: a stable identity hash for seeded demo data. */
  hashOf(value) {
    return hashPii(value);
  }
}

export default CatalogueService;
