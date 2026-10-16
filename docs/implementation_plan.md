<!-- AS-BUILT NOTE: the reference implementation in app/ is a single Express service with a
     vanilla-JS frontend. This document is a plan written for a pnpm+Turborepo monorepo with
     Next.js and MongoDB; ticket IDs here do not map 1:1 to the shipped code. See FEATURES.md
     (what exists), GAPS.md (what is missing) and the app/ tree for the artifact. -->

# ShopPilot AI — Implementation Plan

A build order an AI coding agent (or a small team) can execute milestone by milestone. Each milestone ends at a **demoable, tested** state. Ticket IDs reference `docs/backlog.md`.

Budget assumption: one focused agent/engineer ≈ 10 working days for M0–M6 (the demo-critical path), plus 4–5 days for M7–M9. Do not start M7 before M6 is green.

---

## Milestone overview

| M | Theme | Tickets | Exit demo |
|---|---|---|---|
M0 | Foundation | FND-01…FND-12 | `pnpm dev` boots, `/healthz` green, CI runs
M1 | Catalogue & identity | CAT-01…CAT-14, AUTH-01…AUTH-08 | Merchant can CRUD products; guest/customer sessions work; `/products` renders
M2 | Conversational discovery | AGT-01…AGT-16, WEB-01…WEB-08 | Chat returns grounded recommendations with cards and comparisons
M3 | Cart & quote | CART-01…CART-10, WEB-09…WEB-13 | Cart drawer works; quote shows subtotal/shipping/tax/total
M4 | Orders | ORD-01…ORD-10, WEB-14…WEB-16 | Checkout summary + explicit approval screen; order states enforced
M5 | PayPal payment | PAY-01…PAY-16, WEB-17…WEB-19 | Sandbox payment completes → order `paid` → confirmation page
M6 | Failure & reconciliation | PAY-17…PAY-24, WEB-20…WEB-22 | Decline/pending/cancel/duplicate paths all behave
M7 | Merchant dashboard | MER-01…MER-12, WEB-23…WEB-26 | Products/orders/categories managed; stock edits affect the agent
M8 | Analytics | ANL-01…ANL-10, WEB-27…WEB-29 | Funnel dashboard reconciles with seeded events
M9 | Hardening & demo | QA-01…QA-14 | A11y, load smoke, seed reset, demo script, final docs

---

## M0 — Foundation (day 0–1)

**Goal:** an empty-but-real skeleton: monorepo, CI, env validation, health endpoints, design tokens, and the docs committed.

Order of work:
1. `FND-01` pnpm workspace + Turborepo + tsconfig/eslint/prettier presets in `packages/config`.
2. `FND-02` `apps/api` Express 5 skeleton: `app.ts`, `env.ts` (zod, fail-fast), pino logger, error handler, `/healthz`, `/readyz`, `/version`, request-id middleware.
3. `FND-03` Mongo connection module + `docker-compose.yml` with a single-node replica set + `mongodb-memory-server` test setup (transactions must work in tests).
4. `FND-04` `packages/shared`: `money.ts` (`toMinor`, `formatMoney`, `assertInteger`), `orderState.ts`, `analytics.ts` event names, `api.ts` DTO scaffolding, `categorySchemas.ts`.
5. `FND-05` `apps/web` Next.js 16 App Router skeleton + Tailwind v4 + `tokens.css` from `design_system.md` §2 + `AppShell`/`TopBar`/`Footer` with the sandbox disclosure.
6. `FND-06` API client in the web app: cookie handling, CSRF header, error normalisation with `requestId`, retry rules.
7. `FND-07` CI workflow: format/lint/typecheck/unit, coverage upload, doc-drift check.
8. `FND-08` `scripts/seed.ts` + `seed:reset` reading `data/seed.catalog.json` (products only for now).
9. `FND-09` Rate limiter interface + in-memory implementation; middleware wired but permissive in dev.
10. `FND-10` Feature flags module.
11. `FND-11` `.env.example` + `docs/env_setup.md` verification script (`pnpm env:check`).
12. `FND-12` README quickstart validated on a clean machine/container.

**Definition of done:** `pnpm i && docker compose up -d mongo && pnpm dev` starts both apps; `curl :4000/healthz` → `{status:"ok"}`; `pnpm verify` green; CI green on the initial PR.

---

## M1 — Catalogue & identity (day 1–3)

Order: `CAT-01` models/indexes → `CAT-02` repository → `CAT-03` search service + filter translation → `CAT-04` public routes → `CAT-05` merchant CRUD + `price_history` → `CAT-06` categories + `attributeSchema` → `CAT-07` seed expansion to 24 products with typed attributes → `AUTH-01` guest session middleware → `AUTH-02` register/login (+argon2) → `AUTH-03` JWT + refresh rotation → `AUTH-04` session upgrade + cart claim → `AUTH-05` RBAC middleware → `WEB-*` catalogue pages (grid, filters, detail).

**DoD:** FR-1.1…1.6, FR-2.1…2.6 accepted; the agent-facing search contract (`docs/api_spec.md` §3) returns typed attributes; tenant isolation tests green; `/products` server-rendered with URL-synced filters.

**Risk:** schema drift between `attributeSchema` and product `attributes` — mitigated by validating on write and by the seed being generated from the schema.

---

## M2 — Conversational discovery (day 3–6)

Order:
1. `AGT-01` `LlmClient` interface + `FakeLlmClient` (scripted) so everything downstream is testable without a provider.
2. `AGT-02` orchestrator loop (iterations, timeouts, abort, token budgets).
3. `AGT-03` tool registry + Zod argument validation + authorisation hooks.
4. `AGT-04` `search_products` + ranking service (pinned weights).
5. `AGT-05` `get_product`, `AGT-06` `check_availability`, `AGT-07` `compare_products` (+ comparison row ordering from `attributeSchema.rank`).
6. `AGT-08` requirement extraction (`set_requirement` forced tool + `lib/heuristics.ts` fallback) and revision bumping.
7. `AGT-09` system prompt + clarification policy enforcement (server-side refusal if > 2 questions).
8. `AGT-10` SSE streamer + frame contract (`api_spec.md` §7).
9. `AGT-11` component builders (`components.ts`) — cards, comparison, clarification.
10. `AGT-12` `answer_policy` + `get_quote_estimate` (read-only).
11. `AGT-13` guardrails: PII scan, off-topic handling, untrusted-product-text wrapping, output post-processing.
12. `AGT-14` eval harness + golden prompts G-01…G-12 (FakeLlm scripts).
13. `AGT-15` token/usage logging + `agent_turn_completed` analytics.
14. `AGT-16` live provider adapter (`OpenAiCompatClient`) behind `FEATURE_LIVE_LLM`.
15. `WEB-*` chat UI: `ChatPane`, `Transcript`, `MessageBubble`, `StreamingText`, `ToolActivity`, `Composer`, `RequirementBar`, quick replies, product card grid, comparison table, superseded markers.

**DoD:** US-1, US-2, US-3 pass; evals 12/12 with FakeLlm; live provider manual smoke with one prompt; SSE frame contract test green; no payment tool exists anywhere in the registry.

---

## M3 — Cart & quote (day 6–7)

`CART-01` cart model+repository → `CART-02` add/update/remove/clear services with live price recompute and stock caps → `CART-03` cart routes + idempotency → `CART-04` `inventoryService` available-to-sell + holds CRUD → `CART-05` `quoteService` (shipping table, 8.25 % tax, hash, TTL) → `CART-06` `POST /checkout/quote` + hold creation/extension → `CART-07` agent cart tools (`add_to_cart`, `update_cart_item`, `remove_cart_item`, `view_cart`, `clear_cart` with confirmation rule) → `CART-08` `cart.updated` SSE frame → `CART-09` release-expired-holds job → `CART-10` analytics events for cart/quote. Web: `CartDrawer`, `CartLineItem`, `QtyStepper`, `CartTotals`, `FreeShippingMeter`, `/cart` page.

**DoD:** US-4 passes; tamper test passes; quote math table-driven tests all green; hold expiry restores availability.

---

## M4 — Orders (day 7–8)

`ORD-01` order model + snapshots + `orderNumber` counter → `ORD-02` state machine module + guard in service → `ORD-03` `POST /orders` (quote hash check, holds commit, cart→converted, transaction) → `ORD-04` `GET /orders/{id}` owner-scoped with `quotePreview` → `ORD-05` `GET /orders` (customer/session) → `ORD-06` cancel → `ORD-07` timeline events → `ORD-08` `prepare_checkout` agent tool with confirmation rule → `ORD-09` guest order access policy (session window) → `ORD-10` order analytics. Web: `/checkout/[orderId]` with `CheckoutSummary`, warnings, `ApprovalPanel` (idle state only), price-diff UI.

**DoD:** US-5 passes; `409 QUOTE_STALE` and `409 ITEM_UNAVAILABLE` render correctly; nothing can create a PayPal order yet (this milestone stops at `awaiting_payment`).

---

## M5 — PayPal payment (day 8–10)

`PAY-01` PayPal client (OAuth cache, timeouts, retries, sandbox assertion) → `PAY-02` `payment_attempts` model → `PAY-03` request builder + payload assertions → `PAY-04` create-order call in `POST /orders` → `PAY-05` advisory lock module → `PAY-06` capture endpoint → `PAY-07` `verifyCapture` (V1–V7) → `PAY-08` transactional apply (order paid, stock commit, holds, cart, soldCount) → `PAY-09` capture error mapping to the failure matrix → `PAY-10` `INSTRUMENT_DECLINED` handling contract with the frontend → `PAY-11` receipts (mailer interface, console transport) → `PAY-12` payment analytics → `PAY-13` contract tests with nock fixtures → `PAY-14` sandbox manual run checklist → `PAY-15` `GET /payments/{orderId}/status` → `PAY-16` confirmation endpoint data. Web: `PayPalButtonsHost`, `PaymentStatusPanel` (success), redirect to `/orders/[id]/confirmation`, `OrderReceiptCard`.

**DoD:** US-6 and US-10 pass against **sandbox**; the manual checklist is executed and recorded; no live credentials anywhere; `PAYPAL_ENV=sandbox` asserted at boot.

---

## M6 — Failure paths & reconciliation (day 10–12)

`PAY-17` webhook route (raw body) + signature verification + dedupe store → `PAY-18` event handlers (`APPROVED`, `CAPTURE.COMPLETED/DENIED/PENDING/REFUNDED`) → `PAY-19` reconcile job → `PAY-20` retry endpoint + attempt cap → `PAY-21` pending polling → `PAY-22` negative-testing sandbox config → `PAY-23` integrity nightly check → `PAY-24` admin reconcile endpoint. Web: `RetryPaymentPanel`, pending/cancelled/failed states, hold countdown + extend, back-to-cart safety, `/orders` list.

**DoD:** US-7 and US-8 pass; injected failures never produce `paid`; duplicate approval produces exactly one order/attempt/capture; the failure matrix table in `docs/payments_paypal.md` §6 has a passing test per row.

---

## M7 — Merchant dashboard (day 12–14)

`MER-01` merchant scoping middleware → `MER-02`/`MER-03` merchant product list/patch with inline price+stock (optimistic UI + rollback) → `MER-04` product form with per-category attributes → `MER-05` category CRUD + archive guard → `MER-06` order list + filters → `MER-07` order detail + `PaymentAttemptTimeline` → `MER-08` `mark_shipped` → `MER-09` overview tiles → `MER-10` low-stock list → `MER-11` tenant isolation test suite → `MER-12` `product_updated` analytics + agent-visibility test.

**DoD:** US-9 passes (stock → 0 removes the product from agent search within one request); cross-tenant access returns 404 everywhere.

---

## M8 — Analytics (day 14–15)

`ANL-01` event schema registry (allow-list + `.strict()`) → `ANL-02` server emit helper + queue → `ANL-03` client beacon + `useAnalytics` hook → `ANL-04` impression observer → `ANL-05` funnel aggregation → `ANL-06` timeseries + top products → `ANL-07` payment health panel data → `ANL-08` daily rollup job → `ANL-09` seed synthetic events → `ANL-10` funnel reconciliation test. Web: `/merchant/analytics` with `AnalyticsFunnel`, `MetricTimeseries`, `TopProductsTable`, definitions footnote.

**DoD:** the funnel in the seeded demo matches the documented numbers (1 840 / 312 / 96 / 41); F1 ≥ F2 ≥ F3 ≥ F4 invariant holds; no PII in events (test).

---

## M9 — Hardening & demo (day 15–17)

`QA-01` full a11y pass (axe + manual keyboard + reduced motion) → `QA-02` contrast script → `QA-03` Lighthouse budgets → `QA-04` k6 load smoke (catalogue, chat, checkout) → `QA-05` error-boundary and offline copy → `QA-06` seed reset + demo orders + synthetic analytics → `QA-07` demo script (`docs/demo_script.md` to be produced from README §3) → `QA-08` runbooks: rotate secrets, replay webhooks, reconcile → `QA-09` security checklist run → `QA-10` dependency audit + lockfile → `QA-11` README/docs final pass + screenshots → `QA-12` container images build and run → `QA-13` backup/restore of the demo DB → `QA-14` final end-to-end rehearsal with a timer (≤ 10 min).

**DoD:** README §3 demo reproduces from a reset DB in under 10 minutes, twice in a row, including one deliberate payment failure.

---

## Cross-cutting work rules

1. **Docs-first per ticket.** If a ticket needs a new field, endpoint, event or tool, update the relevant doc *in the same commit*; CI runs a drift check (`pnpm check:docs`).
2. **One milestone, one branch, one PR series.** Never mix milestones in a branch — the failure-path work (M6) must not be entangled with dashboard work (M7).
3. **Test before moving on.** A milestone is not done until its DoD tests are green in CI, not just locally.
4. **Freeze the contracts at M2 end** (`openapi.yaml`, `agent_tools.json`, SSE frames). Later changes require a versioned migration note in the PR.
5. **No floating dependencies.** Pin versions; commit the lockfile; no new dependency without justifying why the platform/library cannot do it.
6. **Money-path changes require a second pass.** Any diff touching `paymentService`, `quoteService`, `inventoryService` or the capture route must re-run `test:integration` + the invariant checks and state in the PR how idempotency/verification is preserved.

---

## Risk register (build-time)

| # | Risk | Likelihood | Impact | Mitigation | Trigger |
|---|---|---|---|---|---|
B1 | LLM tool-calling unreliability across providers | M | H | FakeLlm in CI; prompt hardened by evals; structured extraction via forced tool; heuristics fallback | evals < 12/12 |
B2 | PayPal sandbox flakiness/rate limits | M | M | nock fixtures for all CI; sandbox only in nightly/manual; retries with same request id | repeated 5xx/timeouts |
B3 | Transaction support missing (Mongo not RS) | M | H | docker-compose RS + memory-server RS in tests; `/readyz` reports RS status | `Transaction numbers are only allowed on a replica set` |
B4 | Scope creep (refunds, multi-currency, real shipping) | H | M | non-goals in PRD §1.2; backlog only; defer tickets `FUT-*` | sprint plan shows unplanned work |
B5 | Agent cost/latency spikes | M | M | per-turn budgets, context trimming, caching of product lookups, `maxToolIterations` | p95 first-token > 3 s |
B6 | Frontend/back contract drift | M | M | Zod as the single source + `check:contract` in CI | CI drift failure |
B7 | Demo-day webhook tunnel issues | M | H | recorded fixtures + replay tool + manual reconcile endpoint; a "no-webhook" capture path that works synchronously | tunnel down |
B8 | Test suite too slow to be run | M | M | unit < 60 s, integration < 5 min, e2e in a separate job | CI > 15 min |
B9 | Accessibility issues found late | M | M | per-component axe checks from M2; a11y gate in CI | axe violations accumulate |
B10 | Secret leakage into client bundle | L | H | `NEXT_PUBLIC_*` discipline + CI grep of `.next/static` | CI grep match |

---

## Post-v1 backlog (explicitly deferred)

Multi-currency and locale-aware tax · real shipping rates and carrier integration · refunds UI + partial refunds · wishlists and back-in-stock alerts · real payments (live PayPal onboarding, KYC, marketplace payouts) · seller onboarding · reviews and Q&A · image upload/CDN pipeline · product recommendations ML (personalisation) · voice input and multimodal (photo search) · email/SMS notifications beyond receipts · coupon/promotion engine · subscription/recurring orders · admin fraud rules · mobile app (React Native) reusing `packages/shared`.
