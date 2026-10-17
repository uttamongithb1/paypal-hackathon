/**
 * PayPal gateway: Orders v2 over HTTPS in `sandbox` mode, plus an in-process `simulator` used by the
 * default demo (and by tests) so the whole payment path is runnable without credentials.
 * Docs: ../docs/payments_paypal.md §2–§4
 *
 * Both implementations return exactly the shapes the payment service verifies, so verification code
 * is identical in both modes.
 */
import env, { paypalBaseUrl } from '../config/env.mjs';
import { settlementPlan } from './settlement.mjs';
import logger from '../lib/logger.mjs';
import { toPayPalAmount } from '../lib/money.mjs';
import { objectId } from '../lib/crypto.mjs';

export class PaypalError extends Error {
  constructor(issue, message, { httpStatus = 422, debugId, raw } = {}) {
    super(message ?? issue);
    this.issue = issue;
    this.httpStatus = httpStatus;
    this.debugId = debugId;
    this.raw = raw;
  }
}

/**
 * PayPal purchase_units built from a settlement plan. Shared by the simulator and the real client so
 * both speak the identical request shape — a divergence here would mean the demo passing on the
 * simulator and failing on the sandbox.
 *
 * `payee` and `payment_instruction.platform_fees` are only emitted in `split` mode with more than
 * one seller; in single mode the payload is byte-identical to the historical one.
 */
export function buildPurchaseUnits(order, plan) {
  const currency = order.amounts.currency;
  const payout = (minor) => ({ currency_code: currency, value: toPayPalAmount(minor) });

  return plan.units.map((unit) => {
    const purchaseUnit = {
      // reference_id is required by PayPal whenever an order has more than one purchase unit.
      ...(unit.referenceId ? { reference_id: unit.referenceId } : {}),
      custom_id: plan.mode === 'split' ? `${order.orderNumber}:${unit.referenceId}` : order.orderNumber,
      invoice_id: plan.mode === 'split' ? `${order.orderNumber}-${unit.referenceId}` : order.orderNumber,
      description: (plan.mode === 'split' ? `${order.orderNumber} — ${unit.merchantName}` : `ShopPilot order ${order.orderNumber}`).slice(0, 127),
      amount: {
        ...payout(unit.amountMinor),
        breakdown: {
          item_total: payout(unit.itemTotalMinor),
          tax_total: payout(unit.taxMinor),
          shipping: payout(unit.shippingMinor)
        }
      },
      items: unit.items.map((item) => ({
        name: String(item.name).slice(0, 127),
        quantity: String(item.quantity),
        unit_amount: payout(item.unitAmountMinor),
        category: 'PHYSICAL_GOODS',
        sku: item.sku
      }))
    };

    if (plan.mode === 'split' && unit.payee) {
      // PayPal merchant ids are 13 alphanumeric characters. A malformed one makes the whole create
      // fail with INVALID_STRING_LENGTH / INVALID_PARAMETER_SYNTAX, so an unusable id is dropped and
      // the payee is identified by email alone (PayPal accepts either).
      const merchantId = String(unit.payee.merchantId ?? '').trim();
      const usableMerchantId = /^[A-Z0-9]{13}$/.test(merchantId);
      purchaseUnit.payee = {
        email_address: unit.payee.emailAddress,
        ...(usableMerchantId ? { merchant_id: merchantId } : {})
      };
      purchaseUnit.payment_instruction = {
        disbursement_mode: env.paypalDisbursementMode,
        ...(unit.platformFeeMinor > 0 ? { platform_fees: [{ amount: payout(unit.platformFeeMinor) }] } : {})
      };
    }
    return purchaseUnit;
  });
}

/**
 * Does this PayPal error mean "your account cannot do multi-seller payments"? Sandbox accounts are
 * frequently not enabled for the Marketplaces capability, so `auto` mode needs to tell that apart
 * from a genuine failure and fall back rather than failing the shopper's payment.
 */
export function isCapabilityRejection(error) {
  const haystack = [
    error?.issue,
    error?.message,
    typeof error?.raw === 'string' ? error.raw : JSON.stringify(error?.raw ?? '')
  ].filter(Boolean).join(' ').toLowerCase();
  return [
    'platform_fees', 'platform fee', 'payment_instruction', 'not supported', 'not enabled',
    'msp_not_supported', 'partner_fee', 'not eligible', 'capability'
  ].some((needle) => haystack.includes(needle));
}

const simulatedOutcomes = {
  approve: { finalStatus: 'COMPLETED', captureStatus: 'COMPLETED' },
  decline: { finalStatus: 'DECLINED', captureStatus: 'DECLINED', issue: 'INSTRUMENT_DECLINED' },
  insufficient_funds: { finalStatus: 'DECLINED', captureStatus: 'DECLINED', issue: 'INSUFFICIENT_FUNDS' },
  pending: { finalStatus: 'PENDING', captureStatus: 'PENDING' },
  amount_mismatch: { finalStatus: 'COMPLETED', captureStatus: 'COMPLETED', mutateAmount: true },
  // Models a sandbox account that is not enabled for the Marketplaces capability, so `auto`
  // settlement mode and its honest fallback can be exercised without real credentials.
  split_unsupported: { throw: 'PAYMENT_INSTRUCTION_NOT_SUPPORTED' },
  error: { throw: 'PAYMENT_PROVIDER_UNAVAILABLE' }
};

/** ── Simulator ───────────────────────────────────────────────────────────── */
export class PaypalSimulator {
  constructor() {
    this.orders = new Map();
    this.captures = new Map();
    this.webhookEvents = [];
    this.mode = 'simulator';
    this.simulatedCapability = env.paypalSimSplitUnsupported ? 'split_unsupported'
      : env.paypalSimFeesUnsupported ? 'fees_unsupported'
        : 'full';
  }

  /** The simulator has no upstream to be unhealthy — it is always up. */
  async healthy() {
    return true;
  }

  async createOrder({ order, requestId, returnUrl, cancelUrl, plan = null }) {
    const existing = [...this.orders.values()].find((o) => o.requestId === requestId);
    if (existing) return { id: existing.id, status: existing.status };

    if (this.simulatedCapability === 'split_unsupported' && (plan?.mode === 'split')) {
      // Same typed error the sandbox client raises after classifying a capability rejection, so
      // the `auto` fallback has exactly one code path to handle in both modes.
      throw new PaypalError('SPLIT_SETTLEMENT_UNSUPPORTED', 'This merchant account is not enabled for multi-seller payments.', { httpStatus: 422 });
    }
    if (this.simulatedCapability === 'fees_unsupported' && plan?.mode === 'split' && (plan.totals?.platformFeeMinor ?? 0) > 0) {
      // Payees are fine; only the commission is refused. Mirrors PayPal's PLATFORM_FEES_NOT_SUPPORTED.
      const error = new PaypalError('SPLIT_SETTLEMENT_UNSUPPORTED', 'The API Caller is not enabled to process transactions with platform_fees.', { httpStatus: 422 });
      error.originalIssue = 'PLATFORM_FEES_NOT_SUPPORTED';
      error.platformFeesRejected = true;
      throw error;
    }

    const id = `SIM-${objectId().toUpperCase().slice(0, 12)}`;
    const total = order.amounts.totalMinor;
    const created = {
      id,
      requestId,
      status: 'CREATED',
      intent: 'CAPTURE',
      create_time: new Date().toISOString(),
      returnUrl,
      cancelUrl,
      settlement: plan?.mode ?? 'single',
      purchase_units: buildPurchaseUnits(order, plan ?? settlementPlan(order, { mode: 'single' })),
      orderRef: order._id
    };
    this.orders.set(id, created);
    logger.info('paypal.simulator.order_created', { paypalOrderId: id, orderNumber: order.orderNumber, requestId });
    return { id, status: created.status };
  }

  async getOrder(paypalOrderId) {
    const order = this.orders.get(paypalOrderId);
    if (!order) throw new PaypalError('RESOURCE_NOT_FOUND', 'Order not found', { httpStatus: 404 });
    return order;
  }

  async captureOrder(paypalOrderId, { requestId, outcome = 'approve' } = {}) {
    const order = this.orders.get(paypalOrderId);
    if (!order) throw new PaypalError('RESOURCE_NOT_FOUND', 'Order not found', { httpStatus: 404 });
    const captured = this.captures.get(order.id);
    if (captured) {
      throw new PaypalError('ORDER_ALREADY_CAPTURED', 'Order already captured', { httpStatus: 422, raw: captured });
    }
    const behaviour = simulatedOutcomes[outcome] ?? simulatedOutcomes.approve;
    if (behaviour.throw) throw new PaypalError(behaviour.throw, 'PayPal is temporarily unavailable', { httpStatus: 503 });
    if (behaviour.issue) {
      throw new PaypalError(behaviour.issue, 'The payment was declined', { httpStatus: 422 });
    }

    order.status = behaviour.finalStatus === 'COMPLETED' ? 'COMPLETED' : 'APPROVED';

    // A multi-seller order captures once per purchase unit, so every seller gets their own capture
    // id. Modelling that here is what lets the verification path be tested offline.
    const captures = [];
    for (const unit of order.purchase_units) {
      const amount = behaviour.mutateAmount
        ? { currency_code: 'USD', value: toPayPalAmount(Math.max(1, Math.round(Number(unit.amount.value) * 100) - 1)) }
        : unit.amount;

      const capture = {
        id: `SIMCAP-${objectId().toUpperCase().slice(0, 12)}`,
        status: behaviour.captureStatus,
        amount,
        create_time: new Date().toISOString(),
        final_capture: true,
        custom_id: unit.custom_id,
        invoice_id: unit.invoice_id,
        requestId,
        // Echoed back exactly as PayPal does; verifySettlement compares this.
        ...(unit.payee ? { payee: { email_address: unit.payee.email_address, merchant_id: unit.payee.merchant_id } } : {})
      };
      unit.payments = { captures: [capture] };
      captures.push(capture);
    }

    if (behaviour.captureStatus === 'COMPLETED') {
      this.captures.set(order.id, captures);
      order.status = 'COMPLETED';
    }
    logger.info('paypal.simulator.capture', {
      paypalOrderId, status: order.status, outcome, units: captures.length, captureId: captures[0]?.id
    });

    return {
      id: order.id,
      status: order.status,
      purchase_units: order.purchase_units,
      payer: { payer_id: 'SIMPAYER', email_address: 'sandbox-buyer@example.com', name: { given_name: 'Sandbox', surname: 'Buyer' } }
    };
  }

  async voidOrder(paypalOrderId) {
    const order = this.orders.get(paypalOrderId);
    if (!order) return { status: 'NOT_FOUND' };
    if (this.captures.has(paypalOrderId)) return { status: 'COMPLETED' };
    order.status = 'VOIDED';
    return { status: 'VOIDED' };
  }

  async refundCapture(captureId, { amountMinor, currency = 'USD', note } = {}) {
    return {
      id: `SIMREF-${objectId().slice(0, 8)}`,
      status: 'COMPLETED',
      amount: { value: toPayPalAmount(amountMinor ?? 100), currency_code: currency },
      note_to_payer: note
    };
  }

  async verifyWebhook({ headers, body }) {
    // The simulator signs nothing; real verification lives in the sandbox implementation below.
    return { verified: true, event: body };
  }

  /** Test/demo helper: build a webhook event as PayPal would send it. */
  buildCaptureCompletedEvent(order) {
    const capture = [...this.captures.entries()].find(([id]) => this.orders.get(id)?.orderRef === order._id);
    if (!capture) return null;
    const [paypalOrderId, captureObj] = capture;
    return {
      id: `WH-${objectId().toUpperCase().slice(0, 12)}`,
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource_type: 'capture',
      create_time: new Date().toISOString(),
      resource: {
        id: captureObj.id,
        status: captureObj.status,
        amount: captureObj.amount,
        custom_id: captureObj.custom_id,
        invoice_id: captureObj.invoice_id,
        supplementary_data: { related_ids: { order_id: paypalOrderId } }
      }
    };
  }
}

/** ── Real sandbox (Orders v2) ────────────────────────────────────────────── */
export class PaypalSandbox {
  constructor() {
    this.mode = 'sandbox';
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  async accessToken() {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const auth = Buffer.from(`${env.paypalClientId}:${env.paypalClientSecret}`).toString('base64');
    const res = await fetch(`${paypalBaseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(env.paypalTimeoutMs)
    });
    if (!res.ok) throw new PaypalError('AUTHENTICATION_FAILURE', `PayPal auth failed (${res.status})`, { httpStatus: 502 });
    const data = await res.json();
    this.token = data.access_token;
    this.tokenExpiresAt = Date.now() + Math.max(0, (data.expires_in - 60) * 1000);
    return this.token;
  }

  /**
   * Cached liveness probe: are the credentials still authenticating?
   *
   * Cached for 30 seconds because a health endpoint must not spend a PayPal API call on every
   * request, and because a sandbox that is briefly unavailable should not take the storefront
   * down with it — the demo degrades one feature instead of dying.
   */
  async healthy() {
    if (this.healthAt && Date.now() - this.healthAt < 30_000) return this.healthValue;
    try {
      await this.accessToken();
      this.healthValue = true;
    } catch {
      this.healthValue = false;
    }
    this.healthAt = Date.now();
    return this.healthValue;
  }

  async request(path, { method = 'GET', body, requestId, retries = 2 } = {}) {
    const token = await this.accessToken();
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const res = await fetch(`${paypalBaseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation',
            ...(requestId ? { 'PayPal-Request-Id': requestId } : {})
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(env.paypalTimeoutMs)
        });
        const text = await res.text();
        const data = text ? JSON.parse(text) : {};
        if (!res.ok) {
          const issue = data?.details?.[0]?.issue ?? data?.name ?? `HTTP_${res.status}`;
          const retryable = res.status >= 500 || res.status === 429;
          if (retryable && attempt < retries) {
            await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
            continue;
          }
          throw new PaypalError(issue, data?.message ?? `PayPal error ${res.status}`, { httpStatus: res.status, debugId: data?.debug_id, raw: data });
        }
        return data;
      } catch (err) {
        if (err instanceof PaypalError) throw err;
        if (attempt === retries) throw new PaypalError('NETWORK', `PayPal unreachable: ${err.message}`, { httpStatus: 503 });
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
    }
    throw new PaypalError('UNKNOWN', 'PayPal request failed', { httpStatus: 502 });
  }

  async createOrder({ order, requestId, plan = null }) {
    const resolved = plan ?? settlementPlan(order, { mode: 'single' });
    const purchaseUnits = buildPurchaseUnits(order, resolved);

    // Guard: PayPal rejects inconsistent breakdowns (payments_paypal.md §3.2). Checked per unit,
    // because with several sellers a single bad unit fails the whole order.
    for (const [index, unit] of resolved.units.entries()) {
      const built = purchaseUnits[index].amount;
      const sum = unit.itemTotalMinor + unit.shippingMinor + unit.taxMinor;
      if (sum !== unit.amountMinor || built.value !== toPayPalAmount(unit.amountMinor)) {
        throw new PaypalError('INTERNAL_AMOUNT_BUILDER', 'Amount breakdown does not sum to the total', { httpStatus: 500 });
      }
    }
    const allSum = resolved.units.reduce((sum, unit) => sum + unit.amountMinor, 0);
    if (allSum !== order.amounts.totalMinor) {
      throw new PaypalError('INTERNAL_AMOUNT_BUILDER', 'Settlement units do not sum to the order total', { httpStatus: 500 });
    }

    const payload = {
      intent: 'CAPTURE',
      purchase_units: purchaseUnits,
      application_context: { brand_name: 'ShopPilot AI (demo)', shipping_preference: 'GET_FROM_FILE', user_action: 'PAY_NOW' }
    };

    try {
      const data = await this.request('/v2/checkout/orders', { method: 'POST', body: payload, requestId });
      return { id: data.id, status: data.status, settlement: resolved.mode };
    } catch (error) {
      // Surface the capability gap distinctly: `auto` mode falls back to a single unit rather than
      // failing the shopper, and the reason is recorded instead of being swallowed.
      if (resolved.mode === 'split' && isCapabilityRejection(error)) {
        // Keep PayPal's own issue code: "platform_fees not supported" and "payee not supported" have
        // very different remedies, and the caller needs to tell them apart to degrade correctly.
        const wrapped = new PaypalError('SPLIT_SETTLEMENT_UNSUPPORTED', error.message, { httpStatus: 422, raw: error.raw, debugId: error.debugId });
        wrapped.originalIssue = error.issue ?? null;
        wrapped.platformFeesRejected = /platform_fee/i.test(`${error.issue ?? ''} ${error.message ?? ''}`);
        throw wrapped;
      }
      throw error;
    }
  }

  async getOrder(paypalOrderId) {
    return this.request(`/v2/checkout/orders/${paypalOrderId}`);
  }

  async captureOrder(paypalOrderId, { requestId } = {}) {
    return this.request(`/v2/checkout/orders/${paypalOrderId}/capture`, { method: 'POST', body: {}, requestId });
  }

  async voidOrder(paypalOrderId) {
    try {
      return await this.request(`/v2/checkout/orders/${paypalOrderId}/void`, { method: 'POST', requestId: `pp-void-${paypalOrderId}` });
    } catch (err) {
      logger.warn('paypal.void.failed', { paypalOrderId, issue: err.issue });
      return { status: 'FAILED' };
    }
  }

  async refundCapture(captureId, { amountMinor, currency = 'USD', note } = {}) {
    const payload = {};
    if (amountMinor) {
      payload.amount = {
        value: toPayPalAmount(amountMinor),
        currency_code: currency
      };
    }
    if (note) payload.note_to_payer = note;
    return this.request(`/v2/payments/captures/${captureId}/refund`, {
      method: 'POST',
      body: payload,
      requestId: `refund-${captureId}-${Date.now()}`
    });
  }

  async verifyWebhook({ headers, body }) {
    if (!env.paypalWebhookId) return { verified: false, reason: 'no_webhook_id' };
    const data = await this.request('/v1/notifications/verify-webhook-signature', {
      method: 'POST',
      body: {
        auth_algo: headers['paypal-auth-algo'],
        cert_url: headers['paypal-cert-url'],
        transmission_id: headers['paypal-transmission-id'],
        transmission_sig: headers['paypal-transmission-sig'],
        transmission_time: headers['paypal-transmission-time'],
        webhook_id: env.paypalWebhookId,
        webhook_event: body
      }
    });
    return { verified: data.verification_status === 'SUCCESS', raw: data };
  }
}

export function createPaypalGateway() {
  if (env.paypalMode === 'simulator') {
    logger.warn('paypal.mode', { mode: 'simulator', note: 'No real PayPal calls — set PAYPAL_MODE=sandbox with credentials for live sandbox testing.' });
    return new PaypalSimulator();
  }
  return new PaypalSandbox();
}

export default createPaypalGateway;
