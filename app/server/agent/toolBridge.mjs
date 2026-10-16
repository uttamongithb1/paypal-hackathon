/**
 * Tool bridge — turns the machine-readable tool contract (contracts/agent_tools.json) into
 * (a) OpenAI-style function schemas for a live model and (b) a validator for the arguments it
 * returns. Both sides derive from the SAME contract the deterministic planner obeys, so the two
 * planner profiles can never drift apart in what they are allowed to do.
 *
 * Docs: ../docs/ai_agent_spec.md §4 · ../contracts/agent_tools.json
 */
import fs from 'node:fs';
import path from 'node:path';
import env from '../config/env.mjs';

/** Loaded once — the contract is a build-time artifact, not a per-request file read. */
let contract = null;

export function loadToolContract() {
  if (contract) return contract;
  const file = path.join(env.appRoot, '..', 'contracts', 'agent_tools.json');
  contract = JSON.parse(fs.readFileSync(file, 'utf8'));
  return contract;
}

/**
 * Tools the model may see. `internal` tools (set_requirement) are driven by our own extraction
 * step and are deliberately not offered to the model. Forbidden capabilities are not merely
 * hidden here — they do not exist in the registry at all.
 */
export function modelFacingTools() {
  return loadToolContract().tools.filter((tool) => tool.group !== 'internal');
}

/** The registry is closed: this is the only set of names that can ever execute. */
export function executableToolNames() {
  return modelFacingTools().map((tool) => tool.name);
}

/**
 * Contract → OpenAI function-tool schema. `additionalProperties: false` is preserved because the
 * tool implementations index into their arguments and a stray key is a bug, not a hint.
 */
export function toOpenAiTools() {
  return modelFacingTools().map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: `${tool.description} ${tool.whenToUse ?? ''}`.trim().slice(0, 1024),
      parameters: tool.inputSchema
    }
  }));
}

/** One-line-per-tool summary for the system prompt (keeps the prompt small and stable). */
export function toolMenu() {
  return modelFacingTools()
    .map((tool) => `- ${tool.name}(${Object.keys(tool.inputSchema.properties ?? {}).join(', ')}): ${tool.whenToUse ?? tool.description}`)
    .join('\n');
}

// ── Validation ───────────────────────────────────────────────────────────────
/**
 * Validates against the JSON-Schema subset the contract actually uses: type, required, enum,
 * items, min/maxItems, min/maxLength, minimum/maximum, additionalProperties. Deliberately small
 * and dependency-free — a full JSON Schema engine would be more surface than the contract needs.
 * Returns { ok, value, errors } and never throws.
 */
export function validateArgs(schema, args) {
  const errors = [];
  const value = {};

  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, value: {}, errors: [{ path: '', message: 'Arguments must be an object.' }] };
  }

  const props = schema.properties ?? {};
  const allowed = new Set(Object.keys(props));

  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) {
      if (schema.additionalProperties === false) errors.push({ path: key, message: 'Unknown field.' });
      continue;
    }
    const rule = props[key];
    const raw = args[key];

    if (raw === null || raw === undefined) {
      if (rule.type !== 'null') errors.push({ path: key, message: 'Must not be null.' });
      continue;
    }
    if (!matchesType(raw, rule.type)) {
      errors.push({ path: key, message: `Expected ${rule.type}.` });
      continue;
    }
    if (rule.enum && !rule.enum.includes(raw)) {
      errors.push({ path: key, message: `Must be one of: ${rule.enum.join(', ')}.` });
      continue;
    }
    if (rule.type === 'string') {
      if (rule.maxLength && raw.length > rule.maxLength) errors.push({ path: key, message: `Max length ${rule.maxLength}.` });
      if (rule.minLength && raw.length < rule.minLength) errors.push({ path: key, message: `Min length ${rule.minLength}.` });
    }
    if (rule.type === 'number' || rule.type === 'integer') {
      if (rule.minimum !== undefined && raw < rule.minimum) errors.push({ path: key, message: `Must be ≥ ${rule.minimum}.` });
      if (rule.maximum !== undefined && raw > rule.maximum) errors.push({ path: key, message: `Must be ≤ ${rule.maximum}.` });
      if (rule.type === 'integer' && !Number.isInteger(raw)) errors.push({ path: key, message: 'Must be an integer.' });
    }
    if (rule.type === 'array') {
      if (rule.minItems !== undefined && raw.length < rule.minItems) errors.push({ path: key, message: `Needs at least ${rule.minItems}.` });
      if (rule.maxItems !== undefined && raw.length > rule.maxItems) errors.push({ path: key, message: `At most ${rule.maxItems}.` });
      if (rule.items) {
        for (const [i, item] of raw.entries()) {
          if (!matchesType(item, rule.items.type)) errors.push({ path: `${key}[${i}]`, message: `Expected ${rule.items.type}.` });
        }
      }
    }
    value[key] = raw;
  }

  for (const required of schema.required ?? []) {
    if (!(required in value)) errors.push({ path: required, message: 'Required.' });
  }

  return { ok: errors.length === 0, value, errors };
}

function matchesType(value, type) {
  if (!type) return true;
  if (Array.isArray(type)) return type.some((t) => matchesType(value, t));
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return typeof value === 'object' && !Array.isArray(value);
    case 'null': return value === null;
    default: return true;
  }
}

/**
 * Model output is untrusted: parse arguments defensively and reject anything the contract
 * disallows before it reaches a tool. A malformed call becomes an in-band error the model can
 * recover from, never an exception and never an execution.
 */
export function parseToolArguments(name, rawArguments) {
  const tool = modelFacingTools().find((entry) => entry.name === name);
  if (!tool) return { ok: false, error: { code: 'UNKNOWN_TOOL', message: `No tool named "${name}".`, retryable: false } };

  let parsed;
  try {
    parsed = typeof rawArguments === 'string' ? (rawArguments.trim() ? JSON.parse(rawArguments) : {}) : (rawArguments ?? {});
  } catch {
    return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'Arguments were not valid JSON.', retryable: true } };
  }

  const { ok, value, errors } = validateArgs(tool.inputSchema, parsed);
  if (!ok) {
    return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'Those arguments are not valid for this tool.', retryable: true, details: { errors } } };
  }
  return { ok: true, args: value };
}

// ── Result compaction ────────────────────────────────────────────────────────
/**
 * What the model is allowed to see of a tool result. Full DTOs are large (descriptions, images,
 * policies) and every extra field is another thing a model can misquote, so each tool contributes
 * a deliberately small, price-complete shape. Prices are kept in BOTH forms — `display` for the
 * prose and minor units for arithmetic — because the grounding check matches against this payload.
 */
export function compactToolResult(name, result) {
  if (!result) return { ok: false };
  if (result.error) return { ok: false, error: result.error };

  const product = (p) => ({
    id: p.id ?? p.productId,
    title: p.title,
    brand: p.brand ?? null,
    merchant: p.merchant?.name ?? null,
    price: p.display?.price ?? (typeof p.priceMinor === 'number' ? `$${(p.priceMinor / 100).toFixed(2)}` : null),
    priceMinor: p.priceMinor ?? p.price?.amountMinor ?? null,
    stock: p.stock ?? p.available ?? null,
    rating: p.ratingAvg ?? p.rating ?? null,
    specs: p.specs ?? p.attributes ?? null,
    pros: p.pros ?? null,
    cons: p.cons ?? null
  });

  switch (name) {
    case 'search_products':
      return {
        ok: true,
        count: result.products?.length ?? 0,
        relaxed: result.relaxed ?? [],
        explain: result.explain ?? null,
        products: (result.products ?? []).slice(0, 10).map(product)
      };
    case 'get_product':
      return { ok: true, product: product(result) };
    case 'compare_products':
      return {
        ok: true,
        products: (result.products ?? []).slice(0, 4).map(product),
        winners: result.winners ?? null,
        verdict: result.verdict ?? result.summary ?? null
      };
    case 'check_availability':
      return { ok: true, items: (result.items ?? []).slice(0, 10).map((i) => ({ productId: i.productId, stock: i.stock, availability: i.availability, price: i.display?.price ?? i.price ?? null })) };
    case 'view_cart':
      return {
        ok: true,
        itemCount: result.itemCount ?? result.items?.length ?? 0,
        lines: (result.items ?? []).slice(0, 20).map((l) => ({ productId: l.productId, title: l.title, quantity: l.quantity, unit: l.display?.unitPrice ?? l.unitPrice ?? null, lineTotal: l.display?.lineTotal ?? l.lineTotal ?? null })),
        totals: result.display ?? { subtotal: result.display?.subtotal ?? null, total: result.display?.total ?? null },
        warnings: (result.warnings ?? []).map((w) => w.code ?? w.message)
      };
    case 'get_quote_estimate':
      return { ok: true, amounts: result.display ?? result.amounts ?? result, expiresAt: result.expiresAt ?? null };
    case 'prepare_checkout':
      return { ok: true, orderNumber: result.order?.orderNumber ?? result.orderNumber ?? null, status: result.order?.status ?? result.status ?? null, total: result.order?.amounts?.display?.total ?? result.amounts?.display?.total ?? null, paymentRequired: true, note: 'Approval must be given by the shopper on the checkout page.' };
    case 'answer_policy':
      return { ok: true, topic: result.topic ?? null, text: String(result.text ?? result.answer ?? '').slice(0, 900) };
    case 'add_to_cart':
    case 'update_cart_item':
    case 'remove_cart_item':
    case 'clear_cart':
      return { ok: true, cart: { itemCount: result.cart?.itemCount ?? result.itemCount ?? null, total: result.cart?.display?.total ?? result.display?.total ?? null } };
    default:
      return { ok: true, data: JSON.parse(JSON.stringify(result).slice(0, 1500)) };
  }
}
