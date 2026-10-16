# ShopPilot AI — Data Model & Persistence

MongoDB 8 + Mongoose 8. Companion: `data/seed.catalog.json`, `docs/api_spec.md`, `docs/payments_paypal.md`.

**Global rules**
* Money: integer **minor units** (`priceMinor`, `*Minor`) + `currency: "USD"`. No `Number` floats, no `Decimal128` needed for USD cents.
* Every collection has `createdAt`/`updatedAt` (`timestamps: true`) and `schemaVersion` where a migration may be needed.
* All object ids referenced via `ObjectId` refs; response DTOs serialise ids as strings.
* Mongo must run as a **replica set** (single-node in dev) — transactions are used in the money path.
* Indexes below are mandatory; the seed script calls `syncIndexes()` and fails the build if an index is missing.

---

## 1. Collection overview

| Collection | Purpose | Growth |
|---|---|---|
`sessions` | guest/customer session + chat session + requirement state | per visitor
`users` | customers, merchants, admins | small
`refresh_tokens` | rotating refresh tokens per device | small
`merchants` | store records | 3 seeded
`categories` | tree | 4 seeded
`products` | catalogue | 24 seeded
`price_history` | audit of price/stock changes | append-only
`carts` | one active cart per session/user | per visitor
`quotes` | price breakdowns with TTL | per checkout
`orders` | orders + snapshots + payment summary | per purchase
`payment_attempts` | one row per PayPal attempt | per attempt
`inventory_holds` | soft reservations with TTL | short-lived
`analytics_events` | product/chat/checkout events | high volume
`webhook_events` | raw PayPal webhook log + dedupe | moderate
`idempotency_keys` | request replay protection | TTL 24 h
`locks` | short-lived advisory locks (payments) | tiny, TTL
`counters` | order-number sequence | tiny
`chat_messages` | full chat transcript (transcript also embedded as summaries on session) | high

---

## 2. Schemas

### 2.1 `users`
```ts
{
  _id: ObjectId,
  role: 'guest' | 'customer' | 'merchant' | 'admin',
  email?: string,                 // unique sparse; absent for guests
  emailLower?: string,            // unique sparse index
  passwordHash?: string,          // argon2id; absent for guests
  displayName?: string,
  merchantId?: ObjectId,          // required when role === 'merchant'
  sessionUpgradedFrom?: ObjectId, // guest session id, for cart/order claim
  addresses: [{ label, line1, line2?, city, state, postalCode, country, isDefault }],
  prefs: { theme: 'system'|'light'|'dark', marketingOptIn: boolean },
  status: 'active' | 'disabled',
  lastSeenAt: Date
}
```
Indexes: `{ emailLower: 1 }` unique sparse · `{ role: 1, merchantId: 1 }` · `{ lastSeenAt: -1 }`.
Guests are real rows (`role: 'guest'`, no email/password) so carts/orders/sessions always have an owner. Job `pruneGuests` deletes guests with no orders and `lastSeenAt` older than 90 days.

### 2.2 `sessions`
```ts
{
  _id: ObjectId,                  // = sid cookie value (random 32 bytes, base64url)
  userId: ObjectId,               // owner (guest or customer)
  kind: 'guest' | 'user',
  userAgent?: string, ipHash?: string,
  cartId?: ObjectId,
  chat: {
    requirement: Requirement,     // §2.14
    requirementRevision: number,  // starts at 1
    lastCandidateProductIds: ObjectId[],
    attachedProductIds: ObjectId[],
    summary?: string,             // rolling summary of older turns
    messageCount: number,
    lastMessageAt?: Date
  },
  expiresAt: Date,                // TTL index; guest 30d, user 30d sliding
  revokedAt?: Date
}
```
Indexes: `{ expiresAt: 1 }` TTL(0) · `{ userId: 1 }` · `{ 'chat.lastMessageAt': -1 }`.

### 2.3 `refresh_tokens`
```ts
{ _id, userId, tokenHash: string, familyId: string, userAgentHash?, expiresAt, revokedAt?, replacedBy? }
```
Indexes: `{ tokenHash: 1 }` unique · `{ expiresAt: 1 }` TTL · `{ userId: 1, revokedAt: 1 }`.
Rotation: on refresh, mark old revoked and link `replacedBy`; reuse of a revoked token revokes the whole `familyId` (theft detection).

### 2.4 `merchants`
```ts
{
  _id, name, slug (unique), logoUrl?, supportEmail, supportPhone?,
  payoutEmail?,              // informational in v1
  policies: { shippingNote?, returnDays: number, warrantyNote? },
  ratingAvg: number, ratingCount: number,
  status: 'active' | 'suspended'
}
```

### 2.5 `categories`
```ts
{
  _id, name, slug (unique), parentId?: ObjectId, order: number,
  attributeSchema: [{                    // drives ProductForm + agent filters
    key: string,                         // 'ramGb'
    label: string,                       // 'RAM (GB)'
    type: 'number'|'string'|'boolean'|'enum',
    unit?: string, filterable: boolean, comparable: boolean, rank: number,
    enumValues?: string[], higherIsBetter?: boolean, typicalMin?: number, typicalMax?: number
  }],
  status: 'active' | 'archived'
}
```
The `attributeSchema` is the **contract** the agent relies on: only keys here may appear in `products.attributes`, and only `filterable: true` keys may be used in hard constraints. Seeded schemas: laptops, phones, headphones, monitors.

### 2.6 `products`
```ts
{
  _id, title, slug (unique), brand, sku, merchantId, categoryId,
  priceMinor: number, compareAtPriceMinor?: number, currency: 'USD',
  stock: number,                          // authoritative available units
  attributes: Record<string, number|string|boolean>,   // typed, from categorySchema
  specs: [{ group: string, key: string, label: string, value: string }],
  pros: string[], cons: string[],         // curated, verified copy
  badges?: ('bestseller'|'new'|'price_drop'|'editor_pick')[],
  images: [{ url: string, alt: string, blurHash?: string }],
  description: string, shortDescription: string,
  warrantyMonths: number, returnDays: number,
  ratingAvg: number, ratingCount: number,
  searchText: string,                     // denormalised: title+brand+specs for text index
  status: 'draft' | 'active' | 'archived',
  soldCount: number,                      // incremented on capture
  archivedAt?: Date
}
```
Indexes:
* `{ slug: 1 }` unique, `{ sku: 1, merchantId: 1 }` unique
* `{ status: 1, categoryId: 1, priceMinor: 1 }`
* `{ stock: 1, status: 1 }` (low-stock + in-stock filters)
* Text: `{ searchText: 'text', title: 'text', brand: 'text', description: 'text' }` with weights `{ title: 10, brand: 4, searchText: 3, description: 1 }`
* Attribute filters use single-field indexes for the most common keys: `{'attributes.ramGb': 1}`, `{'attributes.storageGb': 1}`, `{'attributes.batteryWh': 1}`, `{'attributes.screenIn': 1}`, `{'attributes.weightG': 1}`, `{'attributes.cameraMp': 1}`, `{'attributes.noiseCancelling': 1}`.
* `{ merchantId: 1, status: 1, updatedAt: -1 }`

**Query translation contract** (used by `search_products` and `/products`): a filter key like `ramGb_gte` maps to `{ 'attributes.ramGb': { $gte: 16 } }` **only if** the category's `attributeSchema` marks `ramGb` filterable; otherwise the API returns `400 UNFILTERABLE_ATTRIBUTE`. `priceMinor_lte` maps to `priceMinor`. `inStock=true` → `stock: {$gt: 0}`. Sorts: `relevance` (text score), `price_asc`, `price_desc`, `rating`, `newest`, `stock_desc`.

### 2.7 `price_history`
```ts
{ _id, productId, merchantId, changedBy: ObjectId, changes: [{ field:'priceMinor'|'stock'|'status', from, to }], reason: 'merchant_edit'|'seed'|'system', createdAt }
```
Index: `{ productId: 1, createdAt: -1 }`.

### 2.8 `carts`
```ts
{
  _id, ownerType: 'session' | 'user', sessionId?, userId?,
  items: [{
    productId, merchantId, quantity, addedAt,
    priceAtAddMinor,                    // for "price changed" detection
    snapshot: { title, slug, imageUrl, brand }   // display without joins
  }],
  subtotalMinor: number,               // denormalised, recomputed on every write
  currency: 'USD',
  status: 'active' | 'converted' | 'abandoned',
  expiresAt: Date                      // TTL 30d for inactive carts
}
```
Indexes: `{ sessionId: 1, status: 1 }` unique partial on active · `{ userId: 1, status: 1 }` unique partial on active · `{ expiresAt: 1 }` TTL.
Invariants: `items.length ≤ 20`; `1 ≤ quantity ≤ 10` **and** `quantity ≤ product.stock`; `subtotalMinor === Σ unitPrice × qty` recomputed from live product prices on read **and** write (never trusted from client).

### 2.9 `quotes`
```ts
{
  _id, orderId?: ObjectId, cartId, sessionId,
  lines: [{ productId, merchantId, title, unitPriceMinor, quantity, lineTotalMinor, availableStock }],
  subtotalMinor, shippingMinor, taxMinor, totalMinor, taxRateBps: 825,
  currency: 'USD',
  shippingRuleApplied: 'free_over_500'|'standard'|'small_order'|'oversized_surcharge',
  warnings: [{ code: 'PRICE_CHANGED'|'LOW_STOCK'|'ITEM_UNAVAILABLE'|'QTY_REDUCED', productId?, message, fromMinor?, toMinor? }],
  hash: string,                        // sha256 of the money-relevant fields
  expiresAt: Date,                     // 15 min
  status: 'open'|'consumed'|'expired'|'stale'
}
```
Indexes: `{ cartId: 1, status: 1 }` · `{ expiresAt: 1 }` TTL · `{ orderId: 1 }`.
Rule: `POST /orders` and `POST /payments/*/capture` recompute the quote; if `hash` differs from the approved quote, the response is `409 QUOTE_STALE` with a `diff[]` and the client must re-approve.

### 2.10 `orders`
```ts
{
  _id, orderNumber: 'SP-2026-000123' (unique),
  userId, sessionId, merchantIds: ObjectId[],
  status: OrderStatus,                 // state machine §3
  lines: [{
    productId, merchantId, title, slug, imageUrl, brand,
    unitPriceMinor, quantity, lineTotalMinor, currency,
    attributesSnapshot: Record<string, any>,
    holdId?: ObjectId
  }],
  amounts: { currency:'USD', subtotalMinor, shippingMinor, taxMinor, totalMinor, taxRateBps: 825 },
  quoteId: ObjectId, quoteHash: string,
  contact: { email, phone?, name? },
  shippingAddress?: { name, line1, line2?, city, state, postalCode, country },  // filled from PayPal capture when provided
  payment: {
    provider: 'paypal',
    status: 'none'|'created'|'approved'|'pending'|'captured'|'failed'|'cancelled'|'refunded',
    paypalOrderId?: string,
    paypalCaptureId?: string,
    captureStatus?: 'COMPLETED'|'PENDING'|'DECLINED'|'FAILED',
    payerEmailHash?: string,
    payerId?: string,
    amountVerified: boolean,
    lastAttemptNo: number,
    capturedAt?: Date,
    failureReason?: string
  },
  idempotencyKey?: string,             // client key that created the order
  timeline: [{ at: Date, event: string, actor: 'system'|'user'|'merchant'|'paypal', meta?: object }],
  expiresAt?: Date,                    // hold expiry for awaiting_payment orders
  cancelledAt?, paidAt?, shippedAt?, deliveredAt?: Date
}
```
Indexes: `{ orderNumber: 1 }` unique · `{ userId: 1, createdAt: -1 }` · `{ sessionId: 1, createdAt: -1 }` · `{ status: 1, expiresAt: 1 }` (expiry job) · `{ 'payment.paypalOrderId': 1 }` sparse unique · `{ 'payment.paypalCaptureId': 1 }` sparse unique · `{ merchantIds: 1, status: 1, createdAt: -1 }` · `{ idempotencyKey: 1 }` sparse unique.

**Snapshot rule:** order lines never reference live product prices for display or math; they copy them at creation. `unitPriceMinor` on an order is immutable for the life of the order.

### 2.11 `payment_attempts`
```ts
{
  _id, orderId, attemptNo: number,     // 1-based, unique with orderId
  provider: 'paypal',
  idempotencyKey: string,              // deterministic, see payments doc
  paypalOrderId?: string,
  paypalOrderStatus?: 'CREATED'|'APPROVED'|'COMPLETED'|'VOIDED'|'PAYER_ACTION_REQUIRED',
  status: 'created'|'awaiting_approval'|'approved'|'capturing'|'succeeded'|'failed'|'pending'|'cancelled'|'unknown',
  amountMinor, currency,
  captureId?: string,
  captureStatus?: string,
  verified?: boolean,
  verifyChecks?: { statusOk: boolean, amountOk: boolean, currencyOk: boolean, orderRefOk: boolean },
  failureReason?: 'INSTRUMENT_DECLINED'|'INSUFFICIENT_FUNDS'|'PAYER_ACTION_REQUIRED'|'CANCELED'|'NETWORK'|'TIMEOUT'|'VERIFY_MISMATCH'|'UNKNOWN',
  requestSnapshotHash: string,         // sha256 of our request payload (no PII)
  responseSnapshot?: object,           // PII-stripped PayPal response (debug/audit)
  lockedUntil?: Date,
  createdAt, updatedAt
}
```
Indexes: `{ orderId: 1, attemptNo: 1 }` unique · `{ paypalOrderId: 1 }` sparse · `{ captureId: 1 }` sparse unique · `{ status: 1, updatedAt: 1 }` (recon job) · `{ idempotencyKey: 1 }` unique.

### 2.12 `inventory_holds`
```ts
{ _id, orderId, productId, merchantId, quantity, status: 'active'|'committed'|'released', createdAt, expiresAt }
```
Indexes: `{ expiresAt: 1 }` TTL partial (`status: 'active'`) · `{ orderId: 1, status: 1 }` · `{ productId: 1, status: 1 }`.
Semantics: a hold does **not** decrement `products.stock`; available-to-sell = `stock − Σ active holds`. Search and cart validate against available-to-sell. Commit (on capture) decrements `stock` and marks holds `committed`. Release (expiry/cancel/failure) marks `released`.

### 2.13 `analytics_events`
```ts
{
  _id, eventId: string (uuid, unique),  // client-supplied for client events, server-generated otherwise
  name: AnalyticsEventName,             // docs/analytics_spec.md
  ts: Date, sessionId?, userId?, merchantId?, productId?, orderId?,
  props: Record<string, string|number|boolean|null>,   // allow-listed per event
  source: 'client'|'server',
  dedupeKey?: string                    // e.g. `view:{sessionId}:{productId}:{hourBucket}`
}
```
Indexes: `{ eventId: 1 }` unique · `{ name: 1, ts: -1 }` · `{ productId: 1, name: 1, ts: -1 }` · `{ merchantId: 1, name: 1, ts: -1 }` · `{ ts: 1 }` TTL 180 days · dedupeKey partial unique.
Never contains PII. Writes are `insertMany` with `ordered:false` and `w:1`; failures are logged, never thrown into the request path.

### 2.14 `Requirement` (embedded value object — shared package)
```ts
type Requirement = {
  revision: number,
  categorySlug?: string,
  categoryId?: ObjectId,
  budgetMinor?: number,          // hard cap
  budgetFlexBps?: number,        // default 300 (3% grace), per PRD policy
  hardConstraints: Array<
    | { kind: 'attribute', key: string, op: 'gte'|'lte'|'eq'|'in', value: number|string|boolean|string[], label: string }
    | { kind: 'inStock', value: true }
    | { kind: 'merchant', merchantId: ObjectId }
    | { kind: 'warrantyMonths', op: 'gte', value: number }
  >,
  softPreferences: Array<{ key: string, weight: number /*0..1*/, label: string, direction: 'higher_better'|'lower_better' }>,
  useCase?: string,
  quantity: number,
  assumptions: string[],
  updatedAt: Date
}
```
Constraints must reference `attributeSchema.filterable === true` keys — the agent tool validates this and returns a corrective error rather than silently dropping a constraint.

### 2.15 `chat_messages`
```ts
{
  _id, sessionId, userId?, role: 'user'|'assistant'|'system'|'tool',
  content: string,
  ui?: Array<{ type: 'product_cards'|'comparison'|'cart_summary'|'checkout_card'|'order_status', payload: object }>,
  requirementRevision?: number,
  toolCalls?: [{ name, args, resultSummary, status, durationMs }],
  superseded?: boolean,
  stopped?: boolean,
  tokens?: { in: number, out: number },
  createdAt
}
```
Index: `{ sessionId: 1, createdAt: 1 }` · `{ sessionId: 1, requirementRevision: 1 }`.

### 2.16 Support collections
```ts
// idempotency_keys
{ key: string, scope: 'user'|'session', ownerId, route, method, requestHash, status: 'in_progress'|'completed',
  responseBody?, responseStatus?, createdAt, expiresAt }
// index: { key: 1, route: 1, ownerId: 1 } unique ; { expiresAt: 1 } TTL 24h

// webhook_events
{ eventId: string (PayPal event id), type, resourceType, orderId?, payload: object, signatureVerified: boolean,
  processedAt?, processingResult: 'applied'|'ignored'|'error'|'duplicate', error?, receivedAt }
// index: { eventId: 1 } unique ; { type: 1, receivedAt: -1 }

// locks
{ _id: string /* e.g. `payment:{orderId}` */, holder: string /* instance id */, acquiredAt, expiresAt }
// index: { expiresAt: 1 } TTL 0

// counters
{ _id: 'orderNumber', seq: number }   // findOneAndUpdate $inc, padded to 6 digits
```

---

## 3. State machines (authoritative)

### 3.1 Order
```
draft ──createPaymentOrder──► awaiting_payment ──captureStart──► payment_processing
  │                                │  ▲                                   │
  │                                │  └────retry───── payment_failed ◄─────┤ verify fail
  │                                │                      │                │ verify ok ─► paid
  │ cancel                         │ cancel               │ cancel         │
  ▼                                ▼                      ▼                ▼
cancelled ◄────────────────────────┴──────────────────────┘            processing ─► shipped ─► delivered
                                                                             │
awaiting_payment ──hold expired──► expired                                    └──refund──► refunded
```
Allowed transitions map (`packages/shared/src/orderState.ts`):
```ts
const ORDER_TRANSITIONS = {
  draft:              ['awaiting_payment', 'cancelled'],
  awaiting_payment:   ['payment_processing', 'cancelled', 'expired'],
  payment_processing: ['paid', 'payment_failed'],
  payment_failed:     ['payment_processing' /*retry*/, 'cancelled'],   // NOT 'paid' directly
  paid:               ['processing', 'refunded'],
  processing:         ['shipped', 'refunded'],
  shipped:            ['delivered'],
  delivered:          [],
  cancelled: [], expired: [], refunded: []
}
```
`payment_failed → paid` is **forbidden**: a new attempt must pass through `payment_processing`, which guarantees verification always runs.

### 3.2 Payment attempt
```
created ─► awaiting_approval ─► approved ─► capturing ─► succeeded
   │               │                │            │
   │               └─ cancel ──► cancelled       └─ pending ─► (recon) succeeded|failed
   └─ create fail ─► failed                       └─ failed
```

### 3.3 Inventory hold
`active → committed | released` (terminal).

---

## 4. Invariants & assertions (CI-enforced)

| # | Invariant | Test |
|---|---|---|
| I1 | `order.amounts.totalMinor === subtotal + shipping + tax` for every order | property test over seed catalog + random carts |
| I2 | `quotes.taxMinor === round(subtotal * 825 / 10000)` | unit |
| I3 | No order has `status: 'paid'` without `payment.captureId` and `payment.amountVerified === true` | integration + nightly DB check |
| I4 | `products.stock >= 0` always; committed holds never exceed stock | integration with concurrent capture |
| I5 | `cart.subtotalMinor` equals Σ(live unit price × qty) at read time | integration |
| I6 | Every `payment_attempts.orderId` has a corresponding order and `attemptNo` is contiguous from 1 | integration |
| I7 | Unique `orderNumber`, `slug`, `paypalCaptureId`, `idempotencyKey`, `analytics eventId` | index-based test |
| I8 | Orders older than 30 min in `payment_processing` == 0 (recon job converges) | job test |
| I9 | No PII keys in `analytics_events.props` | schema test |
| I10 | Superseded recommendations never appear in the current candidate set UI payload | agent eval |

---

## 5. Migrations & seeding

* Migrations: `scripts/migrations/NNN-name.ts`, each exporting `up()`/`down()`, run with `pnpm migrate`; log applied ids in `migrations` collection. v1 is seed-only.
* Seed (`scripts/seed.ts`): truncate + insert merchants (3), categories (4 with `attributeSchema`), products (24 from `data/seed.catalog.json`), demo users (`customer@demo.dev`, `merchant@demo.dev` / `Merchant@12345`), and optional `--demo-orders` (2 paid, 1 failed, 1 draft, 3 abandoned carts) plus synthetic analytics events so the dashboard is not empty.
* Reset: `pnpm seed:reset --demo-orders` must leave a DB where the README demo script reproduces exactly.
* Indexes: `pnpm db:indexes` runs `syncIndexes()` on all models and prints a diff; CI asserts no model is missing its declared indexes.

---

## 6. Retention & privacy

| Data | Retention | Notes |
|---|---|---|
Guest sessions/carts | 30 days (TTL) | no email stored
Chat messages | 180 days | summarised after 20 turns
Orders | 7 years (demo: forever) | legal/business record; snapshots
Payment attempts + webhook log | 2 years | PII-stripped; payer email hashed
Analytics events | 180 days (TTL) | no PII, per `docs/analytics_spec.md`
Refresh tokens | 30 days / revoked on rotation | hashed at rest
Deleted products | soft-delete (`archived`) | never break order history

Right-to-erasure (documented, admin-only in v1): anonymise `users` (email → `deleted+{id}@invalid`, name/address cleared) and `orders.contact`, keep financial records with anonymised identity, and drop `chat_messages` for that user.
