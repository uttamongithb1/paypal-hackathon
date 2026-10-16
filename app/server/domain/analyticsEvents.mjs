/**
 * Analytics event catalogue with a strict per-event prop schema (no PII allowed).
 * Docs: ../docs/analytics_spec.md §1 and §4
 */
export const EVENT_NAMES = [
  'session_started',
  'chat_message_sent',
  'chat_clarification_asked',
  'requirement_updated',
  'recommendation_shown',
  'product_impression',
  'product_viewed',
  'comparison_shown',
  'cart_item_added',
  'cart_item_removed',
  'cart_updated',
  'quote_requested',
  'checkout_started',
  'payment_attempted',
  'payment_captured',
  'payment_failed',
  'payment_pending',
  'payment_cancelled',
  'order_expired',
  'order_cancelled',
  'order_confirmed_viewed',
  'agent_turn_completed',
  'agent_tool_error',
  'guardrail_triggered',
  'product_updated'
];

const SURFACES = ['agent', 'card', 'grid', 'product_page', 'cart', 'chat', 'landing', 'search', 'checkout'];
const CHAT_ENTRY = ['landing', 'chat', 'product'];
const CLARIFICATION_KINDS = ['budget', 'category', 'use_case', 'size'];
const FAILURE_REASONS = [
  'INSTRUMENT_DECLINED', 'INSUFFICIENT_FUNDS', 'PAYER_ACTION_REQUIRED', 'CANCELED', 'NETWORK', 'TIMEOUT',
  'VERIFY_MISMATCH', 'STOCK_COMMIT_FAILED', 'ATTEMPT_LIMIT', 'UNKNOWN'
];

/** Allow-list of props per event. Anything outside is dropped (never stored). */
export const EVENT_PROPS = {
  session_started: { role: ['guest', 'customer', 'merchant', 'admin'] },
  chat_message_sent: { turnIndex: 'number', textLength: 'number', entryPoint: CHAT_ENTRY },
  chat_clarification_asked: { questionKind: CLARIFICATION_KINDS, optionsCount: 'number' },
  requirement_updated: { revision: 'number' },
  recommendation_shown: { productCount: 'number', revision: 'number' },
  product_impression: { productId: 'string', surface: SURFACES, position: 'number' },
  product_viewed: { productId: 'string', surface: SURFACES },
  comparison_shown: { productCount: 'number' },
  cart_item_added: { productId: 'string', quantity: 'number', unitPriceMinor: 'number', surface: SURFACES },
  cart_item_removed: { productId: 'string', quantity: 'number', surface: SURFACES },
  cart_updated: { productId: 'string', fromQuantity: 'number', toQuantity: 'number', surface: SURFACES },
  quote_requested: { itemCount: 'number', totalMinor: 'number' },
  checkout_started: { orderId: 'string', orderNumber: 'string', itemCount: 'number', totalMinor: 'number', attemptNo: 'number', fromSurface: ['chat', 'cart', 'checkout'] },
  payment_attempted: { orderId: 'string', attemptNo: 'number', amountMinor: 'number' },
  payment_captured: { orderId: 'string', amountMinor: 'number', captureIdSuffix: 'string' },
  payment_failed: { orderId: 'string', attemptNo: 'number', reason: FAILURE_REASONS },
  payment_pending: { orderId: 'string', attemptNo: 'number' },
  payment_cancelled: { orderId: 'string', attemptNo: 'number' },
  order_expired: { orderId: 'string', itemCount: 'number' },
  order_cancelled: { orderId: 'string', previousStatus: 'string' },
  order_confirmed_viewed: { orderId: 'string', status: 'string' },
  agent_turn_completed: { toolCalls: 'number', iterations: 'number', durationMs: 'number', stopped: 'boolean', profile: ['deterministic', 'live'] },
  agent_tool_error: { tool: 'string', errorCode: 'string', durationMs: 'number' },
  guardrail_triggered: { kind: ['off_topic', 'pii_detected', 'injection_suspected', 'budget_refusal'] },
  product_updated: { productId: 'string', changedFields: 'number', priceFromMinor: 'number', priceToMinor: 'number' }
};

const NO_PII_KEYS = ['email', 'name', 'address', 'phone', 'password', 'payerEmail', 'card', 'token'];

/** Returns { ok, props } — invalid props are dropped, never thrown. */
export function validateEvent(event) {
  if (!event || !EVENT_NAMES.includes(event.name)) return { ok: false, reason: 'unknown_name' };
  const spec = EVENT_PROPS[event.name] ?? {};
  const clean = {};
  for (const [key, value] of Object.entries(event.props ?? {})) {
    if (NO_PII_KEYS.some((p) => key.toLowerCase().includes(p.toLowerCase()))) return { ok: false, reason: 'pii_rejected' };
    const rule = spec[key];
    if (rule === undefined && !['productId', 'orderId', 'sessionId'].includes(key)) continue; // drop unknown props
    if (rule === 'number' && typeof value !== 'number') continue;
    if (rule === 'string' && typeof value !== 'string') continue;
    if (rule === 'boolean' && typeof value !== 'boolean') continue;
    if (Array.isArray(rule) && !rule.includes(value)) continue;
    clean[key] = value;
  }
  return { ok: true, props: clean };
}
