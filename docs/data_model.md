# Data model & invariants

The reference build uses a file-backed document store (`app/server/store/store.mjs`) with Mongo-like
collections, indexes, guarded updates, TTL sweeps and single-writer transactions. Field names and
access patterns are designed so a real Mongo driver can implement the same surface. The bundled
`mongo.driver.mjs` is a stub: setting `MONGO_URI` refuses to boot rather than silently pretending to
persist.

Default file: `app/.data/db.json` (override with `DATA_DIR`). Local state is gitignored.

## Collections

| Collection | Purpose | Key indexes / rules |
|---|---|---|
| `users` | Guest/customer/merchant/admin identities | unique sparse `emailLower`; passwords stored as salted hashes |
| `sessions` | Server-side sessions | `expiresAt` TTL; owns guest cart/orders |
| `refresh_tokens` | Rotating refresh tokens where issued | unique `tokenHash`, `expiresAt` |
| `merchants` | Seller profiles/payee configuration | unique `slug` |
| `categories` | Catalogue categories + attribute schemas | unique `slug` |
| `products` | Sellable items, price, stock, status | unique `slug`; unique `(sku, merchantId)` |
| `price_history` | Merchant price/stock changes | `(productId, createdAt)` |
| `carts` | Active/converted carts | `(sessionId, status)`, `(userId, status)`; guest = session-keyed, user = user-keyed |
| `quotes` | Server-priced totals + hash + holds | `(cartId, status)`, `expiresAt` |
| `orders` | Order snapshot, amounts, payment state, timeline | unique `orderNumber`, sparse unique PayPal order/capture ids and idempotency key |
| `payment_attempts` | One row per capture attempt | unique `(orderId, attemptNo)`, sparse unique `captureId`/idempotency key |
| `inventory_holds` | TTL stock reservations | `(orderId, status)`, `(productId, status)` |
| `analytics_events` | Allow-listed product/payment events | unique `eventId`, `(name, ts)`, sparse unique `dedupeKey` |
| `webhook_events` | PayPal event dedupe/audit | unique `eventId`; stores verification/processing result |
| `idempotency_keys` | Replay-safe mutation results | unique `scopeKey`, `expiresAt` |
| `chat_messages` | Session transcript | `(sessionId, createdAt)` |
| `counters` | Order-number sequences | unique `_id`; reset-prone on ephemeral disks |

## Ownership

- Guest cart/order owner: `{ sessionId, userId: undefined }`.
- Signed-in customer cart/order owner: `{ sessionId, userId }`.
- The HTTP layer, agent tools and order creation all normalise guest identity the same way.
- Merchant reads are scoped to products/lines they own; admin has explicit oversight paths.
- Cross-tenant order reads return 404 rather than revealing existence.

## Order state machine

```text
awaiting_payment → payment_processing → paid → partially_refunded / refunded
awaiting_payment → expired / cancelled
payment_processing → payment_failed → payment_processing (retry)
paid → shipped → completed (fulfilment)
```

Only `PaymentService.applyCapture` may write `status: paid`, and only after `verifyCapture` passes.
Stock commit and the paid transition happen in one store transaction; a stock failure leaves the order
unpaid/flagged for support rather than paid with no goods.

## Money rules

- All amounts are integer USD cents. No floating-point money arithmetic.
- `totalMinor = subtotalMinor + shippingMinor + taxMinor`.
- Tax is `round(subtotalMinor × taxRateBps / 10000)`; demo rate is 825 bps (8.25%).
- Split settlement apportionment preserves the exact total using largest-remainder rounding.
- Quote hashes freeze the reviewed price; a mismatch at order/capture time is `QUOTE_STALE`.
- PayPal `invoice_id = orderNumber[-referenceId]-orderId` is globally unique across store reseeds;
  `custom_id = orderNumber[:referenceId]` remains the correlation key.

## Ledger invariants

`npm run ledger` checks the current store and exits non-zero on violations:

| ID | Invariant |
|---|---|
| I1–I2 | Order totals equal lines + shipping + tax; tax matches the configured rate |
| I3 | No paid order lacks a verified PayPal capture id |
| I4 | Stock is never negative; active holds never exceed stock |
| I5 | Cart subtotals always equal live catalogue prices |
| I6 | Payment attempts are contiguous per order and never orphaned |
| I7 | Order numbers, capture ids, slugs and event ids are unique |
| I8 | No order remains in `payment_processing` beyond the stuck threshold |
| I9 | Analytics props contain no PII keys |
| I10 | Discovery funnel is monotonic (views ≥ adds ≥ checkout attempts ≥ purchases) |
| extra | Available-to-sell is never negative |

## Seed data

`data/seed.catalog.json` contains 24 products, 3 merchants and 4 categories. `app/scripts/seed-lib.mjs`
seeds catalogue, demo users, historical orders and synthetic analytics. Seeding is idempotent and never
calls PayPal; payment-routed demo orders are an explicit simulator-only opt-in. On Render,
`SEED_ON_BOOT=true` seeds only when the store is empty.

## Retention & privacy

Sessions, refresh tokens, quotes, holds and idempotency records have TTL fields swept by the scheduler.
Analytics uses a strict event/prop allow-list and rejects PII. Payment snapshots are stripped before
storage/API exposure. See [security_privacy.md](security_privacy.md).
