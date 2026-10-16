# ShopPilot AI — PayPal Payments Integration

Target: **PayPal Orders v2 REST API, sandbox**. Server-side only for anything that touches money. This document is the contract for `apps/api/src/services/paymentService.ts`.

Reference: PayPal "How to use PayPal REST APIs" (Orders v2) — `POST /v2/checkout/orders` → JS SDK approval → `POST /v2/checkout/orders/{id}/capture` → verify. Do **not** use `actions.order.create()` / `actions.order.capture()` client helpers; those are the deprecated client-side flow and cannot guarantee our amount or verification.

---

## 1. Sequence (happy path)

```
User clicks "Approve & Pay"                    (browser)
      │
      ▼
POST /api/v1/orders {quoteId, quoteHash, contact}          (our API)
  ├─ recompute quote; if hash ≠ approved → 409 QUOTE_STALE
  ├─ create Order(status=awaiting_payment), snapshot lines, commit holds
  ├─ PayPal-Request-Id = sha256(`pp:create:{orderId}:{attemptNo}`)
  ├─ POST https://api-m.sandbox.paypal.com/v2/checkout/orders
  │    { intent:"CAPTURE", purchase_units:[{ custom_id: orderNumber, invoice_id: orderNumber,
  │      amount:{ currency_code:"USD", value:"1903.04", breakdown:{ item_total:{…},
  │      shipping:{…}, tax_total:{…} } }, items:[…], shipping:{…} }], payment_source:{ paypal:{} } }
  ├─ store payment.paypalOrderId; emit checkout_started
  └─ 201 { order, payment:{ paypalOrderId, clientId, currency } }
      │
      ▼
PayPal Buttons (JS SDK, sandbox client-id)          (browser)
  createOrder → returns the paypalOrderId above
  payer approves in PayPal
  onApprove({orderID}) → POST /api/v1/payments/{orderId}/capture
      │
      ▼
capturePayment(orderId, paypalOrderId)              (our API)
  ├─ acquire advisory lock `payment:{orderId}` (30 s TTL)   → else 409 PAYMENT_IN_PROGRESS
  ├─ assert order.status ∈ {awaiting_payment, payment_failed} and paypalOrderId matches
  ├─ POST /v2/checkout/orders/{paypalOrderId}/capture  (body {})
  ├─ verifyCapture(order, response)  ← §4 (the only path to `paid`)
  ├─ apply: order.status=paid, stock committed, holds committed, cart→converted,
  │         soldCount++, attempt marked succeeded, analytics payment_captured
  └─ 200 { order, payment:{ captureId, amountVerified:true }, receipt }
```

---

## 2. PayPal client (`config/paypal.ts`)

```ts
const PAYPAL_BASE = env.PAYPAL_ENV === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';
```
| Concern | Implementation |
|---|---|
OAuth | `POST /v1/oauth2/token` (`grant_type=client_credentials`) with `client_id:secret` basic auth; cache the token in memory with a 60 s safety margin before `expires_in`; single-flight the refresh (a promise lock) so concurrent requests do not stampede. |
HTTP | `undici`/`fetch` with `connect 3 s`, `total 10 s`, `Content-Type: application/json`, `Prefer: return=representation`. |
Retries | Only for `429`/`5xx`/network, max 2, exponential backoff with jitter (250 ms, 750 ms), **always with the same `PayPal-Request-Id`**. Never retry a `4xx` business decline. |
Errors | PayPal error bodies (`{ name, message, details:[{ issue, description }] }`) are mapped to internal codes (§6) and stored on the attempt as `responseSnapshot` (PII stripped). |
Logging | Log `requestId` (ours), PayPal `debug_id`, endpoint, duration, HTTP status. Never log tokens, payer email, or the full auth header. |
Sandbox helpers | `PAYPAL_ENV=sandbox` and a startup assertion that fails the boot if `PAYPAL_CLIENT_ID` starts with a live-style prefix while `PAYPAL_ENV=sandbox` is set inconsistently (guards against accidental live charges). |

Required scopes on the sandbox app: `https://uri.paypal.com/services/payments/payment/authcapture` (plus `.../payments/refund` if refunds are enabled later).

---

## 3. Create order — request builder (`buildPayPalCreateRequest`)

Rules:
1. `amount.value` must equal `order.amounts.totalMinor` formatted with **exactly 2 decimals** (`(minor/100).toFixed(2)`), and `currency_code` must be `USD`.
2. Include the full `breakdown` — `item_total`, `tax_total`, `shipping` (omit `shipping` if 0? **No**: send `"0.00"` for explicitness) and any `discount`. PayPal rejects inconsistent breakdowns; the builder asserts `item_total + tax + shipping === value` before sending (throws `INTERNAL_AMOUNT_BUILDER` in dev, logs + alerts in prod).
3. `items[]`: one entry per order line — `name` (≤ 127 chars, truncated), `description` (≤ 127), `unit_amount`, `quantity` (string), `category: "PHYSICAL_GOODS"`, `sku`.
4. `purchase_units[0].custom_id` and `invoice_id` = our `orderNumber` (max 127 chars). This is how webhooks are matched back to our orders even if we lose the paypalOrderId mapping.
5. `application_context` (or the JS SDK equivalents): `brand_name: "ShopPilot AI (demo)"`, `shipping_preference: "GET_FROM_FILE"`, `user_action: "PAY_NOW"`, `landing_page: "LOGIN"` for sandbox convenience.
6. Idempotency: header `PayPal-Request-Id: pp:create:{orderId}:{attemptNo}` (≤ 108 chars, only `A–Z a–z 0–9 - _ .`; our ids are hex, safe). Deterministic ⇒ a retried create returns the same PayPal order.

---

## 4. Capture verification (`verifyCapture`) — the safety core

```ts
function verifyCapture(order: OrderDoc, res: PaypalCaptureResponse): VerifyResult
```
Checks, in order (all must pass):

| # | Check | Failure |
|---|---|---|
V1 | `res.status === 'COMPLETED'` | if `PENDING` → attempt `pending`, order stays `payment_processing`; otherwise `payment_failed` with `failureReason`
V2 | `res.purchase_units?.length ≥ 1` and `res.purchase_units[0].custom_id === order.orderNumber` (or the unit's `invoice_id` matches) | `VERIFY_MISMATCH`
V3 | capture object exists at `purchase_units[0].payments.captures[0]` | `VERIFY_MISMATCH`
V4 | `Number(capture.amount.value) * 100 === order.amounts.totalMinor` (integer compare after rounding; guard against scientific notation) | `VERIFY_MISMATCH`
V5 | `capture.amount.currency_code === order.amounts.currency` | `VERIFY_MISMATCH`
V6 | `capture.status === 'COMPLETED'` | `pending`/`failed` mapping
V7 | `capture.id` not already attached to a **different** order | `DUPLICATE_CAPTURE` → alert P1, do not mark paid

On success the service writes, in a **single Mongo transaction**:
1. `order.status = 'paid'`, `paidAt`, `payment.status='captured'`, `payment.paypalCaptureId=capture.id`, `payment.captureStatus`, `payment.amountVerified=true`, `payment.payerId`, `payment.payerEmailHash = sha256(payerEmail + PEPPER)`, `shippingAddress` (from `purchase_units[0].shipping` or `payer` when present).
2. `attempt.status='succeeded'`, `captureId`, `verified=true`, `verifyChecks`, `responseSnapshot`.
3. For each line: atomic `products.findOneAndUpdate({_id, stock:{$gte: qty}}, {$inc:{stock:-qty, soldCount:+qty}})`; if any line fails → abort the transaction, mark order `payment_failed` with `failureReason='STOCK_COMMIT_FAILED'`, and **queue a manual refund task** (documented, `POST /admin/orders/{id}/refund`) — the money is real, the goods are not.
4. Holds → `committed`; cart → `converted`; `order.timeline` append; analytics `payment_captured`.

**Verification failures never throw into a generic 500.** They produce `409 PAYMENT_VERIFICATION_FAILED` with `details.checks`, log at `error` with `requestId` + `paypalDebugId`, and increment `payments_verify_mismatch_total`.

---

## 5. Frontend integration (JS SDK)

```ts
// components/checkout/PayPalButtonsHost.tsx  (client-only, dynamically imported)
const sdkUrl = `https://www.paypal.com/sdk/js?client-id=${env.NEXT_PUBLIC_PAYPAL_CLIENT_ID}` +
               `&currency=USD&intent=capture&components=buttons&enable-funding=venmo&disable-funding=credit`;

paypal.Buttons({
  style: { layout:'vertical', shape:'pill', color:'gold', label:'paypal', height:48 },
  createOrder: () => currentPaypalOrderId,                  // already created by OUR server
  onApprove: async ({ orderID }) => {
    const res = await api.capturePayment(orderId, { paypalOrderId: orderID }); // → our API
    if (res.ok) router.replace(`/orders/${orderId}/confirmation`);
    else handleCaptureError(res);                            // §6
  },
  onCancel:   () => setUiState('cancelled'),
  onError:    (err) => { log(err); setUiState('failed'); },
}).render('#paypal-buttons');
```
* The SDK is loaded **only** on the checkout route, after approval, from the official `paypal.com` origin, with `data-namespace="spPaypal"` to avoid collisions.
* Config: `currency=USD`, `intent=capture`; `components=buttons` keeps the payload small (no card fields — card data never touches our origin).
* `INSTRUMENT_DECLINED` handling: call `actions.restart()` so PayPal re-opens the funding-source chooser; our order is untouched.
* If the SDK fails to load (ad-blocker/offline), show the `RetryPaymentPanel` with a plain `Try again` that re-mounts the SDK and a `Back to cart` escape.
* Never render the button before `payment.paypalOrderId` exists, and never for an order that is already `paid`.

---

## 6. Failure matrix (source of truth for UI states)

| PayPal situation | Detection | `attempt.status` | `order.status` | HTTP + code | UI | Retry allowed |
|---|---|---|---|---|---|---|
Payer cancels/closes PayPal | `onCancel` (no API error) | `cancelled` | `awaiting_payment` | `200` on cancel endpoint / none | "Payment cancelled. Still reserved for mm:ss." | yes (new attempt)
Card/bank decline | capture response `status: DECLINED` or issue `INSTRUMENT_DECLINED` | `failed` | `payment_failed` | 402 `PAYMENT_DECLINED` | decline panel + `actions.restart()` | yes
Insufficient funds | issue `INSUFFICIENT_FUNDS` | `failed` | `payment_failed` | 402 `PAYMENT_INSUFFICIENT_FUNDS` | hint: try another funding source | yes
eCheque / bank review | `capture.status === 'PENDING'` | `pending` | `payment_processing` | 202 `PAYMENT_PENDING` | "still processing", poll every 10 s ×12 | no (poll instead)
Payer authentication required | `PAYER_ACTION_REQUIRED` | `awaiting_approval` | `awaiting_payment` | 409 `PAYER_ACTION_REQUIRED` | re-present the button | yes
Order already captured (same attempt) | issue `ORDER_ALREADY_CAPTURED` + our DB already `paid` with same capture id | `succeeded` | `paid` | 200 + `Idempotent-Replay: true` | success (no double charge) | —
Order already captured (unknown state) | same issue, our DB not `paid` | `unknown` → recon | after recon: `paid` | 409 `ORDER_ALREADY_CAPTURED` then 200 on re-poll | "Confirming…" then success | —
PayPal order voided/expired | `GET /v2/checkout/orders/{id}` → `VOIDED`/404 | `failed` | `payment_failed` | 409 `PAYPAL_ORDER_INVALID` | re-create attempt (`POST /payments/{id}/retry`) | yes
Network timeout / PayPal 5xx | fetch error / 5xx after retries | `unknown` (kept alive) | `payment_processing` | 503 `PAYMENT_PROVIDER_UNAVAILABLE` | "We'll confirm shortly", poll `/payments/{id}/status` | no (recon decides)
Amount/currency mismatch on capture | V4/V5 fail | `failed` | `payment_failed` | 409 `PAYMENT_VERIFICATION_FAILED` | danger panel, "Reference {requestId}" | manual support
Duplicate capture id on another order | V7 fail | `failed` | unchanged | 409 `DUPLICATE_CAPTURE` | support | no
Hold expired before capture | order `expiresAt < now` | `failed` | `expired` | 409 `HOLD_EXPIRED` | re-checkout with fresh quote | yes (re-quote)
Quote stale (price moved) | `quoteHash` mismatch | `failed` | `awaiting_payment` (void PayPal order) | 409 `QUOTE_STALE` | price-diff + re-approve | yes (re-quote)
Stock commit failed after capture | transaction abort | `succeeded` + flag | `payment_failed (STOCK_COMMIT_FAILED)` | 409 | "Paid but item unavailable — we're refunding you" | support flow
Max attempts reached (3) | attempt count | `failed` | `payment_failed` | 409 `PAYMENT_ATTEMPT_LIMIT` | support CTA, cart preserved | no

---

## 7. Webhooks

Endpoint: `POST /api/v1/webhooks/paypal` (mounted with `express.raw({type:'application/json'})` so the exact bytes are available for signature verification; no session, no CSRF, no auth).

Verification steps:
1. Read headers `paypal-transmission-id`, `paypal-transmission-time`, `paypal-cert-url`, `paypal-auth-algo`, `paypal-transmission-sig`.
2. `POST /v1/notifications/verify-webhook-signature` with `{ auth_algo, cert_url, transmission_id, transmission_sig, transmission_time, webhook_id: env.PAYPAL_WEBHOOK_ID, webhook_event }`.
3. Require `verification_status === 'SUCCESS'`. Otherwise: log `webhook_signature_invalid`, return `200` (so PayPal does not retry forever) but record `signatureVerified:false`.
4. Deduplicate on `event.id` (unique index on `webhook_events`) → duplicate returns `200 { deduplicated: true }`.
5. Route by `event_type`:

| Event | Action |
|---|---|
`CHECKOUT.ORDER.APPROVED` | Update attempt → `approved`; **never** marks the order paid (approval ≠ capture). No side effects beyond the timeline. |
`PAYMENT.CAPTURE.COMPLETED` | Find the order by `resource.custom_id`/`invoice_id` or `resource.id` (capture id) → if our order is not `paid`, run `verifyCapture` against the resource and apply (idempotent). Covers the "capture succeeded but our write failed" case. |
`PAYMENT.CAPTURE.DENIED` | attempt → `failed`, order → `payment_failed` **only if** it is not already `paid` (never downgrade a paid order from a webhook). |
`PAYMENT.CAPTURE.REFUNDED` / `REVERSED` | order → `refunded`, store refund id/amount; stock is **not** restored automatically (admin decision). |
`PAYMENT.CAPTURE.PENDING` | attempt → `pending`; leave order in `payment_processing`. |

6. Store the raw event with `signatureVerified`, `processingResult ∈ {applied, ignored, error, duplicate}` and `error` text. Errors return `200` (already stored) but raise an alert; a replay tool exists: `pnpm job:replay-webhooks --since=1h`.

Local development: `ngrok http 4000` → set the tunnel URL + `/api/v1/webhooks/paypal` in the sandbox app's Webhooks page → copy the generated **Webhook ID** into `PAYPAL_WEBHOOK_ID` (required for verification).

---

## 8. Reconciliation job

`apps/api/src/jobs/reconcilePayments.ts` — every 5 minutes:
1. Orders with `status: payment_processing` and `updatedAt < now − 2 min` → `GET /v2/checkout/orders/{paypalOrderId}`.
2. `COMPLETED` → `verifyCapture` + apply (idempotent, same function as webhooks).
3. `VOIDED` / `PAYER_ACTION_REQUIRED` / 404 → attempt `failed`, order `payment_failed`, release holds.
4. Attempts in `pending` older than 24 h → mark `failed` with `failureReason='TIMEOUT'` and notify.
5. Orders in `awaiting_payment` past `expiresAt` → `expired`, holds released, PayPal order voided (`POST /v2/checkout/orders/{id}/void` — best effort).
6. Emits metric `reconciled_orders_total{outcome}` and an audit log line per change.

A daily job re-checks all `paid` orders from the last 7 days for a capture id (integrity assertion I3 from `docs/data_model.md`) and alerts on any violation.

---

## 9. Test plan (see `docs/testing_strategy.md` for the harness)

| Test | Type | Asserts |
|---|---|---|
`createOrderPayload.matchesOrder` | unit | breakdown sums, 2-decimal strings, `custom_id`, item count, quantity strings |
`deterministicRequestId` | unit | same order+attempt → same `PayPal-Request-Id`; different attempt → different |
`captureHappyPath` | contract (nock fixture) | order → `paid`, stock decremented, holds committed, analytics emitted |
`captureDeclined` | contract | `payment_failed`, stock unchanged, retry allowed |
`capturePendingThenWebhook` | contract + integration | `payment_processing` → webhook `COMPLETED` → `paid` |
`captureIdempotentReplay` | integration | two identical capture calls → one capture id, 200 + replay header |
`concurrentCapture` | integration | two parallel calls → exactly one PayPal capture call, other gets 409 then same final state |
`amountMismatchBlocked` | contract | V4 failure → no `paid`, alert metric incremented |
`webhookSignatureInvalid` | integration | stored with `signatureVerified:false`, no state change |
`webhookDuplicate` | integration | second identical event → `deduplicated: true`, single state transition |
`quoteStaleAtCheckout` | integration | price change between quote and approve → 409 `QUOTE_STALE`, PayPal order voided |
`holdExpiredAtCapture` | integration | 409 `HOLD_EXPIRED`, order `expired`, no PayPal call |
`reconRecoversPaid` | integration | simulate DB write failure, run job → order `paid` from PayPal truth |
`doubleClickApprove` | e2e (Playwright) | one order, one PayPal order, one capture |

Sandbox manual checklist (run before every demo): sandbox buyer with sufficient balance; a declined-card buyer; an e-cheque buyer (pending path); webhook tunnel alive; `PAYPAL_WEBHOOK_ID` matches the current tunnel URL.

---

## 10. Refunds (documented, not in the v1 UI)

`POST /api/v2/checkout/orders/{id}/capture` is irreversible from our side except via refunds: `POST /v2/payments/captures/{captureId}/refund` with `{ amount, currency_code, note_to_payer }` and `PayPal-Request-Id: pp:refund:{captureId}`. Only an admin endpoint `POST /admin/orders/{orderId}/refund` performs it; the webhook `PAYMENT.CAPTURE.REFUNDED` is the authoritative confirmation. The ops runbook scenario is: `STOCK_COMMIT_FAILED` after capture, and merchant cancellation of a paid order.

---

## 11. Compliance notes for the demo

* No real money: sandbox only; the footer discloses it; startup asserts the sandbox base URL matches `PAYPAL_ENV`.
* No card data: funding instruments are entered in PayPal's own hosted flow; our CSP does **not** allow script from card processors.
* Record keeping: `webhook_events` + `payment_attempts.responseSnapshot` (PII-stripped) give an auditable trail of every state change; `orders.timeline` gives the business-readable history.
* PII: payer email is stored only as a salted hash for support correlation; the full address is stored only if PayPal returns one and only for fulfilment.
