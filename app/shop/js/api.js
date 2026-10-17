/**
 * Thin API client: cookie session + CSRF header + JSON error normalisation + SSE chat stream.
 * No framework, no build step — plain ES modules so the storefront runs anywhere the API runs.
 */

const STATE = {
  user: null,
  session: null,
  cart: null,
  chat: { requirement: null, requirementChips: [], lastCandidateProductIds: [], messageCount: 0 },
  recentCandidates: [],
  lastPrices: {},
  env: null,
  categories: []
};

export const state = STATE;

const listeners = new Map();
export const on = (event, handler) => {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => listeners.get(event)?.delete(handler);
};
export const emit = (event, payload) => {
  for (const handler of listeners.get(event) ?? []) handler(payload);
};

export class ApiError extends Error {
  constructor({ code, message, status, details, requestId }) {
    super(message || 'Request failed');
    this.code = code || 'ERROR';
    this.status = status;
    this.details = details;
    this.requestId = requestId;
  }
  get hint() {
    return this.requestId ? `${this.code} · ref ${this.requestId}` : this.code;
  }
}

const readCsrf = () => {
  const match = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
};

export async function api(path, { method = 'GET', body, headers = {}, idempotencyKey, raw = false } = {}) {
  const csrf = readCsrf();
  let response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(csrf ? { 'x-sp-csrf': csrf } : {}),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (networkError) {
    throw new ApiError({ code: 'NETWORK', message: 'The server is unreachable. Is `npm run dev` running?', status: 0 });
  }
  if (raw) return response;
  if (response.status === 204) return { replay: response.headers.get('Idempotent-Replay') === 'true' };
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ApiError({ code: error.code, message: error.message, status: response.status, details: error.details, requestId: error.requestId });
  }
  return { ...payload, _replay: response.headers.get('Idempotent-Replay') === 'true', _status: response.status };
}

export const uuid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `k-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);

/* ── Session ─────────────────────────────────────────────────────────────── */
export async function loadSession({ createIfMissing = true } = {}) {
  let me = await api('/session/me');
  if (!me.user && createIfMissing) {
    await api('/session/guest', { method: 'POST' });
    me = await api('/session/me');
  }
  applySession(me);
  return me;
}

export function applySession(me) {
  STATE.user = me.user ?? null;
  STATE.session = me.session ?? null;
  STATE.cart = me.cart ?? STATE.cart;
  STATE.chat = me.chat ?? { requirement: null, requirementChips: [], lastCandidateProductIds: [], messageCount: 0 };
  STATE.recentCandidates = STATE.chat.lastCandidateProductIds ?? STATE.recentCandidates;
  emit('session', STATE);
}

export const signIn = async (email, password) => {
  const result = await api('/auth/login', { method: 'POST', body: { email, password } });
  await loadSession({ createIfMissing: false });
  emit('auth', result);
  return result;
};

export const register = async (payload) => {
  const result = await api('/auth/register', { method: 'POST', body: payload });
  await loadSession({ createIfMissing: false });
  emit('auth', result);
  return result;
};

export const signOut = async () => {
  await api('/auth/logout', { method: 'POST' });
  document.cookie = 'csrf=; path=/; max-age=0';
  await loadSession();
  emit('auth', null);
};

/* ── Catalogue ───────────────────────────────────────────────────────────── */
export const fetchCategories = async () => {
  const { items } = await api('/categories');
  STATE.categories = items;
  return items;
};

export const fetchProducts = (params = {}) => {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== null));
  return api(`/products?${query.toString()}`);
};

export const fetchProduct = (slugOrId) => api(`/products/${encodeURIComponent(slugOrId)}`);
export const fetchPriceHistory = (productId) => api(`/products/${productId}/history`);

/* ── Cart ────────────────────────────────────────────────────────────────── */
export async function fetchCart() {
  const { cart } = await api('/cart');
  STATE.cart = cart;
  emit('cart', cart);
  return cart;
}
export async function addToCart(productId, quantity = 1) {
  // Explicit idempotency key: a double-submit can never add the same line twice.
  const { cart } = await api('/cart/items', {
    method: 'POST',
    body: { productId, quantity, addedVia: 'card' },
    idempotencyKey: `cart-${productId}-${quantity}-${uuid()}`
  });
  STATE.cart = cart;
  emit('cart', cart);
  return cart;
}
export async function setCartQuantity(productId, quantity) {
  const { cart } = await api(`/cart/items/${productId}`, { method: 'PATCH', body: { quantity } });
  STATE.cart = cart;
  emit('cart', cart);
  return cart;
}
export async function removeCartItem(productId) {
  const { cart } = await api(`/cart/items/${productId}`, { method: 'DELETE' });
  STATE.cart = cart;
  emit('cart', cart);
  return cart;
}
export async function clearCart() {
  const { cart } = await api('/cart', { method: 'DELETE' });
  STATE.cart = cart;
  emit('cart', cart);
  return cart;
}

/* ── Checkout + payments ─────────────────────────────────────────────────── */
/**
 * Server quote: frozen prices, tax/shipping and stock holds. The endpoint answers
 * `{ quote, holds }`; callers only ever want the quote, so unwrap it here rather than making every
 * call site remember the envelope (a missing unwrap silently sent an order with no quoteId).
 */
export const createQuote = async (extendHolds = true) => {
  const response = await api('/checkout/quote', {
    method: 'POST',
    body: { extendHolds },
    idempotencyKey: `quote-${uuid()}`
  });
  return response.quote ?? response;
};

export const createOrder = ({ quoteId, quoteHash, contact, savedQuoteId }) =>
  api('/orders', {
    method: 'POST',
    body: { quoteId, quoteHash, contact: contact ?? null, savedQuoteId },
    idempotencyKey: `order-${quoteId}`
  });

export const fetchOrders = (params = {}) => {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''));
  return api(`/orders?${query.toString()}`);
};
export const fetchOrder = (orderId) => api(`/orders/${orderId}`);
export const cancelOrder = (orderId, reason = 'customer_cancelled') =>
  api(`/orders/${orderId}/cancel`, { method: 'POST', body: { reason } });

export const capturePayment = (orderId, { paypalOrderId, simulatedOutcome } = {}) =>
  api(`/payments/${orderId}/capture`, {
    method: 'POST',
    body: { paypalOrderId, simulatedOutcome },
    idempotencyKey: `capture-${orderId}-${paypalOrderId ?? 'sim'}`
  });
export const retryPayment = (orderId) => api(`/payments/${orderId}/retry`, { method: 'POST' });
export const paymentStatus = (orderId) => api(`/payments/${orderId}/status`);

export const simulateWebhook = (orderId, eventType = 'PAYMENT.CAPTURE.COMPLETED') =>
  api(`/dev/paypal/webhook/${orderId}`, { method: 'POST', body: { eventType } });

/* ── Analytics ───────────────────────────────────────────────────────────── */
export const track = (events) =>
  api('/analytics/events', { method: 'POST', body: { events } })
    .then(() => undefined)
    .catch(() => undefined); // analytics must never break the UX

/**
 * Client analytics beacon. Field names follow docs/api_spec.md §8 exactly — the ingest endpoint
 * validates them, and this used to send `id`/`at` instead of `eventId`/`ts`, so every beacon was
 * rejected and the merchant funnel lost all client-side signal.
 */
export const event = (name, props = {}, extra = {}) => ({
  eventId: `evt_${uuid()}`,
  name,
  ts: new Date().toISOString(),
  props: { surface: 'web', ...props },
  ...extra
});

/* ── Merchant ────────────────────────────────────────────────────────────── */
export const merchantOverview = () => api('/merchant/overview');
export const merchantProducts = (params = {}) => {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''));
  return api(`/merchant/products?${query.toString()}`);
};
export const merchantOrders = (params = {}) => {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''));
  return api(`/merchant/orders?${query.toString()}`);
};
export const merchantAnalytics = (range = '7d') => api(`/merchant/analytics?range=${range}`);
export const merchantAttempts = (orderId) => api(`/merchant/orders/${orderId}/attempts`);
export const merchantCreateProduct = (payload) => api('/merchant/products', { method: 'POST', body: payload });
export const merchantUpdateProduct = (id, patch) => api(`/merchant/products/${id}`, { method: 'PATCH', body: patch });
export const merchantOrderAction = (orderId, payload) => api(`/merchant/orders/${orderId}`, { method: 'PATCH', body: payload });
export const merchantRefundOrder = (orderId, payload = {}) => api(`/merchant/orders/${orderId}/refund`, { method: 'POST', body: payload });

/**
 * Chat over SSE: POST the message, then dispatch frames as they arrive.
 * Calls onFrame({event, data}) for each frame and resolves with the final message.end payload.
 */
export async function streamChat(message, { onFrame, clientMessageId, signal } = {}) {
  const response = await fetch('/api/v1/chat/stream', {
    method: 'POST',
    credentials: 'same-origin',
    signal,
    headers: { 'content-type': 'application/json', 'x-sp-csrf': readCsrf() ?? '' },
    body: JSON.stringify({ message, clientMessageId: clientMessageId ?? `cm_${uuid()}` })
  });
  if (response.status === 429) {
    throw new ApiError({ code: 'RATE_LIMITED', message: 'You are sending messages too quickly — give it a second.', status: 429 });
  }
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({}));
    throw new ApiError({ code: payload?.error?.code, message: payload?.error?.message ?? 'The agent is unavailable.', status: response.status });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let end = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      const eventMatch = /^event:\s*(.+)$/m.exec(chunk);
      const dataMatch = /^data:\s*(.+)$/m.exec(chunk);
      if (!eventMatch || !dataMatch) continue;
      let data;
      try {
        data = JSON.parse(dataMatch[1]);
      } catch {
        continue;
      }
      const frame = { event: eventMatch[1].trim(), data };
      if (frame.event === 'message.end') end = frame.data;
      if (frame.event === 'error') throw new ApiError({ code: data.code, message: data.message, requestId: data.requestId });
      onFrame?.(frame);
    }
  }
  await loadSession({ createIfMissing: false }).catch(() => undefined);
  return end;
}

export const fetchChatHistory = (sessionId) => api(`/chat/sessions/${sessionId}/messages`);
export const patchRequirement = (sessionId, patch) =>
  api(`/chat/sessions/${sessionId}/requirement`, { method: 'PATCH', body: patch });

/* ── Formatting ──────────────────────────────────────────────────────────── */
export const money = (minor, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format((minor ?? 0) / 100);

export const relativeTime = (iso) => {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
};
