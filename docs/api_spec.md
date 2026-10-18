# ShopPilot AI — API Specification (v1)

Base path: `https://{api-host}/api/v1`. In dev, the web app proxies `/api/*` → Express so the browser sees one origin (`architecture.md` §1, mode B).

Machine-readable contracts: `contracts/openapi.yaml` (REST) and `contracts/agent_tools.json` (agent tools). This document is the human-readable source of truth; if the two disagree, fix this doc and regenerate.

---

## 1. Conventions

| Topic | Rule |
|---|---|
Auth | httpOnly cookie `sid` (session, guest or user) + `Authorization: Bearer <accessToken>` when signed in. Access JWT 15 min, refresh 30 d rotating.
Money | Integers in minor units: `{ "amountMinor": 87900, "currency": "USD" }`. Responses also include preformatted `"display": "$879.00"` for convenience — never use it for math.
IDs | 24-char hex strings; order numbers `SP-YYYY-NNNNNN`.
Dates | ISO 8601 UTC with `Z`.
Pagination | `?page=1&limit=20` (limit ≤ 100) → `{ items, page, limit, total, hasMore }`.
Errors | `{ error: { code, message, details?, requestId } }` with a stable `code` from §9.
Validation | Zod at the route boundary; unknown body keys are rejected with `400 VALIDATION_ERROR` and `details[]` field paths.
Idempotency | `Idempotency-Key: <uuid>` required on `POST /orders`, `POST /payments/{orderId}/capture`, `POST /cart/items`, `POST /checkout/quote`. Replays return the stored response with `Idempotent-Replay: true`.
CSRF | State-changing requests need `x-sp-csrf` matching the `csrf` cookie (double submit) **and** an allowed `Origin`.
Rate limits | Headers `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`; `429 RATE_LIMITED` with `Retry-After`.
Request id | `x-request-id` echoed on every response; client may supply one.
Versioning | Path-versioned (`/api/v1`); additive changes only within v1. Deprecations announced via `Sunset` header.

All examples below are abbreviated (no `createdAt` noise).

---

## 2. Session & auth

### POST `/session/guest`
Creates/returns the visitor session. Idempotent per cookie. Rate limit 30/15 min/IP.
```json
// 200
{ "user": { "id":"65f1…", "role":"guest" },
  "session": { "id":"s_g7…","kind":"guest","expiresAt":"2026-11-15T09:00:00Z" },
  "cart": { "id":"65f2…","itemCount":0,"subtotalMinor":0,"currency":"USD" } }
```
Sets cookies: `sid` (httpOnly, 30 d), `csrf` (readable).

### GET `/session/me`
Returns `{ user, session, cart, chat: { requirement, requirementRevision, lastCandidateProductIds } }`. Used on every app boot to render carts and chips without a second round trip.

### POST `/auth/register`
```json
// req
{ "email":"a@b.com", "password":"…", "displayName":"A" }
// 201
{ "user": { "id":"…","role":"customer","email":"a@b.com" },
  "tokens": { "accessToken":"…","expiresIn":900 },
  "cart": { "merged": true, "itemCount": 3, "addedQuantity": 2 } }
```
Errors: `400 WEAK_PASSWORD`, `409 EMAIL_TAKEN`, `429 RATE_LIMITED`.
Side effects: guest session upgraded (`sessions.kind='user'`, `users.sessionUpgradedFrom`), cart merged (sum quantities, cap at stock, drop unavailable lines), guest orders ≤ 24 h claimed to the account.

### POST `/auth/login` → `200 { user, tokens, cart: { merged } }` · errors `401 INVALID_CREDENTIALS`, `423 ACCOUNT_DISABLED`.
### POST `/auth/refresh` → `200 { tokens }` (rotates; reuse of an old token → `401 TOKEN_REUSE` and family revocation).
### POST `/auth/logout` → `204` (revokes refresh, clears `sid`; server-side cart retained).

---

## 3. Catalogue

### GET `/products`
Query: `q, category (slug), merchantId, minPriceMinor, maxPriceMinor, inStock, sort, page, limit,` plus typed filters `<attrKey>_gte|_lte|_eq|_in` (only filterable keys).
```json
// 200
{ "items": [{
    "id":"…","slug":"ascent-book-14-pro","title":"Ascent Book 14 Pro","brand":"Vertex Systems",
    "merchant": { "id":"…","name":"Vertex Systems","slug":"vertex-systems" },
    "category": { "id":"…","slug":"laptops","name":"Laptops" },
    "price": { "amountMinor": 87900, "currency":"USD","display":"$879.00","compareAtMinor": 94900 },
    "stock": 7, "availability": "in_stock",
    "attributes": { "ramGb":16,"storageGb":512,"screenIn":14,"weightG":1290,"batteryWh":60,"cpu":"Ryzen 7 8845HS" },
    "specs": [{ "group":"Performance","key":"cpu","label":"Processor","value":"AMD Ryzen 7 8845HS" }],
    "pros": ["16 GB dual-channel RAM handles large monorepos"], "cons": ["Integrated graphics only"],
    "rating": { "avg":4.6,"count":128 },
    "badges": ["price_drop"],
    "images": [{ "url":"/products/ascent-book-14-pro.svg","alt":"Ascent Book 14 Pro laptop" }],
    "warrantyMonths": 24 }],
  "page":1,"limit":20,"total":42,"hasMore":true,
  "facets": { "brands":[{"value":"Vertex Systems","count":6}], "priceRange":{"minMinor":49900,"maxMinor":249900} } }
```
Errors: `400 UNFILTERABLE_ATTRIBUTE`, `400 INVALID_SORT`.

### GET `/products/{slugOrId}` → `200 { product }` (full object incl. `description`, `shortDescription`, `returnDays`, `soldCount`). `404 PRODUCT_NOT_FOUND`.

### GET `/categories` → `200 { items: [{ id, name, slug, parentId, attributeSchema }] }`

### GET `/products/{id}/history` *(merchant, own product)* → `200 { items: [price/stock change records] }`

### POST `/products` · PATCH `/products/{id}` · DELETE `/products/{id}` *(merchant, own product; DELETE = archive)*
```json
// PATCH req
{ "priceMinor": 89900, "stock": 12, "status":"active",
  "attributes": { "ramGb": 16, "storageGb": 512 } }
// 200 → full product ; 409 INSUFFICIENT_PERMISSION / 404 (cross-merchant returns 404)
```
Every change writes `price_history`. Setting `stock: 0` removes the product from search and blocks add-to-cart immediately.

---

## 4. Cart

### GET `/cart`
```json
// 200
{ "cart": { "id":"…","itemCount":2,"subtotalMinor":175800,"currency":"USD","display":"$1,758.00",
  "items":[{ "productId":"…","title":"Ascent Book 14 Pro","slug":"…","brand":"Vertex Systems",
             "merchant":{ "id":"…","name":"Vertex Systems" },
             "imageUrl":"/products/ascent-book-14-pro.svg",
             "quantity":2, "unitPriceMinor":87900, "lineTotalMinor":175800,
             "availableStock":7, "maxQuantity":7,
             "priceChangedFromMinor": null, "addedAt":"…" }],
  "warnings":[] } }
```
Cart reads always recompute `subtotalMinor` from live product prices and flag `priceChangedFromMinor` when the live price differs from `priceAtAddMinor`.

### POST `/cart/items` *(idempotent)*
```json
// req
{ "productId":"…", "quantity":2, "addedVia":"agent" | "card" | "product_page" }
// 200 → cart payload above
```
Errors: `409 INSUFFICIENT_STOCK` `{ available: 1 }`, `404 PRODUCT_NOT_FOUND`, `409 PRODUCT_ARCHIVED`, `409 CART_LINE_LIMIT`.

### PATCH `/cart/items/{productId}` → `{ "quantity": 3 }` (absolute; `0` removes) → `200 cart`.
### DELETE `/cart/items/{productId}` → `200 cart`.
### DELETE `/cart` → `200 { cart: empty }` (requires `confirm: true` body flag).

---

## 5. Quote & checkout

### POST `/checkout/quote` *(idempotent; rate limit 20/5 min)*
```json
// req
{ "extendHolds": true }
// 200
{ "quote": {
    "id":"q_…","expiresAt":"2026-10-16T09:47:00Z","currency":"USD",
    "lines":[{ "productId":"…","merchantId":"…","title":"Ascent Book 14 Pro","quantity":2,
               "unitPriceMinor":87900,"lineTotalMinor":175800,"availableStock":7 }],
    "amounts": { "subtotalMinor":175800,"shippingMinor":0,"taxMinor":14504,"totalMinor":190304,
                 "taxRateBps":825, "display":{"subtotal":"$1,758.00","shipping":"$0.00","tax":"$145.04","total":"$1,903.04"} },
    "shippingRuleApplied":"free_over_500",
    "warnings":[{ "code":"LOW_STOCK","productId":"…","message":"Only 7 left" }],
    "hash":"9f2c…" },
  "holds":[ { "productId":"…","quantity":2,"expiresAt":"2026-10-16T09:47:00Z" } ] }
```
Errors: `409 CART_EMPTY`, `409 ITEM_UNAVAILABLE` `{ items:[…] }`, `409 QUOTE_IN_PROGRESS`.
Notes: shipping rule table and tax in `prd.md` §5.4.1; holds are extended, never extended past 15 min from creation.

### POST `/orders` *(idempotent — the "Approve & Pay" click)*
```json
// req
{ "quoteId":"q_…", "quoteHash":"9f2c…", "contact": { "email":"buyer@example.com", "name":"A. Buyer" },
  "shippingAddress": { "name":"A. Buyer","line1":"12 Brigade Road","line2":"Flat 402",
                        "city":"Gorakhpur","state":"Uttar Pradesh","postalCode":"273001","countryCode":"IN" } }
// 201
{ "order": { "id":"…","orderNumber":"SP-2026-000123","status":"awaiting_payment",
    "amounts": { "totalMinor":190304,"currency":"USD","display":"$1,903.04" },
    "lines":[…] },
  "payment": { "paypalOrderId":"5O190127TN364715T", "clientId":"AZ…", "currency":"USD", "attemptNo":1 } }
```
Errors:
* `409 QUOTE_STALE` `{ diff:[{ productId, field:"priceMinor", fromMinor, toMinor }], newQuote: {…} }` → UI must re-render and require re-approval.
* `409 ITEM_UNAVAILABLE` `{ items:[{ productId, title, reason:"OUT_OF_STOCK" }] }`
* `409 HOLD_EXPIRED`, `409 CART_EMPTY`, `409 PAYMENT_IN_PROGRESS`, `402 PAYMENT_PROVIDER_ERROR`.
Side effects: order created (snapshots), holds committed to `active` with `orderId`, PayPal order created server-side with deterministic `PayPal-Request-Id`, `checkout_started` event emitted.

### GET `/orders/{orderId}`
Owner-scoped (customer, session, merchant of a line, admin). Returns the order with `lines`, `amounts`, `payment`, `timeline`, and — for `draft`/`awaiting_payment` — a fresh `quotePreview` with `expiresAt`.
```json
// 200
{ "order": { "id":"…","orderNumber":"SP-2026-000123","status":"awaiting_payment",
  "createdAt":"…","expiresAt":"…",
  "amounts":{ "subtotalMinor":175800,"shippingMinor":0,"taxMinor":14504,"totalMinor":190304,"currency":"USD" },
  "contact":{ "email":"buyer@example.com" },
  "shippingAddress":{ "name":"A. Buyer","line1":"12 Brigade Road","line2":"Flat 402",
                       "city":"Gorakhpur","state":"Uttar Pradesh","postalCode":"273001","countryCode":"IN" },
  "payment":{ "provider":"paypal","status":"created","paypalOrderId":"5O19…","amountVerified":false,"lastAttemptNo":1,
    "settlement":{ "mode":"split","reason":[],
      "units":[{ "referenceId":"m1","merchantId":"e756…","merchantName":"Vertex Systems",
                  "amountMinor":124380,"platformFeeMinor":6219,"payeeEmail":"vertex-systems@sandbox.demo" }],
      "totals":{ "amountMinor":192469,"platformFeeMinor":9623,"sellerCount":2 } } },
  "timeline":[{ "at":"…","event":"order_created","actor":"user" },
              { "at":"…","event":"settlement_split","actor":"system","meta":{ "sellers":2,"platformFeeMinor":9623 } },
              { "at":"…","event":"paypal_order_created","actor":"system" }] },
  "quotePreview": { "expiresAt":"…","amounts":{…},"warnings":[] } }
```

### POST `/orders/{orderId}/cancel` → `200 { order }` (`status: cancelled`), releases holds, voids the PayPal order when it is still `CREATED`. Errors: `409 INVALID_STATE`.

### GET `/orders` *(customer)* — query `status, page, limit, from, to` → `{ items, page, total }` (session-scoped for guests, limited to the current session's orders, 24 h window).

---

## 6. Payments

### POST `/payments/{orderId}/capture` *(idempotent; the only path to `paid`)*
```json
// req
{ "paypalOrderId":"5O190127TN364715T" }
// 200 (success)
{ "order": { "id":"…","orderNumber":"SP-2026-000123","status":"paid","paidAt":"…" },
  "payment": { "status":"captured","captureId":"3C679366HH908993F","capturedAt":"…",
               "amountMinor":190304,"currency":"USD","amountVerified":true,
               '"payerEmailHash":"a91f…",
               "captures":[{ "id":"3C6793…","amountMinor":124380,"status":"COMPLETED" },
                            { "id":"9AB120…","amountMinor":68089,"status":"COMPLETED" }] },
  "receipt": { "orderId":"…","items":[…],"amounts":{…} } }
```
Failure responses (order status never becomes `paid`):
| Case | HTTP | code | order status | UI state |
|---|---|---|---|---|
| *(as-built)* split capture whose seller units, payees or summed amount differ from the plan | 409 | `PAYMENT_VERIFICATION_FAILED` (`details.checks.settlementOk=false`) | unchanged | “We couldn’t verify that payment” |
Declined card | 402 | `PAYMENT_DECLINED` | `payment_failed` | retry panel |
Insufficient funds | 402 | `PAYMENT_INSUFFICIENT_FUNDS` | `payment_failed` | retry panel + hint "try another funding source" |
Payer action required (eCheque) | 202 | `PAYMENT_PENDING` | `payment_processing` | pending panel with polling |
Already captured (same attempt) | 200 | — (`Idempotent-Replay: true`) | `paid` | success (no double charge) |
Already captured (other attempt/order) | 409 | `ORDER_ALREADY_CAPTURED` | `paid` (reconciled) | success for the winner, info for the loser |
Amount mismatch | 409 | `PAYMENT_VERIFICATION_FAILED` | `payment_failed` | danger panel + "Contact support · Reference {requestId}" |
Hold expired / quote stale | 409 | `HOLD_EXPIRED` / `QUOTE_STALE` | `expired` / `awaiting_payment` | re-quote flow |
Concurrent capture | 409 | `PAYMENT_IN_PROGRESS` | `payment_processing` | "Confirming payment…" polling |
PayPal unreachable | 503 | `PAYMENT_PROVIDER_UNAVAILABLE` | `payment_processing` | "We'll confirm shortly" + poll `/orders/{id}` |
### POST `/payments/{orderId}/retry` → `201 { payment: { paypalOrderId, clientId, attemptNo:2 } }` (new attempt row; order → `awaiting_payment` if it was `payment_failed` and the quote is still valid, else `409 QUOTE_STALE` → client re-quotes).
### GET `/payments/{orderId}/status` → `200 { orderStatus, paymentStatus, attemptNo, captureId?, failureReason? }` — used for polling while `pending`/`processing`.
### POST `/webhooks/paypal` (raw body; no auth, signature verified) → always `200 { received: true, deduplicated?: true }`. Handles `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`. See `docs/payments_paypal.md` §7.
### POST `/admin/orders/{orderId}/reconcile` *(admin)* → forces recon with PayPal; returns `{ applied: boolean, order }`.

---

## 7. Chat & agent (SSE)

### POST `/chat/sessions` → `201 { sessionId, requirement, requirementRevision }`
Creates or returns the session's chat thread (implicit for guests on first message).

### GET `/chat/sessions/{sessionId}/messages?limit=20&before=…` → transcript page for rendering history.

### POST `/chat/stream` — **Server-Sent Events**
```json
// req (Content-Type: application/json)
{ "sessionId":"s_…", "message":"I need a laptop for full-stack dev under $900, 16GB RAM, 512GB SSD",
  "clientMessageId":"cm_01", "attachedProductIds":["…"] }
```
Response `200 text/event-stream`:
```
event: message.start
data: {"messageId":"m_…","clientMessageId":"cm_01","at":"…"}

event: tool.activity
data: {"id":"t1","tool":"search_products","label":"Searching the catalogue","status":"running"}

event: tool.activity
data: {"id":"t1","tool":"search_products","status":"done","durationMs":842,"resultSummary":{"count":5}}
```
> Note: the `data:` line above is one physical line; wrapping here is documentation only.

```
event: ui.component
data: {"messageId":"m_…","component":{"type":"product_cards","payload":{"revision":2,"requiresApproval":false,
      "cards":[{"productId":"…","slug":"…","title":"Ascent Book 14 Pro","brand":"Vertex Systems",
        "merchant":{"id":"…","name":"Vertex Systems"},
        "price":{"amountMinor":87900,"currency":"USD","display":"$879.00"},
        "stock":{"available":7,"state":"in_stock"},
        "whyItFits":"Meets 16 GB RAM, 512 GB SSD, 11 h battery and sits $21 under budget.",
        "pros":["…","…"],"cons":["…"],"rating":{"avg":4.6,"count":128},
        "attrs":{ "ramGb":16,"storageGb":512,"weightG":1290 },
        "actions":["add_to_cart","compare","details"]}]}}}

event: message.delta
data: {"messageId":"m_…","text":"Here are three that fit"}

event: message.end
data: {"messageId":"m_…","text":"…","requirement":{"…":{}},"requirementRevision":2,
       "candidateProductIds":["…"],"quickReplies":["Compare top 2","Only ≤ $700"],
       "assumptions":["budget: none set"],"usage":{"tokensIn":3120,"tokensOut":540},"stopped":false}

event: cart.updated
data: {"cart":{"itemCount":3,"subtotalMinor":…,"currency":"USD"}}

event: error
data: {"code":"LLM_UNAVAILABLE","message":"…","requestId":"r_…"}
```
Component types: `product_cards` · `comparison` · `cart_summary` · `checkout_card` · `order_status` · `clarification` (payload has `question` + `options[]`).
Abort: client closes the connection → server aborts the LLM request, persists the partial message with `stopped: true`.

### PATCH `/chat/sessions/{sessionId}/requirement`
```json
// req
{ "op":"remove"|"add"|"set", "constraint": { "kind":"attribute","key":"budgetMinor","op":"lte","value":70000,"label":"≤ $700" } }
// 200
{ "requirement": {…}, "requirementRevision": 3, "changed": true }
```
Server bumps the revision, re-runs search, and returns the refreshed candidate set (also emitted as a `ui.component` if a stream is open).

### POST `/chat/sessions/{sessionId}/feedback` *(optional)* → thumbs on a message id.

---

## 8. Analytics & merchant read APIs

### POST `/analytics/events` (client beacon; 204, never errors the caller)
```json
{ "events":[{ "eventId":"uuid","name":"product_viewed","ts":"…","props":{"productId":"…","source":"product_page"} }] }
```
Server validates `name` against the allow-list and `props` against the per-event schema; invalid events are dropped (counted, not returned).

### GET `/merchant/overview?range=30d` → `{ revenueMinor, paidOrders, avgOrderValueMinor, conversionRateBps, lowStock:[…], topProducts:[…], recentOrders:[…] }`
### GET `/merchant/products?status=&q=&page=` → paginated merchant products.
### GET `/merchant/orders?status=&paymentStatus=&from=&to=&q=` → paginated orders (merchant-scoped).
### PATCH `/merchant/orders/{orderId}` → `{ "action":"mark_shipped", "tracking?":{ "carrier","number" } }` → `200 { order }`.
### GET `/merchant/categories` · POST · PATCH · DELETE (archive) — merchant-scoped.
### GET `/merchant/analytics?range=7d|30d&from=&to=` →
```json
{ "funnel": { "views":1840, "cartAdds":312, "checkoutAttempts":96, "purchases":41 },
  "rates": { "viewToCartBps":1695, "cartToCheckoutBps":3077, "checkoutToPaidBps":4271, "viewToPurchaseBps":222 },
  "timeseries": [{ "date":"2026-10-10","views":210,"cartAdds":33,"checkoutAttempts":11,"purchases":5 }],
  "products": [{ "productId":"…","title":"…","views":310,"cartAdds":54,"purchases":12,"viewToPurchaseBps":387 }],
  "paymentHealth": { "attempts":101, "captured":92, "failed":7, "pending":2,
                     "failureReasons":[{ "reason":"INSTRUMENT_DECLINED","count":4 }] } }
```

---

## 9. Error catalogue

| Code | HTTP | Meaning | Client action |
|---|---|---|---|
`VALIDATION_ERROR` | 400 | Zod failure; `details[]` has `path`, `message` | inline field errors
`UNFILTERABLE_ATTRIBUTE` | 400 | filter key not in category schema | ignore filter, log
`INVALID_SORT` | 400 | unknown sort key | fall back to `relevance`
`INVALID_CREDENTIALS` | 401 | wrong email/password | generic error copy
`TOKEN_EXPIRED` / `TOKEN_REUSE` | 401 | access expired / refresh reused | refresh silently / force re-login
`FORBIDDEN` | 403 | role lacks permission | hide action
`CART_EMPTY` / `CART_LINE_LIMIT` | 409 | guard | UI copy from `design_system.md`
`INSUFFICIENT_STOCK` | 409 | requested qty > available (`details.available`) | clamp + warn
`ITEM_UNAVAILABLE` | 409 | item went out of stock/archived at checkout | remove line, re-quote, re-approve
`QUOTE_STALE` | 409 | price/holds changed since approval | show diff, re-approve
`HOLD_EXPIRED` | 409 | 15-min hold elapsed | re-quote
`PAYMENT_IN_PROGRESS` | 409 | advisory lock held | show processing state, poll
`ORDER_ALREADY_CAPTURED` | 409 | PayPal says captured | treat as success if it is our order, else reconcile
`PAYMENT_VERIFICATION_FAILED` | 409 | amounts/status mismatch | fail order, alert, support reference
`PAYMENT_DECLINED` / `PAYMENT_INSUFFICIENT_FUNDS` | 402 | payer-side failure | retry panel
`PAYMENT_PENDING` | 202 | non-final capture (eCheque etc.) | pending panel + polling
`PAYMENT_PROVIDER_UNAVAILABLE` | 503 | PayPal down/timeout | safe retry, keep order
`RATE_LIMITED` | 429 | limit hit | backoff using `Retry-After`
`LLM_UNAVAILABLE` | 503 | model unavailable | apologetic bubble + retry chip
`INTERNAL` | 500 | unexpected | toast with `requestId`

---

## 10. Contract & type generation

1. `contracts/openapi.yaml` is hand-authored alongside this doc.
2. `packages/shared/src/api.ts` exposes Zod schemas for every request/response DTO; the Express layer binds them via `validate(schema)`.
3. `pnpm gen:client` → `openapi-typescript` → `apps/web/src/lib/api.types.ts` (types only, no runtime fetch wrapper generated — the hand-written `apiClient` adds CSRF, retry and error normalisation).
4. CI checks: `pnpm check:contract` diffs the Zod schemas against `openapi.yaml` and fails on drift; `pnpm test:contract` runs the integration suite against a mocked Express app with real Mongo.
