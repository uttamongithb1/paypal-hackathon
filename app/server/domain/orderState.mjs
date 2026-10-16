/**
 * Order + payment + hold state machines. Single source of truth for allowed transitions.
 * Docs: ../docs/data_model.md §3
 */
import { ApiError } from '../lib/errors.mjs';

export const ORDER_STATUS = {
  DRAFT: 'draft',
  AWAITING_PAYMENT: 'awaiting_payment',
  PAYMENT_PROCESSING: 'payment_processing',
  PAID: 'paid',
  PROCESSING: 'processing',
  SHIPPED: 'shipped',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
  PAYMENT_FAILED: 'payment_failed',
  EXPIRED: 'expired',
  REFUNDED: 'refunded'
};

export const ORDER_TRANSITIONS = {
  draft: ['awaiting_payment', 'cancelled'],
  awaiting_payment: ['payment_processing', 'cancelled', 'expired'],
  payment_processing: ['paid', 'payment_failed'],
  // NOTE: payment_failed must pass through payment_processing again — it can never jump to paid,
  // which guarantees verification always runs (invariant #4 in ../AGENTS.md §4).
  payment_failed: ['payment_processing', 'cancelled', 'expired'],
  paid: ['processing', 'refunded'],
  processing: ['shipped', 'refunded'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
  expired: [],
  refunded: []
};

export function canTransition(from, to) {
  return (ORDER_TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new ApiError('INVALID_STATE', `Cannot move an order from "${from}" to "${to}".`, {
      details: { from, to, allowed: ORDER_TRANSITIONS[from] ?? [] }
    });
  }
  return true;
}

/** Statuses in which the order can still be paid. */
export const PAYABLE_STATUSES = [ORDER_STATUS.AWAITING_PAYMENT, ORDER_STATUS.PAYMENT_FAILED, ORDER_STATUS.DRAFT];

/** Statuses a customer may cancel from. */
export const CANCELLABLE_STATUSES = [ORDER_STATUS.DRAFT, ORDER_STATUS.AWAITING_PAYMENT, ORDER_STATUS.PAYMENT_FAILED];

export const ATTEMPT_STATUS = {
  CREATED: 'created',
  AWAITING_APPROVAL: 'awaiting_approval',
  APPROVED: 'approved',
  CAPTURING: 'capturing',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  PENDING: 'pending',
  CANCELLED: 'cancelled',
  UNKNOWN: 'unknown'
};

export const PAYMENT_STATUS = {
  NONE: 'none',
  CREATED: 'created',
  APPROVED: 'approved',
  PENDING: 'pending',
  CAPTURED: 'captured',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  REFUNDED: 'refunded'
};

export const HOLD_STATUS = { ACTIVE: 'active', COMMITTED: 'committed', RELEASED: 'released' };

/** Deterministic PayPal idempotency key — same order + attempt always produces the same value. */
export const paypalRequestId = (orderId, attemptNo) => `pp-create-${orderId}-${attemptNo}`;
export const paypalCaptureRequestId = (orderId, attemptNo) => `pp-capture-${orderId}-${attemptNo}`;
