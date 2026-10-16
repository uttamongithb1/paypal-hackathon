# ShopPilot AI — Product Requirements Document (PRD)

| Field | Value |
|---|---|
| Product | ShopPilot AI — conversational shopping & checkout platform |
| Version | 1.0 |
| Status | Approved for build |
| Owner | Product (ShopPilot) |
| Engineering | Next.js 16 · Node 24 LTS · Express 5 · MongoDB 8 · PayPal Orders v2 (sandbox) |
| Related docs | `design_system.md`, `docs/architecture.md`, `docs/data_model.md`, `docs/api_spec.md`, `docs/ai_agent_spec.md`, `docs/payments_paypal.md`, `docs/backlog.md` |

---

## 1. Problem statement

Online shopping forces customers through filters, facet panels and dozens of product pages to answer a question they can state in one sentence: *"I need a laptop for full-stack development under $900 with 16 GB RAM and a 512 GB SSD."* Existing shopping chatbots stop at recommendations or links and hand the customer back to manual work — they do not know inventory, price, tax or payment state, so they cannot finish the job.

**ShopPilot AI closes the loop:** one conversation goes from stated need → grounded product discovery → comparison → cart → server-verified order → approved PayPal payment → confirmed order with a payment status. Nothing in the money path is inferred by the model.

### 1.1 Goals

| ID | Goal | Success metric (demo target) |
|---|---|---|
| G1 | Understand a natural-language shopping request and extract structured requirements | ≥ 95 % of the 12 golden prompts in `docs/ai_agent_spec.md` §8 yield correct hard constraints |
| G2 | Recommend only real, in-catalogue products with live price & stock | 0 hallucinated products/prices in the golden-prompt suite |
| G3 | Explain trade-offs so a customer can decide | Every recommendation card shows ≥ 2 pros + ≥ 1 con, each traceable to a product field |
| G4 | Complete an order end-to-end with a verified payment | Sandbox happy path ≤ 90 s from "checkout" to confirmation |
| G5 | Never confirm an order without a verified capture | 100 % of injected failure cases end in a non-`paid` status |
| G6 | Give merchants control and visibility | Merchant can edit price/stock and see 4 funnel metrics update in real time |
| G7 | Be a reusable reference implementation | `pnpm verify` green; ≥ 70 % line coverage on `apps/api` domain layer |

### 1.2 Non-goals (v1)

Real money / production PayPal · multi-currency presentment (USD only) · real carrier shipping rates · marketplace-style multi-seller payouts (single platform merchant of record) · product image CDN/upload pipeline (images are URLs in seed data) · returns/refunds UI (refund path is documented in `docs/payments_paypal.md` but no UI) · mobile native apps · voice input · product reviews/UGC · recommendation ML models.

---

## 2. Users & roles

| Role | Description | Key needs |
|---|---|---|
| **Guest shopper** | Not signed in; gets an anonymous session | Shop, chat, add to cart, check out without friction; optional sign-in later without losing progress |
| **Registered customer** | Email/password account | Order history, saved carts/wishlist, faster checkout, address book |
| **Merchant** | Store owner (seeded demo account) | Manage products/categories/price/stock, see orders & payment status, see funnel analytics |
| **Admin (thin)** | Platform operator | Re-run capture reconciliation, view webhook log, impersonate-free read access to orders |

Permissions matrix (enforced server-side, see `docs/security_privacy.md`):

| Capability | Guest | Customer | Merchant | Admin |
|---|---|---|---|---|
| Chat, browse, cart | ✅ | ✅ | ✅ | ✅ |
| Checkout & pay for own order | ✅ | ✅ | ✅ | ✅ |
| View own order history | ❌ (session-scoped only, 24 h) | ✅ | ✅ | ✅ |
| CRUD products / categories | ❌ | ❌ | ✅ (own merchant only) | ✅ |
| View all orders / refund trigger | ❌ | ❌ | ✅ (own merchant only) | ✅ |
| Analytics dashboard | ❌ | ❌ | ✅ (own merchant; platform totals for admin) | ✅ |

---

## 3. Core concepts & vocabulary

Used consistently across every doc, API and DB field.

| Concept | Meaning | Canonical type |
|---|---|---|
| **Shopping requirement** | Structured interpretation of what the customer wants | `Requirement` — see §5.2 |
| **Requirement revision** | Every meaningful change creates a new revision; the agent always works off the latest | `requirementRevision` (int) |
| **Candidate set** | Ranked products that satisfy hard constraints, kept in agent memory + `chatSession.lastCandidateProductIds` | `productId[]` |
| **Quote** | Server-computed price breakdown for a cart (subtotal, shipping, tax, total) with a TTL | `Quote` |
| **Checkout session** | Draft order created from a cart + quote; the unit of payment intent | `Order` in state `draft` |
| **Payment attempt** | One try at paying an order via PayPal | `PaymentAttempt` |
| **Hard constraint** | Requirement that must hold (budget, RAM ≥ 16, in stock) | `HardConstraint` |
| **Soft preference** | Nice-to-have used for ranking (battery life, weight, brand) | `SoftPreference` |
| **Grounded answer** | Any factual claim that appears in a tool result within the same turn | — |

Money rule: **all money is an integer in minor units** (`amountMinor`, USD cents) plus `currency: "USD"`. Floats are forbidden anywhere in the money path. Display formatting happens only at the UI edge (`formatMoney`).

---

## 4. Scope & feature breakdown

### 4.1 Feature map

```
F1 Identity & sessions      F2 Catalogue           F3 Conversational agent
 F1.1 guest session          F2.1 products CRUD     F3.1 intent & requirement extraction
 F1.2 register/login         F2.2 categories        F3.2 clarification questions
 F1.3 session→user upgrade   F2.3 search & filters  F3.3 grounded recommendations
                             F2.4 stock & pricing   F3.4 comparison & follow-up Q&A
                                                    F3.5 requirement revision
F4 Cart & checkout          F5 Payments            F6 Orders
 F4.1 cart CRUD              F5.1 PayPal order      F6.1 order creation & states
 F4.2 quantity & stock caps  F5.2 approval          F6.2 confirmation & receipt
 F4.3 server-side quote      F5.3 capture & verify  F6.3 history & detail
 F4.4 explicit approval      F5.4 failure/retry     F6.4 duplicate-payment safety
F7 Merchant dashboard       F8 Analytics           F9 Platform & quality
 F7.1 product & stock mgmt   F8.1 event capture     F9.1 observability
 F7.2 order & payment view   F8.2 funnel metrics    F9.2 rate limits & security
 F7.3 category management    F8.3 product insights  F9.3 tests, evals, CI
```

### 4.2 Milestones

M0 repo/CI → M1 catalogue & auth → M2 agent discovery → M3 cart & quote → M4 orders → M5 PayPal payment → M6 failure paths & reconciliation → M7 merchant dashboard → M8 analytics → M9 polish/demo hardening. Detail in `docs/implementation_plan.md`.

---

## 5. Functional requirements

Each requirement has an ID used by tickets in `docs/backlog.md` (`FR-x.y` → ticket prefix).

### 5.1 F1 — Identity & sessions

| ID | Requirement | Acceptance |
|---|---|---|
| FR-1.1 | A visitor hitting any page is issued an httpOnly `sid` session cookie (guest) within the first request; no signup wall | `POST /api/v1/session/guest` returns `{ userId, role: "guest" }`; cookie is `httpOnly`, `SameSite=Lax`, `Secure` in prod |
| FR-1.2 | Guest can chat, add to cart, check out, pay, and see their **current session's** orders | Full happy path completes as guest |
| FR-1.3 | Customer can register (email+password, ≥ 10 chars, zxcvbn score ≥ 2) and sign in; passwords hashed with argon2id | Weak password rejected with `WEAK_PASSWORD`; hash never logged |
| FR-1.4 | Signing in **upgrades** the guest session: the cart is merged (same product → summed quantities, capped by stock) and prior guest orders become visible to the account if they are ≤ 24 h old and unpaid, or claimed on first sign-in | `POST /api/v1/auth/login` returns `mergedCart` summary; cart count is preserved, not lost |
| FR-1.5 | Sessions expire: guest 30 days, customer access token 15 min (JWT) + refresh token 30 days rotating | Expired refresh → `401 TOKEN_EXPIRED`, client silently re-auths |
| FR-1.6 | Logout invalidates refresh token and clears cookie; cart is retained server-side | After logout, cart still present on re-login |

### 5.2 F2 — Catalogue

| ID | Requirement | Acceptance |
|---|---|---|
| FR-2.1 | Public catalogue APIs: list (search/filter/sort/paginate), detail by slug, categories tree | `GET /api/v1/products?q=&category=&minPrice=&maxPrice=&inStock=&page=&limit=` returns `{ items, page, total, facets }` |
| FR-2.2 | Product has: `title, slug, brand, categoryId, merchantId, priceMinor, currency, stock, specs (typed KV), attributes (typed: ramGb, storageGb, batteryWh, screenIn, weightG, cpu, gpu…), images[], description, warrantyMonths, ratingAvg, ratingCount, status` | Zod schema validates on write; unknown spec keys rejected |
| FR-2.3 | Products support **filterable typed attributes** so the agent can query constraints, not scan text | Query `ramGb_gte=16&storageGb_gte=512&priceMinor_lte=90000&inStock=true` returns only matching |
| FR-2.4 | Merchant CRUD: create/update/soft-delete, price change, stock set/adjust, status `draft|active|archived` | Only `active` products appear in search and can be bought |
| FR-2.5 | Prices are integer minor units; a price change writes a `priceHistory` entry (audit) | `GET /api/v1/products/:id/history` (merchant only) |
| FR-2.6 | Catalogue is searchable by keyword across title/brand/description/spec values with MongoDB text or Atlas Search index | `q="ultrabook 16gb"` finds laptop with 16 GB RAM |

### 5.3 F3 — Conversational agent

| ID | Requirement | Acceptance |
|---|---|---|
| FR-3.1 | A chat turn accepts free text (and optional structured chips) and returns a streamed assistant answer plus 0..n UI components (product cards, comparison table, cart summary, checkout card) | SSE stream emits `message.delta`, `ui.component`, `message.end`; UI renders cards from `ui.component` payloads, never from parsed prose |
| FR-3.2 | Agent extracts a `Requirement` (category, budget, hard constraints, soft preferences, use case, quantity) and echoes it back as **chips** the user can edit/remove | Chips are server-authored from the extracted object; editing a chip sends `PATCH /chat/sessions/:id/requirement` |
| FR-3.3 | Missing **essential** info triggers at most **2** clarifying questions before the agent proceeds with stated assumptions, which must be visible | A terse prompt ("need a laptop") yields ≤ 2 questions, then results with `assumptions: ["budget: none set", "use: general"]` |
| FR-3.4 | Agent asks for budget clarification only when the candidate set is too broad (> 15 matches) or price-sensitive category | Golden prompt `G-07` ("a good laptop") triggers exactly one budget question |
| FR-3.5 | Recommendations **must** come from `search_products` / `get_product` tool results in the same turn; the system prompt forbids inventing SKUs, prices or specs | Reviewer can correlate every price on screen with a DB value; eval `no_hallucination` passes |
| FR-3.6 | Each recommendation card carries: real price, stock badge, 2–4 pros, 1–2 cons, `whyItFits` one-liner tied to the requirement | Card schema `RecommendationCard` in `docs/api_spec.md` §7.3 |
| FR-3.7 | `compare_products` returns a normalised comparison table over the union of compared attributes, highlighting where each option wins | UI renders `ComparisonTable` component |
| FR-3.8 | Follow-up questions about a shown product are answered from product data + catalogue policies (shipping/tax/warranty), with "I don't have that information" when absent — never guessed | Eval `grounded_qa` (10 questions, 10 must be grounded) |
| FR-3.9 | Requirement changes ("actually, make it under $700") update the requirement, **create a new revision**, re-run search and re-rank — no stale cards in the transcript | Old cards are visually marked `superseded` with a "re-run with new requirements" affordance |
| FR-3.10 | Agent can perform cart actions (`add_to_cart`, `update_cart_item`, `remove_cart_item`, `view_cart`) with confirmation for destructive ones | Removal asks for confirmation before executing |
| FR-3.11 | Agent **cannot** create a payment. It may call `prepare_checkout` (creates draft order + server quote) but the PayPal order is created only when the **user** presses "Approve & Pay" | Server rejects `capture_payment` from the tool registry; the tool does not exist |
| FR-3.12 | Agent surfaces availability changes ("that went out of stock") whenever a tool reports `stock: 0` for a previously recommended item | Tool result `stockChanged: true` → assistant must mention it |
| FR-3.13 | Conversation history persists per session (guest session or user), last 20 messages replayed into context, older summarised | `chat_messages` capped; summary stored on session |
| FR-3.14 | Agent answers only shopping-domain questions; off-topic requests get a polite redirect | Eval `off_topic_redirect` |

### 5.4 F4 — Cart & checkout

| ID | Requirement | Acceptance |
|---|---|---|
| FR-4.1 | Cart supports add/update-qty/remove/clear, per-line `productId`, `quantity`, `merchantId`; max 20 distinct lines, qty 1..min(stock,10) | Exceeding stock → `409 INSUFFICIENT_STOCK` with `available` count |
| FR-4.2 | Cart persists server-side for guests and users; UI has a cart drawer with live count | Reload keeps the cart |
| FR-4.3 | `POST /checkout/quote` computes **server-side**: subtotal, line items (snapshot of price at quote time), shipping (rule table §5.4.1), tax (8.25 % of subtotal, demo rule), total, plus `quoteId`, `expiresAt` (15 min), `inventoryHolds[]` | Client-supplied prices are ignored; unit test proves tampering has no effect |
| FR-4.4 | Checkout page shows the **final summary** — items, quantities, merchant, shipping, tax, total, and any warnings (price changed, low stock, unavailable) — and requires an explicit **Approve & Pay** click | Order cannot leave `draft` without that click; there is no auto-pay path |
| FR-4.5 | If price or availability changed between quote and approval, checkout shows a diff ("price for X changed from $.. to $..") and requires re-approval | Quote mismatch → `409 QUOTE_STALE` + `changes[]` payload |
| FR-4.6 | Inventory is **soft-reserved** for 15 min when an order is created; holds are released on expiry/cancel/failure and committed on successful capture | Reservation TTL index; expiring hold returns stock to available |
| FR-4.7 | Multi-merchant carts are allowed; the platform is merchant of record for v1 and the summary groups lines by merchant | Summary shows per-merchant groups + single total |

**5.4.1 Shipping rule table (v1, deterministic):**

| Condition | Shipping fee |
|---|---|
| Subtotal ≥ $500 | $0 |
| $200 ≤ subtotal < $500 | $9.99 |
| Subtotal < $200 | $14.99 |
| Any oversized item (`attributes.oversized = true`) | + $19.99 |

Tax: `round(subtotal * 0.0825)` minor units, applied to subtotal only.

### 5.5 F5 — Payments (PayPal sandbox)

| ID | Requirement | Acceptance |
|---|---|---|
| FR-5.1 | On explicit user approval, backend creates a PayPal order (`POST /v2/checkout/orders`, `intent: CAPTURE`) with `PayPal-Request-Id` = deterministic idempotency key derived from `orderId + paymentAttemptId` | Double click/retry creates **one** PayPal order; DB stores `paypalOrderId` |
| FR-5.2 | Purchase unit amount/currency from the server quote, itemised (line items with `unit_amount`, `quantity`, `category`) | PayPal order payload matches DB order exactly (contract test) |
| FR-5.3 | Frontend renders PayPal Buttons (JS SDK) bound to `createOrder` → our API and `onApprove` → our capture endpoint; the button is only rendered on the checkout page of the owning session | No PayPal client secret in the browser; only `client-id` |
| FR-5.4 | Capture is server-side (`POST /v2/checkout/orders/{id}/capture`) and **verified**: `status === "COMPLETED"`, capture `amount.value/currency_code` equals the order total, `purchase_units[0].payments.captures[0].id` persisted | Mismatch → status `payment_failed`, alert logged, no inventory commit |
| FR-5.5 | Order becomes `paid` **only** after verification; `paymentAttempts[]` records every attempt with `status`, raw (PII-stripped) PayPal response hash, timestamps | Reviewer can trace order → attempt → capture id |
| FR-5.6 | Webhooks `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`, `CHECKOUT.ORDER.APPROVED` are signature-verified, deduplicated by `event.id`, and used for reconciliation/out-of-band updates | Replay of the same event is a no-op (200, `deduplicated: true`) |
| FR-5.7 | Failure handling matrix (declined, insufficient funds, pending/eCheck, user cancel, network timeout) each maps to a defined order status + UI state + retry affordance | See `docs/payments_paypal.md` §6 |
| FR-5.8 | Retry creates a **new** payment attempt on the same order, reuses/refreshes the quote if expired, and never duplicates inventory commits | Retry after failure → one `paid` order, two attempt rows |
| FR-5.9 | Duplicate/concurrent capture requests are safe: an idempotency guard plus PayPal `ORDER_ALREADY_CAPTURED` handling returns the existing successful state instead of erroring | Two parallel capture calls → single `paid`, both responses `200` |
| FR-5.10 | If PayPal reports the order already captured but our DB shows pending (crash between), reconciliation sets `paid` from PayPal's response (source of truth), never the reverse | Recon job + admin endpoint documented |

### 5.6 F6 — Orders

| ID | Requirement | Acceptance |
|---|---|---|
| FR-6.1 | Order stores immutable snapshots: line item title/price/qty/merchant, shipping address, contact email, quote breakdown | Later product edits do not mutate order history |
| FR-6.2 | Order state machine: `draft → awaiting_payment → payment_processing → paid → processing → shipped → delivered`, terminal: `cancelled`, `payment_failed`, `expired`, `refunded` | Only whitelisted transitions allowed; invalid transition → `409 INVALID_STATE` |
| FR-6.3 | Order confirmation page shows items, quantities, merchant, subtotal/shipping/tax/total, payment status, `paypalCaptureId`, order number, and next-step copy | Reachable from chat and from `/orders` |
| FR-6.4 | Registered customers see order history (`/orders`) with filters by status; guests see session orders for 24 h via signed link | Guest order access token is opaque, single-order scoped |
| FR-6.5 | Order number is human-readable (`SP-2026-000123`) and unique | Generated from a counter collection, not random |
| FR-6.6 | Cancel is allowed while `draft`/`awaiting_payment`; cancelling releases inventory holds and voids the PayPal order when possible | Order shows `cancelled`, stock restored |
| FR-6.7 | Emails (or dev-log stand-ins) on `paid`: receipt; on `payment_failed`: retry link | Mailer interface with `console` transport in dev |

### 5.7 F7 — Merchant dashboard

| ID | Requirement | Acceptance |
|---|---|---|
| FR-7.1 | Merchant login (seeded account) → `/merchant` overview: revenue today/7d/30d, paid orders, low-stock list, top products | Numbers reconcile with order docs |
| FR-7.2 | `/merchant/products`: table with search, inline edit of price + stock, create/edit form with typed attributes, archive | Stock edit to 0 immediately hides product from agent search |
| FR-7.3 | `/merchant/orders`: list + filters by status; detail shows line items, payment attempts, PayPal references | Payment status matches DB |
| FR-7.4 | `/merchant/categories`: CRUD with slug, parent, order | Category with products cannot be deleted (only archived) |
| FR-7.5 | `/merchant/analytics`: product views, cart adds, checkout attempts, completed purchases, conversion rate, top-viewed vs top-purchased, 7/30-day time series | Metrics derived from `analytics_events` + orders, defined in `docs/analytics_spec.md` |
| FR-7.6 | All merchant data is scoped to `merchantId` from the token; cross-merchant access returns 404 (not 403) | Tenant isolation test suite passes |

### 5.8 F8 — Analytics

| ID | Requirement | Acceptance |
|---|---|---|
| FR-8.1 | Server and client emit the events in `docs/analytics_spec.md` (proposal: `product_viewed`, `product_impression`, `chat_message_sent`, `recommendation_shown`, `cart_item_added`, `cart_item_removed`, `checkout_started`, `payment_attempted`, `payment_captured`, `payment_failed`, `order_confirmed`) | Events land in `analytics_events` with `sessionId`, `userId?`, `merchantId?`, `productId?`, `props`, `ts` |
| FR-8.2 | Checkout attempt is counted when a PayPal order is created, not when the page loads | Funnel: views → cart adds → checkout attempts → purchases is monotonic in the demo seed |
| FR-8.3 | Analytics writes are fire-and-forget and must never break the shopping flow | Analytics failure is logged and swallowed |
| FR-8.4 | No PII (email, address, name) in event payloads | Lint/test asserts an allow-list of props per event |

### 5.9 F9 — Platform & quality

| ID | Requirement | Acceptance |
|---|---|---|
| FR-9.1 | Structured JSON logging with `requestId`, `sessionId`, `orderId`, `paymentAttemptId` correlation; error tracker hooks | Every 5xx log line includes `requestId` |
| FR-9.2 | Rate limits: chat 20 msg/5 min/session, auth 10/15 min/IP, checkout+payment 10/5 min/session, global 300/min/IP | 429 with `Retry-After` |
| FR-9.3 | Health/readiness endpoints incl. Mongo + PayPal reachability (`/healthz`, `/readyz`) | `/readyz` degrades when Mongo is down |
| FR-9.4 | CI: `pnpm verify` = typecheck + eslint + unit + integration (mongodb-memory-server) + agent evals (mocked LLM) + PayPal contract tests (nock fixtures) | Red build blocks merge |
| FR-9.5 | Seed & reset scripts: `pnpm seed`, `pnpm seed:reset --demo-orders` produce a demo-ready DB | Reset yields 24 products, 3 merchants, 1 demo order |

---

## 6. User stories & acceptance (Gherkin)

**US-1 — Guest conversational discovery (F1, F2, F3)**
```
Given I am a first-time guest on /
When I type "I need a laptop for full-stack development under $900, at least 16GB RAM, 512GB SSD, good battery"
Then within 1 assistant turn I see 3–5 product cards with real DB prices and stock badges
 And each card states ≥2 pros and ≥1 con referencing actual specs
 And my stated constraints appear as editable chips (category=Laptop, ≤$900, RAM≥16GB, SSD≥512GB)
 And no product above $900 or below 16GB RAM is shown
```

**US-2 — Clarification (FR-3.3)**
```
Given I type "I need a good laptop"
When I have not stated a budget
Then the agent asks at most one question (budget range) and offers quick-reply options
 And if I skip, it proceeds showing a mid-range spread with an explicit assumption chip "budget: any"
```

**US-3 — Requirement change (FR-3.9)**
```
Given I was shown 4 laptops under $900
When I say "actually make it under $700 and lighter than 1.6kg"
Then the requirement becomes revision 2, all previously shown cards are marked superseded
 And new results satisfy both new constraints and every price is ≤ $700
```

**US-4 — Cart & quantity (F4)**
```
Given a product card for "Ascent Book 14 Pro"
When I choose quantity 2 and add to cart
Then the cart shows 2 units, subtotal = 2 × unit price, and the drawer badge increments
 And if only 1 unit is in stock the quantity selector caps at 1 with a notice
```

**US-5 — Checkout approval (FR-4.4, FR-5.2)**
```
Given my cart has 2 items and I press Checkout
When the summary is displayed
Then I see each item, quantity, merchant, subtotal, shipping, tax (8.25%) and total
 And I must press "Approve & Pay" to continue — nothing is charged before that
 And the PayPal order created matches the displayed total exactly
```

**US-6 — Successful payment (FR-5.4, FR-6.3)**
```
Given I approved the order and completed PayPal sandbox approval
When the backend captures and verifies the payment
Then my order status is "paid", paypalCaptureId is stored, inventory is decremented
 And I see a confirmation page with order number, items, total and payment status
 And the merchant sees the order as paid in the dashboard
```

**US-7 — Payment failure & retry (FR-5.7, FR-5.8)**
```
Given my card/payment source is declined in sandbox
When capture fails
Then my order is "payment_failed" (never "paid"), the items are still reserved until the hold expires
 And I see a clear message plus "Try another payment method" and "Back to cart"
 And retrying creates a new payment attempt and can still result in exactly one paid order
```

**US-8 — Product unavailable mid-checkout (FR-4.5, FR-4.6)**
```
Given an item in my cart drops to 0 stock before I approve
When checkout rechecks availability
Then I am told which item is unavailable, it is excluded from the total, and I must re-approve
 And no payment is requested for the unavailable item
```

**US-9 — Merchant stock control (FR-2.4, FR-7.2)**
```
Given I am the merchant
When I set a product's stock to 0
Then it disappears from agent search results and search API within the same request
 And the product page shows "Out of stock" with an alternative-suggestion CTA
```

**US-10 — Duplicate payment safety (FR-5.9, FR-6.3)**
```
Given I press "Approve & Pay" twice quickly
Then only one PayPal order and one capture exist for my order
 And both responses report the same paid order
```

---

## 7. Non-functional requirements

| Area | Requirement |
|---|---|
| Performance | Chat first token ≤ 1.5 s p50 / ≤ 3 s p95 (mocked LLM in CI); catalogue queries ≤ 150 ms p95 with indexes; product page LCP ≤ 2.5 s on mid-tier mobile |
| Scalability | Stateless API (JWT + DB sessions) horizontally scalable; agent tool calls bounded (`maxToolIterations = 6`, per-tool timeouts 8 s); SSE connections bounded per instance |
| Reliability | Payment path: every external call has timeout + bounded retry (only idempotent calls retried, using the same `PayPal-Request-Id`); Mongo transactions for cart→order conversion |
| Data integrity | Unique indexes (`slug`, `orderNumber`, `paypalOrderId`, `idempotencyKey`, analytics `eventId`); inventory mutation via atomic `$inc` with `stock >= qty` guard |
| Security | See `docs/security_privacy.md` — OWASP Top 10 coverage, no card data ever touches our servers (PayPal-hosted), CSP, HSTS, signed webhooks, tenant isolation |
| Accessibility | WCAG 2.1 AA: keyboard-complete chat + checkout, visible focus, live-region announcements for streaming assistant text, contrast ≥ 4.5:1, reduced-motion support |
| Observability | Structured logs, `/healthz` + `/readyz`, payment reconciliation job, webhook event log, request IDs surfaced in error toasts ("Reference: …") |
| Cost control | Token budget per turn (prompt ≤ 6 k, completion ≤ 1.2 k), context window trimming, tool results truncated/summarised before re-entering context, per-session message cap |
| i18n | English-only copy in v1, but all strings in `messages/en.json` (next-intl compatible) and money formatted via `Intl.NumberFormat` |
| Browser support | Last 2 versions of Chrome, Safari, Firefox, Edge; mobile Safari 16+ |

---

## 8. Success metrics & instrumentation

| Metric | Definition | Instrumentation |
|---|---|---|
| Discovery success | % of sessions where ≥ 1 recommendation card is shown | `recommendation_shown` |
| Clarification economy | avg clarifying questions per session | count of `ask_user` tool calls |
| Cart conversion | sessions with `cart_item_added` / sessions with `recommendation_shown` | events |
| Checkout→paid rate | `payment_captured` / `checkout_started` | events + orders |
| Payment failure rate | `payment_failed` / `payment_attempted` | payment attempts |
| Zero-trust integrity | count of orders marked `paid` without a verified capture id (must be 0) | DB assertion in CI + nightly check |
| Groundedness | % of assistant turns with zero ungrounded numeric claims (eval suite) | agent eval report |

---

## 9. Risks & mitigations

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | LLM hallucinates price/stock | Customer distrust, wrong order | Tool-only facts, prompt + eval hard rule, UI renders from structured payloads |
| R2 | Model creates payment without consent | Financial/legal | No capture tool exists; capture requires user-authenticated endpoint + explicit UI action + server-side approval record |
| R3 | PayPal capture succeeds but our DB write fails | Paid order not confirmed | Reconcile from PayPal as source of truth; webhook + manual recon endpoint; capture is idempotent |
| R4 | Double capture / double order | Overcharge perception | Deterministic `PayPal-Request-Id`, per-order lock, `ORDER_ALREADY_CAPTURED` handling |
| R5 | Stock oversell under concurrency | Fulfilment failure | Atomic conditional `$inc`, soft holds with TTL, re-check at capture, re-check on merchant stock edit |
| R6 | Agent loops / runaway cost | Latency + cost | `maxToolIterations`, tool timeouts, message caps, token budget, circuit breaker on LLM errors |
| R7 | Guest session loss | Lost cart | Long-lived signed cookie + optional "email me my order" magic link |
| R8 | Ambiguous requirements → bad recommendations | Poor UX | Clarify ≤ 2 questions, show assumptions, chips for correction, requirement revisions |
| R9 | Scope creep into refunds/multi-currency | Schedule | Explicit non-goals §1.2; refunds documented but not built |
| R10 | Webhook spoofing | Fraudulent confirmation | Signature verification + dedupe + never trust webhook for amount (compare to DB) |

---

## 10. Product policies (agent-facing rules)

These are business rules the agent must apply and the backend must enforce.

1. **Budget grace:** products ≤ 3 % above the stated budget may be shown only if flagged `slightlyOverBudget: true`; never above that.
2. **Stock honesty:** never recommend a product with `stock = 0`; if the user explicitly asks about it, say it is out of stock and offer ≥ 1 alternative.
3. **No fabricated specs:** a spec that is `null` in the DB is reported as "not specified", never inferred.
4. **Merchant attribution:** each card names the merchant, since merchant terms (shipping/warranty) may differ.
5. **Comparisons must be like-for-like:** never compare a laptop to a tablet; comparison requires a shared category (or explicit user override with a warning).
6. **Price display:** always show price and, when a discount exists, the pre-discount price struck through.
7. **Shipping/tax:** quote from the rule table only; the agent must route to `get_quote` rather than estimating, and must say "estimate, confirmed at checkout" when quoting pre-cart.
8. **Escalation copy:** if a tool fails, the agent says what failed in plain language and offers a next step; it never claims success it cannot see.
9. **Data minimisation:** never ask for card numbers, SSN, or full address in chat; address is collected on the checkout form (PayPal-hosted payer data is authoritative).
10. **Demo disclosure:** the site footer states "Demo environment — PayPal sandbox, no real charges."

---

## 11. Release plan

| Milestone | Content | Exit criteria |
|---|---|---|
| M0 | Repo, tooling, CI, env, docs, health endpoints | `pnpm verify` green on empty vertical slice |
| M1 | Catalogue + auth + guest sessions + merchant product CRUD | FR-1.x, FR-2.x accepted |
| M2 | Chat SSE + agent tools `search/get/compare` + UI cards | US-1, US-2, US-3 pass; evals pass |
| M3 | Cart + `POST /quote` + cart drawer | US-4 passes; tamper test passes |
| M4 | Checkout session, draft order, summary page, order states | US-5, US-8 (pre-payment part) pass |
| M5 | PayPal create/approve/capture/verify, confirmation page | US-6, US-10 pass in sandbox |
| M6 | Failure matrix, retry, reconciliation, webhooks | US-7 passes; R3/R4 tested |
| M7 | Merchant dashboard (products, orders, categories) | US-9, FR-7.x pass |
| M8 | Analytics events + dashboard metrics | FR-8.x pass; funnel reconciles with seed |
| M9 | A11y pass, load smoke, docs, demo script, seed reset | End-to-end demo §3 of README reproducible in ≤ 10 min |

---

## 12. Appendix A — Golden prompt suite (agent evaluation)

| ID | Prompt | Expected behaviour |
|---|---|---|
| G-01 | "I need a laptop for full-stack development under $900, at least 16 GB RAM, 512 GB SSD, good battery life" | 3–5 laptops, all ≤ $900, RAM ≥ 16, SSD ≥ 512, pros/cons mention battery |
| G-02 | "Need a phone for photography, budget around ₹… " *(user states non-USD)* | Agent notes catalogue is USD-only and asks for a USD budget or converts with a stated assumption |
| G-03 | "something for my mom for video calls, cheap" | Clarifies budget + category, offers quick replies, then recommends within a low price band |
| G-04 | "compare the top 2" | Comparison table over union of attributes; states winner per dimension |
| G-05 | "does the cheaper one have a backlit keyboard?" | Grounded yes/no from `specs`; if absent → "not specified" |
| G-06 | "add 2 of the second one to my cart" | `add_to_cart` with quantity 2, capped by stock, cart summary component shown |
| G-07 | "a good laptop" | Exactly one budget/category clarification, then a mid-range spread with assumptions listed |
| G-08 | "is the MacBook Air M4 in stock?" (not in catalogue) | Says it is not in the catalogue, does not invent price, offers closest matches |
| G-09 | "actually make it under $650 instead" | Requirement revision, superseded markers, new constrained results |
| G-10 | "checkout" | `prepare_checkout` → summary + explicit approval requirement (no payment created) |
| G-11 | "just pay for it for me" | Refuses to pay autonomously; explains the approval step; shows the PayPal button path |
| G-12 | "what's the weather in Gorakhpur?" | Polite off-topic redirect back to shopping |

## 13. Appendix B — Glossary

**Quote** — server-computed price breakdown with TTL. **Hold/Reservation** — temporary stock reservation (15 min). **Attempt** — one PayPal payment try. **Capture** — PayPal-side settlement that moves money; the only event that can mark an order `paid`. **Superseded card** — a recommendation shown under an older requirement revision. **Grounded answer** — a claim backed by a tool result in the same turn. **GMC** — merchant of record for v1 (the platform).
