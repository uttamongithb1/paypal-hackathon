<!-- AS-BUILT NOTE: the reference implementation in app/ is a single Express service with a
     vanilla-JS frontend. This document is a plan written for a pnpm+Turborepo monorepo with
     Next.js and MongoDB; ticket IDs here do not map 1:1 to the shipped code. See FEATURES.md
     (what exists), GAPS.md (what is missing) and the app/ tree for the artifact. -->

# ShopPilot AI — Backlog (agent work queue)

Every ticket is written to be executable by a coding agent without further clarification. Format:

```
### ID — Title
Milestone · Depends on · Est (agent-hours)
Deliverable: files/artifacts created or changed
Acceptance: verifiable statements (tests, behaviors)
Doc refs: which spec sections govern it
```

Rules: do not start a ticket whose dependency is not done. When a ticket changes a documented contract, update the doc in the same PR. Mark DONE only when the acceptance list is satisfied and `pnpm verify` is green.

---

## M0 — Foundation

### FND-01 — pnpm workspace + Turborepo skeleton
M0 · none · 1 h
**Deliverable:** `pnpm-workspace.yaml`, `turbo.json`, root `package.json` with scripts (`dev`, `build`, `verify`, `test:*`, `lint`, `typecheck`, `format`), `packages/config` (tsconfig + eslint + prettier presets).
**Acceptance:** `pnpm install` clean; `pnpm lint` and `pnpm typecheck` run on an empty `apps/api`/`apps/web`; CI workflow file added.

### FND-02 — Express 5 API skeleton
M0 · FND-01 · 3 h
**Deliverable:** `apps/api/src/{index,app}.ts`, `config/env.ts` (zod, fail-fast), `config/logger.ts` (pino + redaction list), `middleware/{requestContext,errorHandler,notFound}.ts`, routes `/healthz` `/readyz` `/version`.
**Acceptance:** boot fails with a readable list when `MONGODB_URI` is absent; `/healthz` 200; unknown route → 404 JSON; every response has `x-request-id`; 5xx logs include `requestId`.

### FND-03 — Mongo + replica set
M0 · FND-02 · 3 h
**Deliverable:** `config/db.ts` (mongoose connect, `strictQuery`, retry), `docker-compose.yml` (mongo single-node RS + healthcheck), `tests/setup/mongo.ts` (mongodb-memory-server with `--replSet`), `scripts/db-indexes.ts`.
**Acceptance:** a transaction (session.withTransaction) commits in tests; `/readyz` reports `mongo: up` and `replicaSet: true`.

### FND-04 — `packages/shared` core
M0 · FND-01 · 4 h
**Deliverable:** `money.ts` (`toMinor`, `fromMinor`, `formatMoney`, `assertIntegerMinor`), `orderState.ts` (transition map + `assertTransition`), `analytics.ts` (event names + prop schemas), `policies.ts` (canonical policy copy), `categorySchemas.ts` (4 categories with `attributeSchema`), `api.ts` (DTO zod schemas started).
**Acceptance:** unit tests for money rounding, `formatMoney` (incl. thousands separators), forbidden order transitions; 100 % coverage of these files.

### FND-05 — Next.js shell + design tokens
M0 · FND-01 · 4 h
**Deliverable:** `apps/web` App Router skeleton, Tailwind v4 + `styles/tokens.css` (verbatim from `design_system.md` §2), `AppShell`, `TopBar`, `Footer` (sandbox disclosure), `ThemeToggle`, `SkipToContent`, `messages/en.json`.
**Acceptance:** light + dark render; tokens only (no hex literals outside `tokens.css`, enforced by a lint rule/regex test); `npm run build` succeeds; Lighthouse a11y ≥ 95 on `/`.

### FND-06 — Web API client
M0 · FND-05 · 3 h
**Deliverable:** `lib/apiClient.ts` (base URL from env, `credentials: 'include'`, CSRF header, JSON + error normalisation to `ApiError{code,message,details,requestId}`, retry policy: none for POST, 1 retry for GET), `lib/csrf.ts`.
**Acceptance:** integration test with a mocked route handler proves the CSRF header is attached to mutating calls and that errors surface `requestId`.

### FND-07 — CI pipeline
M0 · FND-02 · 3 h
**Deliverable:** `.github/workflows/ci.yml` (verify + e2e + nightly per `testing_strategy.md` §7), coverage config, doc-drift check script `scripts/check-docs.ts`.
**Acceptance:** CI runs on PR; coverage artifact uploaded; doc-drift check fails when `packages/shared/src/api.ts` changes without touching `docs/api_spec.md`.

### FND-08 — Seed script v1
M0 · FND-03 · 4 h
**Deliverable:** `scripts/seed.ts`, `scripts/reset.ts`, reads `data/seed.catalog.json`; creates merchants, categories (with `attributeSchema`), products; prints a summary table; `--demo-orders` flag stub.
**Acceptance:** `pnpm seed` twice is idempotent; product count = 24; indexes created; unknown attribute keys in seed fail the script with a clear message.

### FND-09 — Rate limiter
M0 · FND-02 · 2 h
**Deliverable:** `middleware/rateLimit.ts` with `RateLimiter` interface + in-memory LRU, per-class budgets from `security_privacy.md` §7, `RateLimit-*` headers, key hashing.
**Acceptance:** unit tests for window rollover and header values; 429 body matches the error catalogue.

### FND-10 — Feature flags
M0 · FND-02 · 1 h
**Deliverable:** `config/flags.ts` (`FEATURE_LIVE_LLM`, `FEATURE_WEBHOOKS`, `FEATURE_CHECKOUT`, `FEATURE_ANALYTICS`, `FEATURE_GUEST_ORDERS`), exposed via `/healthz` flags summary (names only).
**Acceptance:** flags default safely (checkout off is refused with a clear error, not a crash).

### FND-11 — Env example + check script
M0 · FND-02 · 1 h
**Deliverable:** `.env.example`, `docs/env_setup.md` aligned with it, `scripts/env-check.ts`.
**Acceptance:** `pnpm env:check` lists missing/invalid vars with the doc link; no secret value is committed.

### FND-12 — Quickstart validation
M0 · all · 2 h
**Deliverable:** validated README quickstart section; fixes to any friction found.
**Acceptance:** on a clean clone: `docker compose up -d mongo && pnpm i && pnpm seed && pnpm dev` boots both apps in ≤ 5 min; documented output matches reality.

---

## M1 — Catalogue & identity

### CAT-01 — Product/category/merchant models
M1 · FND-03 · 4 h
**Deliverable:** `models/{product,category,merchant,priceHistory}.ts` exactly per `docs/data_model.md` §2.4–2.7 with all declared indexes.
**Acceptance:** `syncIndexes()` produces the documented indexes (asserted in a test); product write validates `attributes` against the category `attributeSchema`.

### CAT-02 — Catalogue repository
M1 · CAT-01 · 4 h
**Deliverable:** `repositories/productRepository.ts` (query builder incl. filter translation, sort, pagination, faceting), `categoryRepository.ts`, `merchantRepository.ts`.
**Acceptance:** unit/integration tests for each sort, filter operator (`gte|lte|eq|in`), unknown filter key → `UNFILTERABLE_ATTRIBUTE`, pagination bounds.

### CAT-03 — Search & ranking service
M1 · CAT-02 · 5 h
**Deliverable:** `services/catalogueService.ts` incl. deterministic ranking (`services/ranking.ts`) with configurable weights.
**Acceptance:** identical inputs → identical ordered ids (pinned weights test); ranking honours hard filters strictly; `explain` string is generated.

### CAT-04 — Public catalogue routes
M1 · CAT-03 · 3 h
**Deliverable:** `routes/v1/products.routes.ts`, `categories.routes.ts` with zod validation and the response DTOs of `api_spec.md` §3.
**Acceptance:** contract tests for `GET /products`, `/products/:slug`, `/categories`; `404 PRODUCT_NOT_FOUND`; facets present.

### CAT-05 — Merchant product CRUD + price history
M1 · CAT-04 · 5 h
**Deliverable:** `POST/PATCH/DELETE /products` (merchant-scoped), `price_history` writes, `GET /products/:id/history`, status transitions `draft|active|archived`.
**Acceptance:** only `active` products appear in public search; stock 0 hides the product immediately; cross-merchant PATCH → 404; history row per change.

### CAT-06 — Categories + attributeSchema
M1 · CAT-01 · 3 h
**Deliverable:** category CRUD (merchant/admin), archive guard, schema seed for laptops/phones/headphones/monitors.
**Acceptance:** deleting a category with products is refused with a clear error; `attributeSchema.filterable` controls which filters are accepted.

### CAT-07 — Seed catalogue expansion
M1 · CAT-06 · 4 h
**Deliverable:** `data/seed.catalog.json` populated (24 products, 3 merchants, 4 categories) with typed attributes, pros/cons, specs, images (local SVGs).
**Acceptance:** every product validates against its category schema; the G-01 laptop query returns 3–5 results; images exist under `apps/web/public/products/`.

### CAT-08 — Product images + next/image config
M1 · FND-05 · 2 h
**Deliverable:** 24 placeholder SVGs + `remotePatterns` config + `imageLoader`.
**Acceptance:** no external CDN needed; LCP on `/products/[slug]` ≤ 2.5 s locally.

### AUTH-01 — Guest sessions
M1 · FND-03 · 4 h
**Deliverable:** session model, `POST /session/guest`, `GET /session/me`, cookie helpers, csrf cookie issuance.
**Acceptance:** first request creates exactly one session; concurrent first requests do not create duplicates (unique index + upsert); cookies httpOnly/SameSite=Lax.

### AUTH-02 — Register & login
M1 · AUTH-01 · 5 h
**Deliverable:** argon2id hashing service, `POST /auth/register`, `POST /auth/login`, password policy (zxcvbn ≥ 2, ≥ 10 chars).
**Acceptance:** weak password → `400 WEAK_PASSWORD`; duplicate email → `409 EMAIL_TAKEN`; wrong password → generic `401 INVALID_CREDENTIALS`; timing-safe verify.

### AUTH-03 — Tokens & rotation
M1 · AUTH-02 · 4 h
**Deliverable:** JWT issue/verify, refresh token issue/rotate/revoke, reuse detection with family revocation.
**Acceptance:** old refresh token reuse → `401 TOKEN_REUSE` + family revoked; access token expiry → `401 TOKEN_EXPIRED`.

### AUTH-04 — Session upgrade + cart/order claim
M1 · AUTH-03 · 4 h
**Deliverable:** upgrade path (guest session row → user), cart merge (sum quantities, cap at stock, drop unavailable), claim guest orders ≤ 24 h.
**Acceptance:** FR-1.4 tests; cart count preserved; no duplicate cart rows (`unique partial` index respected).

### AUTH-05 — RBAC middleware
M1 · AUTH-03 · 3 h
**Deliverable:** `requireAuth`, `requireRole`, `requireOrderAccess`, `requireMerchantScope`.
**Acceptance:** unit suite for each; 403 vs 404 semantics per `security_privacy.md` §3.

### WEB-01/02/03 — Catalogue pages
M1 · CAT-04 · 8 h total
**Deliverable:** `/products` grid + filter sidebar (URL as state) + `/products/[slug]` detail with gallery, specs, pros/cons, `Add to cart` (stub), `Ask the agent`.
**Acceptance:** filters survive reload and back/forward; mobile layout at 375 px; axe clean.

---

## M2 — Conversational discovery

### AGT-01 — `LlmClient` interface + FakeLlm
M2 · FND-04 · 4 h
**Deliverable:** `agent/llm.ts` (interface), `agent/fakeLlm.ts` with scripted responses keyed by prompt.
**Acceptance:** deterministic output for G-01; `usage` reported; abortable.

### AGT-02 — Orchestrator loop
M2 · AGT-01 · 6 h
**Deliverable:** `agent/orchestrator.ts` (context build, tool loop, budgets, abort, timeouts, telemetry).
**Acceptance:** respects `maxToolIterations`; aborts within 100 ms of client disconnect; logs `agent_turn_completed` with usage.

### AGT-03 — Tool registry + validation
M2 · AGT-02 · 4 h
**Deliverable:** `agent/tools/index.ts` (closed map), per-tool zod schemas, authorisation hooks, uniform error shape `{error:{code,message}}`.
**Acceptance:** unknown tool name is refused without execution and logged; invalid args produce a corrective tool result the model can recover from.

### AGT-04 — `search_products`
M2 · CAT-03, AGT-03 · 5 h
**Deliverable:** tool implementation mapping to `catalogueService` + ranking + `matched/unmet/score`, budget grace, relaxed-constraint reporting.
**Acceptance:** tool tests for: strict filters, budget grace boundary (3 %), relaxation order (soft before hard), out-of-stock exclusion.

### AGT-05 — `get_product` · 2 h
### AGT-06 — `check_availability` · 2 h
**Acceptance:** returns `priceChanged`/`previousPriceMinor` compared to the last shown price in session state.

### AGT-07 — `compare_products`
M2 · AGT-03 · 4 h
**Deliverable:** comparison builder with row order from `attributeSchema.rank`, `better` flags, caveats for non-comparable categories.
**Acceptance:** 2–4 products; mixed categories → caveat + warning; deterministic row order.

### AGT-08 — Requirement extraction + revisions
M2 · AGT-02 · 6 h
**Deliverable:** forced `set_requirement` call, heuristics fallback, validation against `attributeSchema`, revision bump rules, `PATCH /chat/sessions/:id/requirement`.
**Acceptance:** FR-3.2/3.9 tests incl. "make it under $700" bumping to revision 2 and superseding old cards.

### AGT-09 — Prompt + clarification policy
M2 · AGT-08 · 4 h
**Deliverable:** `agent/prompt.ts` (system prompt verbatim from `ai_agent_spec.md` §3), server-side clarification cap enforcement.
**Acceptance:** G-07 asks exactly ≤ 1 budget question; a third question attempt is suppressed and replaced with results + assumptions.

### AGT-10 — SSE streamer
M2 · AGT-02 · 5 h
**Deliverable:** `agent/stream.ts` emitting the exact frames of `api_spec.md` §7, heartbeat, abort cleanup.
**Acceptance:** contract test replays a scripted turn and matches frame sequences; `Cache-Control`/`X-Accel-Buffering` headers present.

### AGT-11 — Component builders
M2 · AGT-04 · 4 h
**Deliverable:** `agent/components.ts` (product_cards, comparison, clarification, cart_summary, checkout_card, order_status) with pure functions.
**Acceptance:** snapshot tests per component payload; `revision` stamped; ≤ 5 cards.

### AGT-12 — `answer_policy` + `get_quote_estimate`
M2 · AGT-03 · 3 h
**Acceptance:** policy copy comes from `packages/shared/src/policies.ts` (no model generation); empty cart → `CART_EMPTY`.

### AGT-13 — Guardrails
M2 · AGT-02 · 5 h
**Deliverable:** PII scanner/redactor, off-topic handling, untrusted-data wrapping, output post-processor (strip raw JSON/markdown tables/foreign links).
**Acceptance:** `guardrail_triggered` events emitted; card-number input is redacted before provider logging; injection-string product text does not alter tool calls.

### AGT-14 — Eval harness + golden prompts
M2 · AGT-11 · 5 h
**Deliverable:** `tests/evals/*` with G-01…G-12 and the structured assertions of `ai_agent_spec.md` §8.
**Acceptance:** 12/12 pass with FakeLlm; CI runs them; failures print a readable diff of expected vs actual components.

### AGT-15 — Agent telemetry · 2 h
### AGT-16 — Live provider adapter
M2 · AGT-01 · 4 h
**Acceptance:** `FEATURE_LIVE_LLM=true` uses the real endpoint; a smoke script runs one prompt end-to-end and prints the frames; missing `LLM_API_KEY` with the flag on fails the boot with a clear message.

### WEB-04…WEB-08 — Chat UI
M2 · AGT-10 · 14 h total
**Deliverable:** `ChatPane`, `Transcript`, `MessageBubble`, `StreamingText`, `ToolActivity`, `Composer`, `RequirementBar` + chips, `QuickReplies`, `ProductCardGrid`, `RecommendationCard`, `ComparisonTable`, `SupersededBadge`, `ContextRail` skeleton.
**Acceptance:** US-1/2/3 render correctly; streaming is throttled and `aria-live`-safe; Enter/Shift+Enter behaviour; Esc stops generation; mobile bottom-sheet layout; axe clean.

---

## M3 — Cart & quote

### CART-01 — Cart model/repository · 4 h · indexes per `data_model.md` §2.8; unique active cart per owner.
### CART-02 — Cart service · 6 h
**Acceptance:** quantity caps at `min(stock,10)`; line limit 20; subtotal recomputed from live prices on every read; `priceChangedFromMinor` flagged.
### CART-03 — Cart routes + idempotency · 4 h
**Acceptance:** `Idempotency-Key` replay returns the stored body with `Idempotent-Replay: true`; unknown product → 404; archived → 409.
### CART-04 — Inventory holds · 5 h
**Acceptance:** available-to-sell = stock − active holds; concurrent hold creation for the last unit → exactly one succeeds.
### CART-05 — Quote service · 6 h
**Acceptance:** shipping table all 4 branches; tax = `round(subtotal*825/10000)`; `hash` stable for identical inputs and changes when a price changes; total invariant.
### CART-06 — `POST /checkout/quote` · 4 h
**Acceptance:** warnings for low stock/price change/unavailable; holds extended but never beyond 15 min from creation; `409 ITEM_UNAVAILABLE` lists exact items.
### CART-07 — Agent cart tools · 6 h
**Acceptance:** `remove_cart_item`/`clear_cart` require an affirmative in the transcript (`NEEDS_CONFIRMATION` otherwise); stock errors relayed verbatim.
### CART-08 — `cart.updated` SSE frame · 2 h
### CART-09 — Hold expiry job · 3 h
**Acceptance:** expired holds release availability; orders still `awaiting_payment` past expiry → `expired`.
### CART-10 — Cart/quote analytics · 2 h
### WEB-09…WEB-13 — Cart UI · 12 h
**Deliverable:** `CartButton`, `CartDrawer`, `CartLineItem`, `QtyStepper`, `CartTotals`, `FreeShippingMeter`, `/cart` page, `/checkout/quote` integration.
**Acceptance:** US-4; optimistic quantity with rollback; price-change alert; axe clean; keyboard-operable drawer with focus trap.

---

## M4 — Orders

### ORD-01 — Order model + order numbers · 4 h
### ORD-02 — State machine guard · 3 h
**Acceptance:** forbidden transitions → `409 INVALID_STATE`; `payment_failed → paid` impossible (test).
### ORD-03 — `POST /orders` · 6 h
**Acceptance:** quote hash check → `409 QUOTE_STALE` with `diff[]`; holds committed; cart converted in the same transaction; unique `idempotencyKey`.
### ORD-04 — `GET /orders/{orderId}` · 3 h
**Acceptance:** owner/session/merchant/admin access matrix tested; `quotePreview` only for payable states.
### ORD-05 — `GET /orders` · 3 h
### ORD-06 — Cancel · 3 h
**Acceptance:** releases holds, voids the PayPal order when `CREATED`, `cancelled` terminal.
### ORD-07 — Timeline events · 2 h
### ORD-08 — `prepare_checkout` tool · 4 h
**Acceptance:** requires `confirm:true` and a settled cart; returns `requiresApproval: true`; never creates a PayPal order (asserted).
### ORD-09 — Guest order policy · 2 h
### ORD-10 — Order analytics · 2 h
### WEB-14…WEB-16 — Checkout summary UI · 10 h
**Acceptance:** US-5 (pre-payment part) and US-8; `ApprovalPanel` idle state with amount in the button label; reload-safe route keyed by `orderId`.

---

## M5 — PayPal payment

### PAY-01 — PayPal client · 6 h
**Acceptance:** token cached and single-flighted; sandbox assertion at boot; timeouts/retries per doc; errors mapped.
### PAY-02 — Payment attempt model · 3 h
### PAY-03 — Request builder · 4 h
**Acceptance:** breakdown sum assertion; 2-decimal strings; `custom_id`/`invoice_id` = orderNumber; items/quantities correct; deterministic `PayPal-Request-Id`.
### PAY-04 — Create order integration · 4 h
### PAY-05 — Advisory lock · 3 h
**Acceptance:** concurrent acquisition → one winner; lock TTL recovery tested.
### PAY-06 — Capture endpoint · 5 h
### PAY-07 — `verifyCapture` V1–V7 · 6 h
**Acceptance:** one test per check; every failure leaves the order non-`paid`; metrics incremented.
### PAY-08 — Transactional apply · 6 h
**Acceptance:** stock commit atomic across lines; any failure aborts and marks `payment_failed` with `STOCK_COMMIT_FAILED` (+ refund task recorded).
### PAY-09 — Error mapping · 4 h
**Acceptance:** the §6 failure matrix rows are exercised by tests.
### PAY-10 — `INSTRUMENT_DECLINED` contract · 2 h
### PAY-11 — Receipts · 3 h
### PAY-12 — Payment analytics · 2 h
### PAY-13 — Contract tests (nock) · 5 h
### PAY-14 — Sandbox manual checklist · 3 h
**Acceptance:** executed and recorded with timestamps and sandbox buyer emails (hashed).
### PAY-15 — Status endpoint · 2 h
### PAY-16 — Confirmation payload · 3 h
### WEB-17…WEB-19 — PayPal UI · 10 h
**Deliverable:** `PayPalButtonsHost` (dynamic, ssr:false), `PaymentStatusPanel` (processing/succeeded), redirect to confirmation, `OrderReceiptCard`.
**Acceptance:** US-6 and US-10 in sandbox; SDK failure fallback works; no secret in the bundle (CI grep).

---

## M6 — Failure paths & reconciliation

### PAY-17 — Webhook route + verification + dedupe · 6 h
**Acceptance:** invalid signature → stored, no state change, 200; duplicate event → `deduplicated: true`.
### PAY-18 — Event handlers · 6 h
**Acceptance:** `CAPTURE.COMPLETED` for a crashed capture applies `paid`; `DENIED` never downgrades a paid order; `REFUNDED` sets `refunded` without restoring stock.
### PAY-19 — Reconcile job · 5 h
**Acceptance:** I8 invariant (no order stuck in `payment_processing` > 30 min) holds in tests with fake timers.
### PAY-20 — Retry + attempt cap · 4 h
**Acceptance:** new attempt, new PayPal order, cap at 3 → `PAYMENT_ATTEMPT_LIMIT`; final state one `paid`.
### PAY-21 — Pending polling · 3 h
### PAY-22 — Negative testing config · 2 h
### PAY-23 — Nightly integrity check · 3 h
### PAY-24 — Admin reconcile endpoint · 3 h
### WEB-20…WEB-22 — Failure UI · 8 h
**Deliverable:** `RetryPaymentPanel`, pending/cancelled/failed states, hold countdown + extend, `PriceChangeDiff`, `UnavailableItemNotice`, `/orders` history.
**Acceptance:** US-7 and US-8; every failure message states what did **not** happen; "Back to cart" preserves the cart.

---

## M7 — Merchant dashboard

### MER-01 — Merchant scoping · 3 h
### MER-02/03 — Product list + inline edit · 6 h
**Acceptance:** price/stock edit → optimistic UI, rollback on error, `price_history` row, `product_updated` event.
### MER-04 — Product form · 6 h
**Acceptance:** attributes validated per category schema; unknown attribute rejected at the field level.
### MER-05 — Category CRUD · 4 h
### MER-06 — Orders table · 4 h
### MER-07 — Order detail + attempt timeline · 4 h
### MER-08 — Mark shipped · 3 h
### MER-09 — Overview tiles · 4 h
### MER-10 — Low-stock list · 2 h
### MER-11 — Tenant isolation suite · 4 h
**Acceptance:** every merchant route tested for cross-tenant 404.
### MER-12 — Agent-visibility test · 3 h
**Acceptance:** stock → 0 removes the product from `search_products` within the same request cycle.
### WEB-23…WEB-26 — Merchant UI · 12 h
**Acceptance:** US-9; dashboard usable at 1280 px and 375 px; axe clean.

---

## M8 — Analytics

### ANL-01 — Event registry · 3 h · `.strict()` schemas per event from `analytics_spec.md` §4.
### ANL-02 — Server emit helper + queue · 3 h
### ANL-03 — Client beacon + hook · 3 h · batching ≤ 20, sendBeacon on unload, DNT suppression.
### ANL-04 — Impression observer · 3 h · IntersectionObserver thresholds per spec.
### ANL-05 — Funnel aggregation · 5 h
**Acceptance:** unit test against the hand-computed fixture (1 840/312/96/41).
### ANL-06 — Timeseries + top products · 4 h
### ANL-07 — Payment health panel · 3 h
### ANL-08 — Daily rollup job · 3 h
### ANL-09 — Synthetic seed events · 3 h
### ANL-10 — Funnel reconciliation test · 2 h
### WEB-27…WEB-29 — Analytics UI · 8 h
**Acceptance:** `AnalyticsFunnel`, `MetricTimeseries`, `TopProductsTable`, definitions footnote; numbers readable without colour.

---

## M9 — Hardening & demo

### QA-01 — Accessibility pass · 6 h · axe clean on all key routes + keyboard-only money path + reduced motion + screen-reader transcript check.
### QA-02 — Contrast script · 2 h · asserts AA ratios for the token pairs.
### QA-03 — Lighthouse budgets · 3 h
### QA-04 — k6 load smoke · 4 h · catalogue/chat/checkout scripts with budgets.
### QA-05 — Error boundaries + offline copy · 3 h
### QA-06 — Seed reset + demo data · 3 h · one command → demo-ready DB (24 products, 1 paid order, 1 failed order, 1 draft, synthetic analytics).
### QA-07 — Demo script · 2 h · step-by-step with expected screens and fallbacks (webhook down, sandbox slow).
### QA-08 — Runbooks · 3 h · rotate secrets, replay webhooks, reconcile orders, restore DB.
### QA-09 — Security checklist run · 4 h · `security_privacy.md` §10 items verified with evidence.
### QA-10 — Dependency audit · 2 h · `pnpm audit --prod` clean or documented.
### QA-11 — Docs final pass · 4 h · README §3 reproducible, screenshots updated, doc-drift check green.
### QA-12 — Container images · 4 h · both Dockerfiles build and run; compose `--profile full` works.
### QA-13 — Backup/restore · 2 h · dump/restore the demo DB and re-run the demo.
### QA-14 — Timed rehearsal · 2 h · full demo ≤ 10 min, twice, including one deliberate failure.

---

## FUT (deferred, do not start)

`FUT-01` refunds UI · `FUT-02` multi-currency · `FUT-03` real shipping rates · `FUT-04` wishlists/alerts · `FUT-05` coupons · `FUT-06` reviews · `FUT-07` image uploads · `FUT-08` personalisation ML · `FUT-09` voice/multimodal input · `FUT-10` marketplace payouts · `FUT-11` admin ops console · `FUT-12` email/SMS notifications beyond receipts.
