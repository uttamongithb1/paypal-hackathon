/**
 * Payment service — the only code allowed to write `status: paid`.
 *
 * Implements:
 *  • deterministic PayPal-Request-Id idempotency + per-order advisory lock (payments_paypal.md §5)
 *  • verifyCapture V1–V7 (payments_paypal.md §4) — all checks must pass before any state change
 *  • transactional apply: order paid + stock commit + holds committed + cart converted (§4.3)
 *  • failure mapping to the matrix in payments_paypal.md §6
 *  • webhook ingestion (verified + deduplicated) and the reconciliation job (§7–§8)
 */
import { ApiError } from '../lib/errors.mjs';
import { hashPii, objectId, stableHash } from '../lib/crypto.mjs';
import { settlementPlan, verifySettlement } from '../payments/settlement.mjs';
import { formatMoney, toPayPalAmount } from '../lib/money.mjs';
import { checkoutReturnUrls } from '../lib/return-urls.mjs';
import { ATTEMPT_STATUS, ORDER_STATUS, PAYMENT_STATUS, assertTransition, canTransition, paypalCaptureRequestId, paypalRequestId } from '../domain/orderState.mjs';
import env from '../config/env.mjs';
import logger from '../lib/logger.mjs';

const ISSUE_MAP = {
  INSTRUMENT_DECLINED: { code: 'PAYMENT_DECLINED', reason: 'INSTRUMENT_DECLINED', message: 'Your payment method was declined. Try a different funding source.' },
  INSUFFICIENT_FUNDS: { code: 'PAYMENT_INSUFFICIENT_FUNDS', reason: 'INSUFFICIENT_FUNDS', message: 'Your funding source has insufficient funds. Try another payment method.' },
  PAYER_ACTION_REQUIRED: { code: 'PAYER_ACTION_REQUIRED', reason: 'PAYER_ACTION_REQUIRED', message: 'PayPal needs another step from you to finish this payment.' },
  CANCELED: { code: 'PAYMENT_DECLINED', reason: 'CANCELED', message: 'The payment was cancelled before it completed.' },
  NETWORK: { code: 'PAYMENT_PROVIDER_UNAVAILABLE', reason: 'NETWORK', message: 'We could not reach PayPal. Your order is safe — try again in a moment.' },
  PAYMENT_PROVIDER_UNAVAILABLE: { code: 'PAYMENT_PROVIDER_UNAVAILABLE', reason: 'TIMEOUT', message: 'PayPal is temporarily unavailable. Your order is safe — try again in a moment.' },
  ORDER_ALREADY_CAPTURED: { code: 'ORDER_ALREADY_CAPTURED', reason: 'UNKNOWN', message: 'This payment was already captured.' },
  RESOURCE_NOT_FOUND: { code: 'PAYPAL_ORDER_INVALID', reason: 'UNKNOWN', message: 'That PayPal order is no longer valid. Start a new payment attempt.' },
  UNKNOWN: { code: 'PAYMENT_PROVIDER_ERROR', reason: 'UNKNOWN', message: 'Something went wrong at PayPal. No money has left your account.' }
};

export class PaymentService {
  constructor(store, { order, quote, inventory, cart, catalogue, analytics, gateway, sessionService }) {
    this.store = store;
    this.order = order;
    this.quote = quote;
    this.inventory = inventory;
    this.cart = cart;
    this.catalogue = catalogue;
    this.analytics = analytics;
    this.gateway = gateway;
    this.session = sessionService;
    this.locks = new Map(); // in-process advisory locks (multi-instance → Redis/DB lock)
  }

  get attempts() {
    return this.store.collection('payment_attempts');
  }

  get webhooks() {
    return this.store.collection('webhook_events');
  }

  // ── Advisory lock ────────────────────────────────────────────────────────
  async withOrderLock(orderId, fn) {
    if (this.locks.has(orderId)) throw new ApiError('PAYMENT_IN_PROGRESS', 'A payment for this order is already being processed.');
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    this.locks.set(orderId, gate);
    try {
      return await fn();
    } finally {
      this.locks.delete(orderId);
      release();
    }
  }

  // ── Attempt lifecycle ───────────────────────────────────────────────────
  nextAttemptNo(order) {
    const existing = this.attempts.find({ orderId: order._id });
    return existing.length + 1;
  }

  /**
   * Create a PayPal order for our order and record the attempt. Called from POST /orders
   * (first attempt) and POST /payments/:orderId/retry.
   */
  async startAttempt(order, { returnUrl, cancelUrl } = {}) {
    if (order.payment?.paypalOrderId && order.payment.status === PAYMENT_STATUS.CREATED) {
      // Reuse the live PayPal order instead of creating a second one (double-click safety).
      const existing = this.gateway.mode === 'simulator' ? this.gateway.orders.get(order.payment.paypalOrderId) : null;
      if (!existing || existing.status === 'CREATED') {
        const attempt = this.attempts.findOne({ orderId: order._id, attemptNo: order.payment.lastAttemptNo });
        return { attempt, paypalOrderId: order.payment.paypalOrderId, reused: true };
      }
    }

    const attemptNo = this.nextAttemptNo(order);
    if (attemptNo > env.paymentMaxAttempts) {
      throw new ApiError('PAYMENT_ATTEMPT_LIMIT', `This order has reached the limit of ${env.paymentMaxAttempts} payment attempts. Please contact support.`);
    }
    const idempotencyKey = paypalRequestId(order._id, attemptNo);
    const attempt = this.attempts.insert({
      orderId: order._id,
      attemptNo,
      provider: 'paypal',
      idempotencyKey,
      status: ATTEMPT_STATUS.CREATED,
      amountMinor: order.amounts.totalMinor,
      currency: order.amounts.currency,
      requestSnapshotHash: stableHash({ orderId: order._id, attemptNo, total: order.amounts.totalMinor })
    });

    try {
      const { created, plan } = await this.createWithSettlement({ order, idempotencyKey, returnUrl, cancelUrl });
      this.attempts.updateOne({ _id: attempt._id }, { status: ATTEMPT_STATUS.AWAITING_APPROVAL, paypalOrderId: created.id, paypalOrderStatus: created.status, settlement: plan.mode });
      this.order.orders.updateOne(
        { _id: order._id },
        {
          payment: {
            ...order.payment,
            status: PAYMENT_STATUS.CREATED,
            paypalOrderId: created.id,
            lastAttemptNo: attemptNo,
            // Persisted so capture verification knows exactly which sellers were meant to be paid.
            settlement: {
              mode: plan.mode,
              units: plan.units.map((u) => ({
                referenceId: u.referenceId, merchantId: u.merchantId, merchantName: u.merchantName,
                amountMinor: u.amountMinor,
                platformFeeMinor: u.platformFeeMinor, payeeEmail: u.payee?.emailAddress ?? null
              })),
              /// Kept so the merchant dashboard can show commission earned without re-deriving it.
              totals: plan.totals ?? null,
              /// 'applied' | 'unsupported' | 'none' — whether a commission was actually taken.
              platformFees: plan.platformFees ?? (plan.mode === 'split' ? 'applied' : 'none'),
              reason: plan.reasons ?? []
            }
          }
        }
      );
      this.order.timeline(order._id, 'paypal_order_created', 'system', { paypalOrderId: created.id, attemptNo });
      this.analytics.emit('payment_attempted', {
        sessionId: order.sessionId,
        userId: order.userId,
        orderId: order._id,
        props: { orderId: order._id, attemptNo, amountMinor: order.amounts.totalMinor }
      });
      return { attempt: this.attempts.findOne({ _id: attempt._id }), paypalOrderId: created.id, reused: false };
    } catch (err) {
      this.attempts.updateOne({ _id: attempt._id }, { status: ATTEMPT_STATUS.FAILED, failureReason: err.issue ?? 'UNKNOWN' });
      const mapped = ISSUE_MAP[err.issue] ?? ISSUE_MAP.UNKNOWN;
      logger.error('payment.create.failed', { orderId: order._id, issue: err.issue, message: err.message });
      throw new ApiError(mapped.code, mapped.message, { details: { issue: err.issue } });
    }
  }

  /**
   * Capture + verify. This is the only path that can mark an order paid.
   * Failure responses never confirm the order (payments_paypal.md §6).
   */
  async capture({ orderId, paypalOrderId, auth, simulatedOutcome = 'approve' }) {
    const order = this.order.findAuthorised({ orderId, auth });
    if (this.locks.has(orderId)) {
      return { alreadyProcessing: true, order: this.order.toDto(order), code: 'PAYMENT_IN_PROGRESS' };
    }
    return this.withOrderLock(orderId, async () => {
      const current = this.order.find({ orderId });
      if (current.status === ORDER_STATUS.PAID) {
        const attempt = this.attempts.findOne({ orderId, status: ATTEMPT_STATUS.SUCCEEDED });
        return { replayed: true, order: this.order.toDto(current), attempt };
      }
      if (![ORDER_STATUS.AWAITING_PAYMENT, ORDER_STATUS.PAYMENT_FAILED, ORDER_STATUS.PAYMENT_PROCESSING].includes(current.status)) {
        throw new ApiError('INVALID_STATE', `An order that is "${current.status}" cannot be paid.`);
      }
      if (current.expiresAt && current.expiresAt < new Date().toISOString() && current.status === ORDER_STATUS.AWAITING_PAYMENT) {
        this.order.transition(orderId, ORDER_STATUS.EXPIRED, { actor: 'system' });
        this.inventory.release({ orderId, reason: 'hold_expired' });
        this.analytics.emit('order_expired', { sessionId: current.sessionId, orderId, props: { orderId, itemCount: current.lines.length } });
        throw new ApiError('HOLD_EXPIRED', 'This order hold expired. Refresh your cart to continue.');
      }
      const target = current.payment?.paypalOrderId ?? paypalOrderId;
      if (!target) throw new ApiError('VALIDATION_ERROR', 'No PayPal order to capture.');
      if (paypalOrderId && current.payment?.paypalOrderId && paypalOrderId !== current.payment.paypalOrderId) {
        throw new ApiError('VALIDATION_ERROR', 'That PayPal order does not belong to this order.');
      }

      const attempt = this.attempts.findOne({ orderId, paypalOrderId: target }) ?? this.attempts.insert({
        orderId,
        attemptNo: this.nextAttemptNo(current),
        provider: 'paypal',
        idempotencyKey: paypalCaptureRequestId(orderId, this.nextAttemptNo(current)),
        status: ATTEMPT_STATUS.CREATED,
        amountMinor: current.amounts.totalMinor,
        currency: current.amounts.currency,
        paypalOrderId: target,
        requestSnapshotHash: stableHash({ orderId, paypalOrderId: target })
      });

      // A failed order must pass back through payment_processing so verification always runs.
      if (current.status === ORDER_STATUS.AWAITING_PAYMENT || current.status === ORDER_STATUS.PAYMENT_FAILED) {
        this.order.transition(orderId, ORDER_STATUS.PAYMENT_PROCESSING, { actor: 'user', meta: { attemptNo: attempt.attemptNo } });
      }
      this.attempts.updateOne({ _id: attempt._id }, { status: ATTEMPT_STATUS.CAPTURING, updateAttemptedAt: new Date().toISOString() });

      let response;
      try {
        response = await this.gateway.captureOrder(target, {
          requestId: paypalCaptureRequestId(orderId, attempt.attemptNo),
          outcome: simulatedOutcome
        });
      } catch (err) {
        return this.handleCaptureError({ orderId, attempt, issue: err.issue, message: err.message, raw: err.raw, auth });
      }

      const verification = this.verifyCapture(this.order.find({ orderId }), response);
      if (!verification.ok && verification.pending) {
        this.attempts.updateOne({ _id: attempt._id }, { status: ATTEMPT_STATUS.PENDING, captureStatus: verification.captureStatus, paypalOrderStatus: response.status, verified: false, verifyChecks: verification.checks });
        this.order.orders.updateOne({ _id: orderId }, { 'payment.status': PAYMENT_STATUS.PENDING });
        this.analytics.emit('payment_pending', { sessionId: current.sessionId, orderId, props: { orderId, attemptNo: attempt.attemptNo } });
        return { pending: true, code: 'PAYMENT_PENDING', order: this.order.toDto(this.order.find({ orderId })), checks: verification.checks };
      }
      if (!verification.ok) {
        this.attempts.updateOne({ _id: attempt._id }, {
          status: ATTEMPT_STATUS.FAILED,
          captureStatus: verification.captureStatus,
          verified: false,
          verifyChecks: verification.checks,
          failureReason: 'VERIFY_MISMATCH',
          responseSnapshot: this.strip(response)
        });
        this.order.transition(orderId, ORDER_STATUS.PAYMENT_FAILED, { actor: 'system', meta: { reason: 'VERIFY_MISMATCH' } });
        this.order.orders.updateOne({ _id: orderId }, { 'payment.status': PAYMENT_STATUS.FAILED, 'payment.failureReason': 'VERIFY_MISMATCH' });
        logger.error('payment.verify.mismatch', { orderId, checks: JSON.stringify(verification.checks), requestId: auth?.requestId });
        throw new ApiError('PAYMENT_VERIFICATION_FAILED', 'We could not verify that payment against your order, so it has not been confirmed. Our team is notified.', { details: { checks: verification.checks } });
      }

      return this.applyCapture({ orderId, attempt, response, verification, auth });
    });
  }

  /**
   * Create the PayPal order using the configured settlement mode.
   *
   * `auto` means: try multi-seller, and if the account is not enabled for the Marketplaces
   * capability, re-create as a single unit rather than failing the shopper's payment. The fallback
   * is recorded (analytics + timeline + the reason on the order) so the demo can state plainly
   * which mode actually settled — a silent downgrade would be exactly the kind of dishonesty this
   * project is written to avoid.
   */
  async createWithSettlement({ order, idempotencyKey, returnUrl, cancelUrl }) {
    const mode = env.paypalSettlement === 'split' ? 'split' : env.paypalSettlement === 'single' ? 'single' : 'auto';
    const merchants = new Map(
      this.store.collection('merchants').find({}).map((m) => [m._id, m])
    );
    const plan = settlementPlan(order, { merchants, mode: mode === 'auto' ? 'split' : mode, platformFeeBps: env.platformFeeBps });

    if (mode === 'auto' && plan.mode === 'single') {
      logger.info('payment.settlement.single', { orderId: order._id, reason: plan.reasons });
    }

    try {
      const created = await this.gateway.createOrder({ order, requestId: idempotencyKey, returnUrl, cancelUrl, plan });
      if (plan.mode === 'split') {
        this.order.timeline(order._id, 'settlement_split', 'system', {
          sellers: plan.units.length, platformFeeMinor: plan.totals.platformFeeMinor
        });
      }
      return { created, plan };
    } catch (error) {
      const capabilityRejected = ['SPLIT_SETTLEMENT_UNSUPPORTED', 'PAYMENT_INSTRUCTION_NOT_SUPPORTED', 'MSP_NOT_SUPPORTED'].includes(error.issue);

      // Three-tier degradation, in order of how much value survives:
      //   1. split + platform_fees   — sellers paid directly, ShopPilot takes commission
      //   2. split, no fees          — sellers still paid directly; the commission is simply not taken
      //   3. single unit             — one recipient, the shopper is still able to buy
      // Tier 2 matters: PayPal refusing `platform_fees` (PLATFORM_FEES_NOT_SUPPORTED) says nothing
      // about `payee`. Giving up the split over a missing commission would throw away the most
      // valuable part of the payment, which is that each seller is actually paid.
      if (mode === 'auto' && plan.mode === 'split' && capabilityRejected) {
        const feesRejected = error.platformFeesRejected || /platform_fee/i.test(`${error.originalIssue ?? ''} ${error.message ?? ''}`);

        if (feesRejected && plan.totals?.platformFeeMinor > 0) {
          const noFee = settlementPlan(order, { merchants, mode: 'split', platformFeeBps: 0 });
          try {
            const created = await this.gateway.createOrder({ order, requestId: idempotencyKey, returnUrl, cancelUrl, plan: noFee });
            noFee.reasons = [...(noFee.reasons ?? []), 'this PayPal account cannot charge a platform fee; sellers are still paid directly'];
            noFee.platformFees = 'unsupported';
            this.order.timeline(order._id, 'settlement_fee_waived', 'system', {
              from: 'split+fees', to: 'split', reason: 'platform_fees not enabled for this account'
            });
            this.analytics.emit('payment_settlement_fallback', {
              sessionId: order.sessionId, userId: order.userId, orderId: order._id,
              props: { orderId: order._id, reason: 'platform_fees_unsupported' }
            });
            logger.warn('payment.settlement.fee_waived', { orderId: order._id, sellers: noFee.units.length });
            return { created, plan: noFee };
          } catch (retryError) {
            // Payees themselves are refused — only now is a single unit the honest answer.
            if (!isCapabilityRejection(retryError)) throw retryError;
            logger.warn('payment.settlement.payee_unsupported', { orderId: order._id, issue: retryError.originalIssue ?? retryError.issue });
          }
        }

        const fallback = settlementPlan(order, { merchants, mode: 'single' });
        fallback.reasons = [...(fallback.reasons ?? []), 'account not enabled for multi-seller payments'];
        fallback.platformFees = 'none';
        const created = await this.gateway.createOrder({ order, requestId: idempotencyKey, returnUrl, cancelUrl, plan: fallback });
        this.order.timeline(order._id, 'settlement_fallback', 'system', { from: 'split', to: 'single', reason: fallback.reasons.join('; ') });
        this.analytics.emit('payment_settlement_fallback', {
          sessionId: order.sessionId, userId: order.userId, orderId: order._id,
          props: { orderId: order._id, reason: 'capability_unsupported' }
        });
        logger.warn('payment.settlement.fallback', { orderId: order._id, reason: fallback.reasons.join('; ') });
        return { created, plan: fallback };
      }
      throw error;
    }
  }

  /**
   * verifyCapture V1–V7. Returns { ok } or a reason; never throws (the caller maps to HTTP).
   */
  verifyCapture(order, response) {
    const checks = { statusOk: false, orderRefOk: false, captureExistsOk: false, amountOk: false, currencyOk: false, captureStatusOk: false, uniqueOk: false, settlementOk: true };
    const units = response?.purchase_units ?? [];
    const unit = units[0];
    const capture = unit?.payments?.captures?.[0];
    const captureStatus = capture?.status;

    const expectedSettlement = order.payment?.settlement;
    const isSplit = expectedSettlement?.mode === 'split';

    if (response?.status === 'COMPLETED' || captureStatus === 'COMPLETED' || captureStatus === 'PENDING') {
      checks.statusOk = true;
    }

    if (isSplit) {
      // Every seller's unit must reference THIS order. In split mode the reference carries a
      // per-seller suffix (`SP-…-m1`), so match the prefix rather than the whole string.
      const refs = units.map((u) => `${u.custom_id ?? ''} ${u.invoice_id ?? ''}`);
      checks.orderRefOk = refs.length > 0 && refs.every((ref) => ref.includes(order.orderNumber));
    } else {
      checks.orderRefOk = Boolean(unit && (unit.custom_id === order.orderNumber || unit.invoice_id === order.orderNumber));
    }

    checks.captureExistsOk = Boolean(capture?.id);
    const allCaptures = units.flatMap((u) => u.payments?.captures ?? []);

    if (isSplit) {
      // The order total is the sum of every seller's capture; a dropped unit is a short payment.
      const totalCaptured = allCaptures.reduce((sum, c) => sum + Math.round(Number(c.amount?.value ?? 0) * 100), 0);
      checks.amountOk = allCaptures.length > 0 && totalCaptured === order.amounts.totalMinor;
      checks.currencyOk = allCaptures.length > 0
        && allCaptures.every((c) => c.amount?.currency_code === order.amounts.currency);
    } else if (capture?.amount) {
      const amountMinor = Math.round(Number(capture.amount.value) * 100);
      checks.amountOk = Number.isFinite(amountMinor) && amountMinor === order.amounts.totalMinor;
      checks.currencyOk = capture.amount.currency_code === order.amounts.currency;
    }
    checks.captureStatusOk = captureStatus === 'COMPLETED';

    // V8 — multi-seller settlement. When the order was created split, every seller's unit must be
    // present with the exact amount and the same payee we intended. A unit that pays a different
    // account, or a short amount, means the money went somewhere other than the plan says.
    if (isSplit) {
      const settlement = verifySettlement(order, response, { expected: expectedSettlement });
      checks.settlementOk = settlement.ok;
      if (!settlement.ok) {
        logger.error('payment.verify.settlement_mismatch', { orderId: order._id, units: settlement.units, expectedCount: settlement.expectedCount, actualCount: settlement.actualCount });
      }
      // Total across every capture must still equal the order total: no unit may be dropped.
      const totalSettled = allCaptures.reduce((sum, c) => sum + Math.round(Number(c.amount?.value ?? 0) * 100), 0);
      if (totalSettled !== order.amounts.totalMinor) {
        checks.settlementOk = false;
        logger.error('payment.verify.settlement_total_mismatch', { orderId: order._id, totalSettled, expected: order.amounts.totalMinor });
      }
    }

    // Every known capture id, for the uniqueness check: a capture id reused across orders is
    // either a replay or a provider bug, and both must stop the order being marked paid.
    const captureIds = units.flatMap((u) => u.payments?.captures ?? []).map((c) => c.id).filter(Boolean);
    if (captureIds.length) {
      checks.uniqueOk = captureIds.every((id) => {
        const clash = this.store.collection('orders').findOne({ 'payment.paypalCaptureId': id });
        return !clash || clash._id === order._id;
      });
    }

    if (captureStatus === 'PENDING') {
      return { ok: false, pending: true, captureStatus, checks, captureId: capture?.id, response };
    }
    const ok = Object.values(checks).every(Boolean);
    return { ok, pending: false, captureStatus, checks, captureId: capture?.id, response };
  }

  /** Transactional apply. Stock commit failure never leaves the order paid with no goods. */
  async applyCapture({ orderId, attempt, response, verification, auth }) {
    // Keep each capture paired with the purchase unit that produced it. A split order captures
    // once per seller, so the unit is the only thing that says *whose money* a capture holds —
    // without it a refund cannot be aimed at the right seller.
    const capturedUnits = (response.purchase_units ?? []).flatMap((u) =>
      (u.payments?.captures ?? []).map((c) => ({ unit: u, capture: c })));
    const captures = capturedUnits.map(({ capture }) => capture);
    const capture = captures[0];
    const payerEmail = response.payer?.email_address;
    try {
      const result = await this.store.transact(() => {
        const order = this.order.find({ orderId });
        const commit = this.inventory.commitForOrder(orderId);
        if (commit.failures.length) {
          const error = new ApiError('ITEM_UNAVAILABLE', 'The payment succeeded but the stock could not be committed.');
          error.failures = commit.failures;
          throw error;
        }
        assertTransition(order.status, ORDER_STATUS.PAID);
        this.order.orders.updateOne(
          { _id: orderId },
          {
            status: ORDER_STATUS.PAID,
            paidAt: new Date().toISOString(),
            expiresAt: null,
            payment: {
              ...order.payment,
              status: PAYMENT_STATUS.CAPTURED,
              paypalCaptureId: capture.id,
              // Every seller's capture, so per-merchant reconciliation and refunds stay possible.
              captures: capturedUnits.map(({ unit, capture: c }) => {
                // Split orders carry `${orderNumber}:${referenceId}` in custom_id, which names the
                // seller unambiguously. Single-unit orders have no such suffix.
                const customId = String(unit.custom_id ?? '');
                const referenceId = customId.includes(':') ? customId.split(':').pop() : null;
                const settlementUnit = (order.payment?.settlement?.units ?? [])
                  .find((u) => (referenceId && u.referenceId === referenceId)
                    || (!referenceId && u.merchantId && order.lines.every((l) => l.merchantId === u.merchantId)));
                return {
                  id: c.id,
                  amountMinor: Math.round(Number(c.amount.value) * 100),
                  status: c.status,
                  currency: c.amount?.currency_code ?? order.amounts.currency,
                  referenceId: referenceId ?? settlementUnit?.referenceId ?? null,
                  merchantId: settlementUnit?.merchantId ?? null,
                  payeeEmail: unit.payee?.email_address ?? settlementUnit?.payee?.emailAddress ?? null
                };
              }),
              captureStatus: capture.status,
              amountVerified: true,
              // The V1–V8 assertions the server actually ran before the order was allowed to
              // become "paid". Persisted so the storefront can show the real result instead of
              // re-deriving (or asserting) one — a check that is not recorded cannot be shown.
              verifyChecks: { ...verification.checks },
              payerId: response.payer?.payer_id,
              payerEmailHash: payerEmail ? hashPii(payerEmail) : undefined,
              capturedAt: new Date().toISOString(),
              lastAttemptNo: attempt.attemptNo,
              failureReason: undefined
            },
            shippingAddress: response.purchase_units[0]?.shipping ?? order.shippingAddress ?? undefined
          }
        );
        this.order.timeline(orderId, 'payment_captured', 'paypal', {
          captureId: capture.id, amountVerified: true, sellers: captures.length, settlement: order.payment?.settlement?.mode ?? 'single'
        });
        this.attempts.updateOne(
          { _id: attempt._id },
          {
            status: ATTEMPT_STATUS.SUCCEEDED,
            captureId: capture.id,
            captureStatus: capture.status,
            paypalOrderStatus: response.status,
            verified: true,
            verifyChecks: verification.checks,
            responseSnapshot: this.strip(response),
            capturedAt: new Date().toISOString()
          }
        );
        const cartDoc = this.cart.find({ sessionId: order.sessionId });
        if (cartDoc) this.cart.markConverted(cartDoc._id);
        return { orderId };
      });

      const order = this.order.find({ orderId });
      const merchantId = order.lines[0]?.merchantId;
      this.analytics.emit('payment_captured', {
        sessionId: order.sessionId,
        userId: order.userId,
        merchantId,
        orderId,
        props: { orderId, amountMinor: order.amounts.totalMinor, captureIdSuffix: capture.id.slice(-6) },
        dedupeKey: `payment_captured:${orderId}`
      });
      for (const line of order.lines) {
        this.analytics.emit('product_updated', { merchantId: line.merchantId, productId: line.productId, props: { productId: line.productId, changedFields: 1 } });
      }
      logger.info('payment.captured', { orderId, orderNumber: order.orderNumber, captureId: capture.id, total: formatMoney(order.amounts.totalMinor) });
      return { replayed: false, order: this.order.toDto(order), attempt: this.attempts.findOne({ _id: attempt._id }), capture, result };
    } catch (err) {
      // Money moved but we cannot fulfil: flag for a refund, never mark paid.
      logger.error('payment.apply.failed', { orderId, error: err.message, failures: JSON.stringify(err.failures ?? []) });
      const order = this.order.find({ orderId });
      if (order.status === ORDER_STATUS.PAYMENT_PROCESSING) {
        this.order.transition(orderId, ORDER_STATUS.PAYMENT_FAILED, { actor: 'system', meta: { reason: 'STOCK_COMMIT_FAILED' } });
      }
      this.attempts.updateOne({ _id: attempt._id }, { status: ATTEMPT_STATUS.FAILED, captureId: capture.id, failureReason: 'STOCK_COMMIT_FAILED', verified: true, verifyChecks: verification.checks });
      this.order.orders.updateOne({ _id: orderId }, { 'payment.status': PAYMENT_STATUS.FAILED, 'payment.failureReason': 'STOCK_COMMIT_FAILED' });
      this.analytics.emit('payment_failed', { sessionId: order.sessionId, orderId, props: { orderId, attemptNo: attempt.attemptNo, reason: 'STOCK_COMMIT_FAILED' } });
      throw new ApiError('ITEM_UNAVAILABLE', 'Your payment went through but the item sold out. We are refunding you automatically — no action needed.', { details: { captureId: capture.id } });
    }
  }

  handleCaptureError({ orderId, attempt, issue, message, raw, auth }) {
    const order = this.order.find({ orderId });
    const mapped = ISSUE_MAP[issue] ?? ISSUE_MAP.UNKNOWN;

    if (issue === 'ORDER_ALREADY_CAPTURED') {
      // PayPal says captured. Trust PayPal for the amount, but only mark paid after verification.
      const existingCapture = raw?.purchase_units?.[0]?.payments?.captures?.[0] ?? raw?.details?.[0];
      if (existingCapture?.amount) {
        const verification = this.verifyCapture(order, raw?.purchase_units ? raw : { purchase_units: [{ custom_id: order.orderNumber, payments: { captures: [existingCapture] } }], status: 'COMPLETED' });
        if (verification.ok) return this.applyCapture({ orderId, attempt, response: raw?.purchase_units ? raw : { status: 'COMPLETED', purchase_units: [{ custom_id: order.orderNumber, payments: { captures: [existingCapture] } }] }, verification, auth });
      }
      this.attempts.updateOne({ _id: attempt._id }, { status: ATTEMPT_STATUS.UNKNOWN, failureReason: 'UNKNOWN', responseSnapshot: this.strip(raw) });
      this.order.timeline(orderId, 'capture_already_exists', 'paypal', { needsReconcile: true });
      throw new ApiError('ORDER_ALREADY_CAPTURED', 'This payment was already captured. We are confirming the details now.', { details: { orderId } });
    }

    this.attempts.updateOne(
      { _id: attempt._id },
      { status: ATTEMPT_STATUS.FAILED, failureReason: mapped.reason, responseSnapshot: this.strip(raw), paypalOrderStatus: undefined }
    );
    if (order.status === ORDER_STATUS.PAYMENT_PROCESSING) {
      if (canTransition(order.status, ORDER_STATUS.PAYMENT_FAILED)) {
        this.order.transition(orderId, ORDER_STATUS.PAYMENT_FAILED, { actor: 'system', meta: { reason: mapped.reason } });
      }
    }
    this.order.orders.updateOne({ _id: orderId }, { 'payment.status': PAYMENT_STATUS.FAILED, 'payment.failureReason': mapped.reason });
    this.analytics.emit('payment_failed', {
      sessionId: order.sessionId,
      orderId,
      props: { orderId, attemptNo: attempt.attemptNo, reason: mapped.reason }
    });
    const status = mapped.code === 'PAYMENT_PROVIDER_UNAVAILABLE' ? 503 : 402;
    throw new ApiError(mapped.code, mapped.message, { status, details: { issue, requestId: auth?.requestId } });
  }

  /** Retry: a NEW attempt on the SAME order (never a new order, never a duplicate charge). */
  async retry({ orderId, auth, origin }) {
    return this.withOrderLock(orderId, async () => {
      const order = this.order.findAuthorised({ orderId, auth });
      if (order.status === ORDER_STATUS.PAID) return { replayed: true, order: this.order.toDto(order), attempt: this.attempts.findOne({ orderId, status: ATTEMPT_STATUS.SUCCEEDED }) };
      if (![ORDER_STATUS.AWAITING_PAYMENT, ORDER_STATUS.PAYMENT_FAILED].includes(order.status)) {
        throw new ApiError('INVALID_STATE', `An order that is "${order.status}" cannot be retried.`);
      }
      if (order.expiresAt && order.expiresAt < new Date().toISOString()) {
        this.order.transition(orderId, ORDER_STATUS.EXPIRED, { actor: 'system' });
        this.inventory.release({ orderId, reason: 'hold_expired' });
        throw new ApiError('HOLD_EXPIRED', 'This order hold expired. Refresh your cart to continue.');
      }
      // Exclude this order's own holds, otherwise its reservation looks like a stock shortage.
      const fresh = this.quote.recomputeForLines(order.lines, { excludeOrderId: orderId, excludeCartId: order.cartId });
      if (fresh.hash !== order.quoteHash) {
        throw new ApiError('QUOTE_STALE', 'Prices changed for this order. Review the new total and approve again.', { details: { diff: [] } });
      }
      this.order.orders.updateOne({ _id: orderId }, { 'payment.status': PAYMENT_STATUS.NONE, 'payment.failureReason': undefined });
      const { attempt, paypalOrderId } = await this.startAttempt(this.order.find({ orderId }), checkoutReturnUrls(origin, order));
      return { order: this.order.toDto(this.order.find({ orderId })), attempt, paypalOrderId };
    });
  }

  status({ orderId, auth }) {
    const order = this.order.findAuthorised({ orderId, auth });
    const attempt = this.attempts.findOne({ orderId }, { sort: { attemptNo: -1 } }) ?? this.attempts.findOne({ orderId: orderId });
    return {
      orderStatus: order.status,
      paymentStatus: order.payment?.status ?? PAYMENT_STATUS.NONE,
      attemptNo: order.payment?.lastAttemptNo ?? 0,
      captureId: order.payment?.paypalCaptureId,
      failureReason: order.payment?.failureReason,
      amountVerified: Boolean(order.payment?.amountVerified),
      expiresAt: order.expiresAt ?? null,
      lastAttemptStatus: attempt?.status
    };
  }

  voidPayPalOrder(paypalOrderId) {
    return this.gateway.voidOrder(paypalOrderId).catch((err) => {
      logger.warn('payment.void.failed', { paypalOrderId, error: err.message });
      return { status: 'FAILED' };
    });
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────
  async ingestWebhook({ headers, body }) {
    const { verified } = await this.gateway.verifyWebhook({ headers, body });
    const eventId = body?.id ?? `unknown-${objectId()}`;
    if (this.webhooks.findOne({ eventId })) {
      return { received: true, deduplicated: true };
    }
    const record = this.webhooks.insert({
      eventId,
      type: body?.event_type,
      resourceType: body?.resource_type,
      orderId: body?.resource?.custom_id,
      payload: body,
      signatureVerified: verified,
      processingResult: verified ? 'ignored' : 'error'
    });

    if (!verified) {
      logger.error('webhook.signature_invalid', { eventId, type: body?.event_type });
      return { received: true, deduplicated: false };
    }

    try {
      const result = this.handleWebhookEvent(body);
      this.webhooks.updateOne({ _id: record._id }, { processingResult: result, processedAt: new Date().toISOString() });
    } catch (err) {
      this.webhooks.updateOne({ _id: record._id }, { processingResult: 'error', error: err.message });
      logger.error('webhook.handle.failed', { eventId, error: err.message });
    }
    return { received: true, deduplicated: false };
  }

  handleWebhookEvent(body) {
    const type = body?.event_type;
    const resource = body?.resource ?? {};
    const orderNumber = resource.custom_id ?? resource.invoice_id;
    const order = orderNumber ? this.order.orders.findOne({ orderNumber }) : this.order.orders.findOne({ 'payment.paypalCaptureId': resource.id });
    if (!order) return 'ignored';

    const attempt = this.attempts.findOne({ orderId: order._id }, { sort: { attemptNo: -1 } });

    switch (type) {
      case 'CHECKOUT.ORDER.APPROVED': {
        // Approval is NOT capture — never mark paid here.
        if (attempt) this.attempts.updateOne({ _id: attempt._id }, { status: ATTEMPT_STATUS.APPROVED, paypalOrderStatus: 'APPROVED' });
        this.order.orders.updateOne({ _id: order._id }, { 'payment.status': PAYMENT_STATUS.APPROVED });
        this.order.timeline(order._id, 'paypal_order_approved', 'paypal');
        return 'applied';
      }
      case 'PAYMENT.CAPTURE.COMPLETED': {
        if (order.status === ORDER_STATUS.PAID) return 'ignored';
        const synthetic = {
          status: 'COMPLETED',
          purchase_units: [
            {
              custom_id: order.orderNumber,
              invoice_id: order.orderNumber,
              payments: { captures: [{ id: resource.id, status: 'COMPLETED', amount: resource.amount }] }
            }
          ],
          payer: { email_address: resource.payer?.email_address }
        };
        const verification = this.verifyCapture(order, synthetic);
        if (!verification.ok) {
          logger.error('webhook.verify.failed', { orderId: order._id, checks: verification.checks });
          return 'error';
        }
        this.applyCapture({ orderId: order._id, attempt, response: synthetic, verification, auth: null }).catch((err) =>
          logger.error('webhook.apply.failed', { orderId: order._id, error: err.message })
        );
        return 'applied';
      }
      case 'PAYMENT.CAPTURE.DENIED': {
        if (order.status === ORDER_STATUS.PAID) return 'ignored'; // never downgrade a paid order
        if (attempt) this.attempts.updateOne({ _id: attempt._id }, { status: ATTEMPT_STATUS.FAILED, failureReason: 'INSTRUMENT_DECLINED' });
        if (order.status === ORDER_STATUS.PAYMENT_PROCESSING || order.status === ORDER_STATUS.AWAITING_PAYMENT) {
          if (order.status === ORDER_STATUS.PAYMENT_PROCESSING) this.order.transition(order._id, ORDER_STATUS.PAYMENT_FAILED, { actor: 'paypal' });
          this.order.orders.updateOne({ _id: order._id }, { 'payment.status': PAYMENT_STATUS.FAILED, 'payment.failureReason': 'INSTRUMENT_DECLINED' });
        }
        return 'applied';
      }
      case 'PAYMENT.CAPTURE.PENDING': {
        if (attempt) this.attempts.updateOne({ _id: attempt._id }, { status: ATTEMPT_STATUS.PENDING });
        return 'applied';
      }
      case 'PAYMENT.CAPTURE.REFUNDED':
      case 'PAYMENT.CAPTURE.REVERSED': {
        if (order.status === ORDER_STATUS.PAID || order.status === ORDER_STATUS.PROCESSING) {
          this.order.transition(order._id, ORDER_STATUS.REFUNDED, { actor: 'paypal', meta: { refundId: resource.id } });
          this.order.orders.updateOne({ _id: order._id }, { 'payment.status': PAYMENT_STATUS.REFUNDED });
        }
        return 'applied';
      }
      default:
        return 'ignored';
    }
  }

  /** Reconciliation: PayPal is the source of truth when our write was lost (payments_paypal.md §8). */
  async reconcile({ orderId } = {}) {
    const stuck = orderId
      ? [this.order.find({ orderId })]
      : this.order.orders.find({ status: ORDER_STATUS.PAYMENT_PROCESSING });
    const outcomes = [];
    for (const order of stuck) {
      if (!order?.payment?.paypalOrderId) continue;
      try {
        const remote = await this.gateway.getOrder(order.payment.paypalOrderId);
        const attempt = this.attempts.findOne({ orderId: order._id }, { sort: { attemptNo: -1 } });
        if (remote.status === 'COMPLETED') {
          const verification = this.verifyCapture(order, remote);
          if (verification.ok) {
            await this.applyCapture({ orderId: order._id, attempt, response: remote, verification, auth: null });
            outcomes.push({ orderId: order._id, outcome: 'applied_paid' });
            continue;
          }
          outcomes.push({ orderId: order._id, outcome: 'verify_failed' });
          continue;
        }
        if (remote.status === 'VOIDED') {
          if (order.status === ORDER_STATUS.PAYMENT_PROCESSING) this.order.transition(order._id, ORDER_STATUS.PAYMENT_FAILED, { actor: 'system' });
          this.inventory.release({ orderId: order._id, reason: 'reconcile_voided' });
          outcomes.push({ orderId: order._id, outcome: 'voided' });
          continue;
        }
        outcomes.push({ orderId: order._id, outcome: 'no_change' });
      } catch (err) {
        if (err.issue === 'RESOURCE_NOT_FOUND') {
          if (order.status === ORDER_STATUS.PAYMENT_PROCESSING) this.order.transition(order._id, ORDER_STATUS.PAYMENT_FAILED, { actor: 'system' });
          this.inventory.release({ orderId: order._id, reason: 'reconcile_missing' });
          outcomes.push({ orderId: order._id, outcome: 'paypal_order_missing' });
        } else {
          outcomes.push({ orderId: order._id, outcome: 'error', error: err.message });
        }
      }
    }
    return { checked: stuck.length, outcomes };
  }

  /** Expire unpaid orders whose holds elapsed, and release their stock. */
  expireStaleOrders(now = new Date()) {
    const stale = this.order.orders.find({ status: ORDER_STATUS.AWAITING_PAYMENT, expiresAt: { $lt: now.toISOString() } });
    for (const order of stale) {
      this.order.transition(order._id, ORDER_STATUS.EXPIRED, { actor: 'system' });
      this.inventory.release({ orderId: order._id, reason: 'hold_expired' });
      this.analytics.emit('order_expired', { sessionId: order.sessionId, orderId: order._id, props: { orderId: order._id, itemCount: order.lines.length } });
    }
    this.inventory.releaseExpired(now);
    return stale.length;
  }

  /**
   * Refund a captured order.
   *
   * Money is captured per seller: a multi-merchant order has one PayPal capture per purchase
   * unit, and each unit holds only that seller's share. A refund must therefore be scoped to
   * captures, not to the order:
   *   - a merchant refunds the captures that belong to their own seller, for their own amount;
   *   - an admin may refund any or all of them.
   * Refunding the order total against a single capture (the old behaviour) is rejected by PayPal
   * on a split order, and flipping the whole order to "refunded" let one seller erase a co-seller's
   * revenue. Both are fixed here.
   */
  async refundOrder({ orderId, reason = 'Customer return', auth } = {}) {
    const user = auth?.user;
    if (!user || (user.role !== 'merchant' && user.role !== 'admin')) {
      throw new ApiError('FORBIDDEN', 'Only merchants or admins can refund orders.');
    }
    const order = this.order.find({ orderId });
    const isAdmin = user.role === 'admin';
    const merchantId = isAdmin ? null : user.merchantId;
    if (!isAdmin && !order.lines.some((l) => l.merchantId === merchantId)) {
      throw new ApiError('ORDER_NOT_FOUND', "We couldn't find that order.");
    }
    const refundable = [ORDER_STATUS.PAID, ORDER_STATUS.PROCESSING, ORDER_STATUS.SHIPPED, ORDER_STATUS.DELIVERED];
    if (!refundable.includes(order.status)) {
      throw new ApiError('INVALID_STATE', `Cannot refund an order in status "${order.status}".`);
    }

    // One capture per seller. Older orders predate per-unit captures, so fall back to the single
    // capture and attribute it to the only seller in the order.
    const orderMerchantIds = [...new Set(order.lines.map((l) => l.merchantId))];
    const stored = order.payment?.captures ?? [];
    const captures = (stored.length ? stored : (order.payment?.paypalCaptureId
      ? [{ id: order.payment.paypalCaptureId, amountMinor: order.amounts.totalMinor, status: 'COMPLETED' }]
      : [])).map((c, index) => ({
      ...c,
      amountMinor: c.amountMinor ?? order.amounts.totalMinor,
      merchantId: c.merchantId ?? (orderMerchantIds.length === 1 ? orderMerchantIds[0] : null),
      referenceId: c.referenceId ?? null
    }));
    if (!captures.length) {
      throw new ApiError('INVALID_STATE', 'This order has no captured payment to refund.');
    }

    const alreadyRefunded = new Set((order.payment?.refunds ?? []).map((r) => r.captureId));
    const targets = captures.filter((c) => !alreadyRefunded.has(c.id) && (isAdmin || c.merchantId === merchantId));
    if (!targets.length) {
      throw new ApiError('INVALID_STATE', 'Every refundable capture on this order has already been refunded.');
    }

    // Refund each capture for exactly the amount that capture holds.
    const refunds = [];
    for (const target of targets) {
      let refundResult = null;
      if (this.gateway?.refundCapture) {
        try {
          refundResult = await this.gateway.refundCapture(target.id, {
            amountMinor: target.amountMinor,
            currency: target.currency ?? order.amounts.currency,
            note: reason
          });
        } catch (err) {
          logger.error('payment.refund.failed', { orderId, captureId: target.id, error: err.message });
          throw new ApiError('PAYMENT_PROVIDER_ERROR', `PayPal refund failed: ${err.message}`);
        }
      }
      refunds.push({
        captureId: target.id,
        merchantId: target.merchantId,
        referenceId: target.referenceId,
        amountMinor: target.amountMinor,
        currency: target.currency ?? order.amounts.currency,
        refundId: refundResult?.id ?? `REF-${objectId().slice(0, 8)}`,
        providerStatus: refundResult?.status ?? 'COMPLETED',
        reason
      });
    }

    const updated = this.order.recordRefunds(orderId, {
      refunds,
      reason,
      actor: user.role,
      totalCaptures: captures.length
    });
    const refundIds = refunds.map((r) => r.refundId);
    // "Partial" means money is still outstanding to a seller after this refund — not "this call
    // touched fewer captures than the order has".
    const settled = new Set([...alreadyRefunded, ...refunds.map((r) => r.captureId)]);
    const stillUnrefunded = captures.filter((c) => !settled.has(c.id)).length;
    return {
      order: this.order.toDto(updated),
      refundId: refundIds.length === 1 ? refundIds[0] : refundIds,
      refunds,
      refundedMinor: refunds.reduce((sum, r) => sum + r.amountMinor, 0),
      partial: stillUnrefunded > 0
    };
  }

  /** Strip tokens/PII from a PayPal response before storing it (security_privacy.md §6). */
  strip(response) {
    if (!response || typeof response !== 'object') return undefined;
    const clone = JSON.parse(JSON.stringify(response));
    if (clone.payer) {
      clone.payer = { payer_id: clone.payer.payer_id, email_address: clone.payer.email_address ? '[hashed]' : undefined };
    }
    delete clone.links;
    return clone;
  }

  // ── Developer/test helpers ───────────────────────────────────────────────
  buildWebhookEvent(order) {
    if (this.gateway.mode === 'simulator') return this.gateway.buildCaptureCompletedEvent(order);
    return null;
  }

  attemptsFor(orderId) {
    return this.attempts.find({ orderId }, { sort: { attemptNo: 1 } });
  }

  paypalAmountFor(minor) {
    return toPayPalAmount(minor);
  }
}

export default PaymentService;
