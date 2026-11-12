# PayPal payments integration

PayPal Orders v2, sandbox-first. Anything that touches money is server-side. The browser only renders
PayPal's SDK and calls our API; the AI agent has no payment tool.

Implementation:

- `app/server/payments/paypal.gateway.mjs` — simulator + real sandbox client, payload builders,
  webhook signature verification.
- `app/server/payments/settlement.mjs` — pure multi-seller settlement plan + verification.
- `app/server/services/payment.service.mjs` — the only service allowed to write `status: paid`.
- `app/server/http/routes.mjs` — `/orders`, `/payments/*`, `/webhooks/paypal`, merchant refund,
  admin reconcile.

## Modes

| `PAYPAL_MODE` | Behaviour |
|---|---|
| `simulator` | In-process PayPal simulator. No credentials or network. Used by tests and offline demo. |
| `sandbox` | Real PayPal sandbox (`https://api-m.sandbox.paypal.com`). Requires client id/secret. |

`PAYPAL_API_BASE_URL` can point the real client at a local fake for contract tests. Live PayPal is not
a demo target; production boot checks discourage accidental live credentials.

## Happy path

```text
Shopper checkout
  → POST /api/v1/checkout/quote          (server prices, holds, quoteHash)
  → POST /api/v1/orders                  (draft order + PayPal order create)
  → PayPal SDK approval                  (human approves in PayPal)
  → POST /api/v1/payments/:orderId/capture
  → verifyCapture V1–V8
  → applyCapture: paid, stock committed, holds committed, cart converted
```

Create order:

- `intent: CAPTURE`.
- One `purchase_units[]` entry per settlement unit.
- `custom_id = orderNumber` or `orderNumber:referenceId` for split units.
- `invoice_id = orderNumber[-referenceId]-order._id` (≤127 chars). The internal order id prevents
  `DUPLICATE_INVOICE_ID` collisions after an ephemeral-store reseed.
- `amount.value` is integer cents formatted to two decimals; breakdown must sum exactly.
- `payment_source.paypal.experience_context` carries brand, locale, `return_url`, `cancel_url`,
  `user_action: PAY_NOW`, and shipping preference.
- `PayPal-Request-Id` makes create/capture retries idempotent.

Capture:

- Per-order in-process lock prevents concurrent capture.
- The server calls PayPal capture, then verifies the **full order response** before any paid state.
- A duplicate capture on an already-paid order is an idempotent replay, not a second charge.
- `POST /payments/:orderId/retry` creates a new attempt on the same order when retry is allowed.
- `GET /payments/:orderId/status` is the poll endpoint.

## Multi-seller settlement

A basket can contain lines from several merchants. `settlementPlan()` groups lines by seller and
apportions subtotal, tax and shipping with largest-remainder integer math so the units sum exactly to
the order total.

Each split unit carries:

- `reference_id` (`m1`, `m2`, …) — required when there is more than one unit.
- `payee.email_address` (and optional `merchant_id`) from a confirmed sandbox business account.
- Optional `payment_instruction.platform_fees` for ShopPilot commission (`PLATFORM_FEE_BPS`).
- `disbursement_mode` from `PAYPAL_DISBURSEMENT_MODE` (`INSTANT` or `DELAYED`).

Seeded `@sandbox.demo` payees are illustrative placeholders and are never used as real split
recipients. Configure real sandbox business payees with `PAYPAL_PAYEE_<SLUG>` (for example
`PAYPAL_PAYEE_VERTEX_SYSTEMS`) or a merchant record payee.

`PAYPAL_SETTLEMENT`:

| Value | Behaviour |
|---|---|
| `split` | Require split settlement; fail if it cannot be built. |
| `single` | One purchase unit addressed to the API caller/platform. |
| `auto` | Try split + fees, then honest fallbacks. |

`auto` fallback ladder:

1. Split + platform fees.
2. Split without fees if PayPal rejects only `platform_fees`.
3. Single unit if payees/capability are unsupported or allocation cannot reconcile.

Every downgrade is recorded on the order timeline and emitted as `payment_settlement_fallback` with a
reason such as `payee_not_configured`, `settlement_plan`, `capability_unsupported`,
`platform_fees_unsupported`. The UI shows the actual settlement mode; it never pretends a split
happened.

## Capture verification (V1–V8)

`verifyCapture(order, response)` returns checks; all must pass before `applyCapture`.

| Check | Meaning |
|---|---|
| V1 `statusOk` | PayPal order/capture status is completed or pending |
| V2 `orderRefOk` | `custom_id`/`invoice_id` references this order (split units match by order-number prefix) |
| V3 `captureExistsOk` | A capture id exists |
| V4 `amountOk` | Captured amount equals order total; split sums every unit |
| V5 `currencyOk` | Currency matches the order |
| V6 `captureStatusOk` | Capture is `COMPLETED` (pending is handled separately) |
| V7 `uniqueOk` | Capture id is not already owned by another order |
| V8 `settlementOk` | Split order has every planned unit, exact amount, intended payee, completed capture, no extra units |

Pending captures leave the order in `payment_processing`. Verification failure never marks paid.
`applyCapture` persists the capture(s), per-unit merchant/payee mapping, `verifyChecks`,
`amountVerified`, payer id and hashed payer email. Stock commit failure after capture marks
`STOCK_COMMIT_FAILED` and enters the refund/support path rather than leaving a paid order with no
goods.

## Webhooks

Endpoint: `POST /api/v1/webhooks/paypal`.

- Mounted with a raw body so the exact bytes can be verified.
- No session/CSRF; trust comes from PayPal signature verification.
- Requires `PAYPAL_WEBHOOK_ID` and the PayPal transmission headers.
- Calls PayPal `verify-webhook-signature`; only `SUCCESS` is trusted.
- Missing headers, missing webhook id, invalid signature or verification errors are stored as
  unverified and answered **200** so PayPal does not retry forever. They never change payment state.
- Events are deduplicated by `event.id`; one in-flight pass per event id.

Handled events:

| Event | Action |
|---|---|
| `CHECKOUT.ORDER.APPROVED` | Mark attempt approved; never marks paid |
| `PAYMENT.CAPTURE.COMPLETED` | Fetch full PayPal order, run V1–V8, apply under lock |
| `PAYMENT.CAPTURE.DENIED` | Fail attempt/order only if not already paid |
| `PAYMENT.CAPTURE.PENDING` | Leave order processing |
| `PAYMENT.CAPTURE.REFUNDED` / `REVERSED` | Record refund/reversal; stock is not auto-restored |

The single capture resource in a webhook is never trusted as the whole payment for a split order.

## Reconciliation & expiry

- A maintenance tick every 60s expires stale orders/holds and sweeps TTL collections.
- A reconciliation job every 5 minutes checks stuck `payment_processing` orders against PayPal.
- Admins can force reconciliation: `POST /api/v1/admin/orders/:orderId/reconcile`.
- Simulator-only dev helpers (`/api/v1/dev/*`) exist for local tests and are disabled in production.

There is no separate webhook replay CLI in this build; convergence comes from PayPal retries,
idempotent event processing and reconciliation.

## Refunds

Refunds are merchant-scoped:

- `POST /api/v1/merchant/orders/:orderId/refund` (merchant, or admin with `?merchantId=`).
- On a split order, a merchant refunds only the captures belonging to their seller and their amount.
- Admin/platform refund can cover all refundable captures.
- Already-refunded captures are skipped.
- The PayPal refund API is called server-side; webhook confirmation is authoritative.

## Failure mapping (UI source of truth)

| Situation | Order/attempt outcome | HTTP/code | UI |
|---|---|---|---|
| Decline / insufficient funds | `payment_failed` | 402 `PAYMENT_DECLINED` / `PAYMENT_INSUFFICIENT_FUNDS` | Retry with another funding source |
| Payer action / not approved | attempt failed, order retryable | 402 `PAYER_ACTION_REQUIRED` | Approve in PayPal |
| Cancelled | attempt cancelled, order awaiting | 200/cancel flow | Still reserved, retry |
| Pending capture | `payment_processing` | 202 `PAYMENT_PENDING` | Poll status |
| Already captured / duplicate invoice | unknown → reconcile; never false failed | 409 `ORDER_ALREADY_CAPTURED` | “Already paid — confirming” |
| Provider unavailable / timeout | `payment_processing` / unknown | 503 `PAYMENT_PROVIDER_UNAVAILABLE` | We’ll confirm shortly |
| Amount/currency/settlement mismatch | not paid | 409 `PAYMENT_VERIFICATION_FAILED` | Support reference |
| Duplicate capture on another order | not paid | 409 `DUPLICATE_CAPTURE` | Support |
| Hold expired | `expired` | 409 `HOLD_EXPIRED` | Re-quote |
| Quote stale | order not created/voided | 409 `QUOTE_STALE` | Re-approve new price |
| Stock commit failed after capture | `payment_failed` + `STOCK_COMMIT_FAILED` | 409 `ITEM_UNAVAILABLE` | Refund/support |
| Attempt limit | `payment_failed` | 409 `PAYMENT_ATTEMPT_LIMIT` | Support |

## Manual sandbox probes

```bash
cd app
npm run paypal:check                         # OAuth + create order + approval URL
npm run paypal:check -- --capture <orderId>  # after buyer approval: capture + verify
npm run paypal:settlement                    # multi-seller capability probe
npm run paypal:settlement -- --capture <id>  # after approval: per-seller captures
```

These create real sandbox orders. Use a Personal sandbox buyer with sufficient balance and a
confirmed address. For webhooks, expose the local server over HTTPS and register
`/api/v1/webhooks/paypal` in the PayPal sandbox app; copy the generated webhook id into
`PAYPAL_WEBHOOK_ID`.

## Compliance notes

- Sandbox only for demos; no live keys in the repository.
- No card data touches the app; funding instruments are entered in PayPal-hosted surfaces.
- Payment attempts, webhook events and order timelines provide an auditable trail.
- Payer email is stored only as a peppered hash for correlation; full shipping address is stored only
  when needed for fulfilment.
