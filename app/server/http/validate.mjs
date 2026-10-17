/**
 * Request validation helpers (Zod at the route boundary — docs/api_spec.md §1).
 */
import { z } from 'zod';
import { ApiError } from '../lib/errors.mjs';

export function validate(schemas, req) {
  const out = {};
  for (const [where, schema] of Object.entries(schemas)) {
    const parsed = schema.safeParse(req[where] ?? {});
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', 'Some fields need attention.', {
        details: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
      });
    }
    out[where] = parsed.data;
  }
  return out;
}

export const money = z.number().int().min(0).max(100_000_000);
export const id = z.string().min(6).max(64);

export const schemas = {
  register: z.object({ email: z.string().email(), password: z.string().min(1), displayName: z.string().max(80).optional() }).strict(),
  login: z.object({ email: z.string().email(), password: z.string().min(1) }).strict(),
  refresh: z.object({ refreshToken: z.string().min(10).optional() }).strict(),
  productSearch: z.object({
    q: z.string().max(200).optional(),
    category: z.string().max(60).optional(),
    merchantId: id.optional(),
    minPriceMinor: z.coerce.number().int().min(0).optional(),
    maxPriceMinor: z.coerce.number().int().min(0).optional(),
    inStock: z.coerce.boolean().optional(),
    sort: z.enum(['relevance', 'price_asc', 'price_desc', 'rating', 'newest', 'stock_desc']).optional(),
    page: z.coerce.number().int().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional()
  }).passthrough(),
  addToCart: z.object({ productId: id, quantity: z.number().int().min(1).max(10), addedVia: z.enum(['agent', 'card', 'product_page', 'cart']).optional() }).strict(),
  setQuantity: z.object({ quantity: z.number().int().min(0).max(10) }).strict(),
  quote: z.object({ extendHolds: z.boolean().optional() }).strict(),
  createOrder: z.object({
    quoteId: id,
    quoteHash: z.string().min(8).max(128),
    contact: z.object({ email: z.string().email(), name: z.string().max(80).optional() }).strict()
  }).strict(),
  capture: z.object({ paypalOrderId: z.string().min(4).max(64).optional(), simulatedOutcome: z.enum(['approve', 'decline', 'insufficient_funds', 'pending', 'amount_mismatch', 'error']).optional() }).strict(),
  refundOrder: z.object({ reason: z.string().min(1).max(200).optional() }).strict(),
  chat: z.object({
    sessionId: z.string().min(4).max(80).optional(),
    message: z.string().min(1).max(4000),
    clientMessageId: z.string().max(80).optional(),
    attachedProductIds: z.array(id).max(10).optional()
  }).strict(),
  requirementPatch: z.object({ op: z.enum(['add', 'remove', 'set']), constraint: z.record(z.string(), z.unknown()) }).strict(),
  // Unknown keys are stripped rather than rejected: this is a fire-and-forget beacon and the
  // contract says it "never errors the caller" (docs/api_spec.md §8).
  analytics: z.object({
    events: z
      .array(
        z.object({
          eventId: z.string().max(80),
          name: z.string().min(1).max(60),
          ts: z.string().optional(),
          props: z.record(z.string(), z.unknown()).optional()
        })
      )
      .min(1)
      .max(20)
  }),
  productCreate: z.object({
    title: z.string().min(3).max(160),
    slug: z.string().max(120).optional(),
    brand: z.string().max(80).optional(),
    sku: z.string().max(60).optional(),
    categorySlug: z.string().min(2),
    priceMinor: money,
    compareAtPriceMinor: money.optional(),
    stock: z.number().int().min(0).max(100_000),
    attributes: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
    specs: z.array(z.object({ group: z.string(), key: z.string(), label: z.string(), value: z.string() })).optional(),
    pros: z.array(z.string()).optional(),
    cons: z.array(z.string()).optional(),
    images: z.array(z.object({ url: z.string(), alt: z.string() })).optional(),
    description: z.string().max(4000).optional(),
    shortDescription: z.string().max(300).optional(),
    warrantyMonths: z.number().int().min(0).max(120).optional(),
    returnDays: z.number().int().min(0).max(365).optional(),
    status: z.enum(['draft', 'active', 'archived']).optional()
  }).strict(),
  productUpdate: z.object({
    priceMinor: money.optional(),
    stock: z.number().int().min(0).max(100_000).optional(),
    status: z.enum(['draft', 'active', 'archived']).optional(),
    title: z.string().min(3).max(160).optional(),
    shortDescription: z.string().max(300).optional(),
    description: z.string().max(4000).optional(),
    attributes: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
    pros: z.array(z.string()).optional(),
    cons: z.array(z.string()).optional()
  }).strict(),
  merchantOrderAction: z.object({ action: z.enum(['mark_shipped', 'cancel']), tracking: z.object({ carrier: z.string().max(60), number: z.string().max(60) }).strict().optional() }).strict()
};
