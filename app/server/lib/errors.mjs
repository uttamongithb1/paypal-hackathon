/**
 * Error catalogue + helpers. Codes and HTTP statuses are fixed by ../docs/api_spec.md §9.
 */
export const CODES = {
  VALIDATION_ERROR: 400,
  UNFILTERABLE_ATTRIBUTE: 400,
  INVALID_SORT: 400,
  INVALID_ATTRIBUTE: 400,
  INVALID_CATEGORY: 400,
  INVALID_CREDENTIALS: 401,
  TOKEN_EXPIRED: 401,
  TOKEN_REUSE: 401,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  PRODUCT_NOT_FOUND: 404,
  CART_ITEM_NOT_FOUND: 404,
  CATEGORY_NOT_FOUND: 404,
  ORDER_NOT_FOUND: 404,
  ACCOUNT_DISABLED: 423,
  EMAIL_TAKEN: 409,
  WEAK_PASSWORD: 400,
  CART_EMPTY: 409,
  CART_LINE_LIMIT: 409,
  INSUFFICIENT_STOCK: 409,
  ITEM_UNAVAILABLE: 409,
  PRODUCT_ARCHIVED: 409,
  QUOTE_STALE: 409,
  QUOTE_IN_PROGRESS: 409,
  HOLD_EXPIRED: 409,
  INVALID_STATE: 409,
  NEEDS_CONFIRMATION: 409,
  PAYMENT_IN_PROGRESS: 409,
  ORDER_ALREADY_CAPTURED: 409,
  DUPLICATE_CAPTURE: 409,
  PAYMENT_VERIFICATION_FAILED: 409,
  PAYMENT_ATTEMPT_LIMIT: 409,
  PAYPAL_ORDER_INVALID: 409,
  PAYER_ACTION_REQUIRED: 409,
  PAYMENT_DECLINED: 402,
  PAYMENT_INSUFFICIENT_FUNDS: 402,
  PAYMENT_PROVIDER_ERROR: 402,
  PAYMENT_PENDING: 202,
  RATE_LIMITED: 429,
  LLM_UNAVAILABLE: 503,
  PAYMENT_PROVIDER_UNAVAILABLE: 503,
  CATEGORY_MISMATCH: 400,
  INTERNAL: 500
};

export class ApiError extends Error {
  constructor(code, message, { details, status, expose = true } = {}) {
    super(message || code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status ?? CODES[code] ?? 500;
    this.details = details;
    this.expose = expose;
  }
  static notFound(what = 'Resource') {
    return new ApiError('NOT_FOUND', `${what} not found`);
  }
}

export const badRequest = (code, message, details) => new ApiError(code, message, { details });

/** Wraps an async route handler so rejections reach the error middleware. */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function errorBody(err, requestId) {
  const code = err instanceof ApiError ? err.code : 'INTERNAL';
  const message = err instanceof ApiError && err.expose ? err.message : 'Something went wrong on our side.';
  return { error: { code, message, requestId, ...(err?.details ? { details: err.details } : {}) } };
}
