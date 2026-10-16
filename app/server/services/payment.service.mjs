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
import { formatMoney, toPayPalAmount } from '../lib/money.mjs';
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
      const created = await this.gateway.createOrder({ order, requestId: idempotencyKey, returnUrl, cancelUrl });
      this.attempts.updateOne({ _id: attempt._id }, { status: ATTEMPT_STATUS.AWAITING_APPROVAL, paypalOrderId: created.id, paypalOrderStatus: created.status });
      this.order.orders.updateOne({ _id: order._id }, { payment: { ...order.payment, status: PAYMENT_STATUS.CREATED, paypalOrderId: created.id, lastAttemptNo: attemptNo } });
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
   * verifyCapture V1–V7. Returns { ok } or a reason; never throws (the caller maps to HTTP).
   */
  verifyCapture(order, response) {
    const checks = { statusOk: false, orderRefOk: false, captureExistsOk: false, amountOk: false, currencyOk: false, captureStatusOk: false, uniqueOk: false };
    const unit = response?.purchase_units?.[0];
    const capture = unit?.payments?.captures?.[0];
    const captureStatus = capture?.status;

    if (response?.status === 'COMPLETED' || captureStatus === 'COMPLETED' || captureStatus === 'PENDING') {
      checks.statusOk = true;
    }
    checks.orderRefOk = Boolean(unit && (unit.custom_id === order.orderNumber || unit.invoice_id === order.orderNumber));
    checks.captureExistsOk = Boolean(capture?.id);
    if (capture?.amount) {
      const amountMinor = Math.round(Number(capture.amount.value) * 100);
      checks.amountOk = Number.isFinite(amountMinor) && amountMinor === order.amounts.totalMinor;
      checks.currencyOk = capture.amount.currency_code === order.amounts.currency;
    }
    checks.captureStatusOk = captureStatus === 'COMPLETED';
    if (capture?.id) {
      const clash = this.store.collection('orders').findOne({ 'payment.paypalCaptureId': capture.id });
      checks.uniqueOk = !clash || clash._id === order._id;
    }

    if (captureStatus === 'PENDING') {
      return { ok: false, pending: true, captureStatus, checks, captureId: capture?.id, response };
    }
    const ok = Object.values(checks).every(Boolean);
    return { ok, pending: false, captureStatus, checks, captureId: capture?.id, response };
  }

  /** Transactional apply. Stock commit failure never leaves the order paid with no goods. */
  async applyCapture({ orderId, attempt, response, verification, auth }) {
    const capture = response.purchase_units[0].payments.captures[0];
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
              captureStatus: capture.status,
              amountVerified: true,
              payerId: response.payer?.payer_id,
              payerEmailHash: payerEmail ? hashPii(payerEmail) : undefined,
              capturedAt: new Date().toISOString(),
              lastAttemptNo: attempt.attemptNo,
              failureReason: undefined
            },
            shippingAddress: response.purchase_units[0]?.shipping ?? order.shippingAddress ?? undefined
          }
        );
        this.order.timeline(orderId, 'payment_captured', 'paypal', { captureId: capture.id, amountVerified: true });
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
  async retry({ orderId, auth }) {
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
      const { attempt, paypalOrderId } = await this.startAttempt(this.order.find({ orderId }));
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
