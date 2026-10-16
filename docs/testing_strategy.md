# ShopPilot AI — Testing Strategy

Goal: the demo can fail in front of stakeholders only through human error, not through code. Emphasis is deliberately uneven — **the money path and the agent's grounding get the most tests**; UI chrome gets the least.

CI entry point: `pnpm verify` = `format:check && lint && typecheck && test:unit && test:integration && test:contract && test:evals && build`.

---

## 1. Test pyramid (targets)

| Layer | Tooling | Scope | Target |
|---|---|---|---|
Unit | Vitest | pure logic: money math, shipping/tax rules, ranking, state machines, requirement extraction heuristics, Zod schemas, formatters | ~200 tests, **≥ 90 %** coverage of `packages/shared` + `apps/api/src/services/**/pure*` |
Integration | Vitest + `mongodb-memory-server` (single-node RS) + `supertest` | full route → service → DB with real Mongo, mocked PayPal/LLM | ≥ 70 % line coverage of `apps/api/src`, **100 %** of `services/paymentService.ts`, `services/quoteService.ts`, `services/inventoryService.ts` |
Contract | Vitest + `nock` fixtures recorded from sandbox | PayPal request/response shapes; OpenAPI ↔ Zod drift; SSE frame schema | one test per documented PayPal call and per SSE event |
Agent evals | Vitest + `FakeLlmClient` (CI) / live model (nightly) | golden prompts G-01…G-12 with structured assertions | 12/12 pass in CI |
E2E | Playwright | guest happy path, payment failure path, retry, merchant stock edit → availability change, a11y scan | 6 scenarios, run on PR + nightly |
Manual | checklist | sandbox funding-source variants, real webhook delivery, a11y screen-reader pass | every release |

Coverage is reported with `c8` and uploaded as a CI artifact; a drop of > 2 % blocks the merge.

---

## 2. Test environment & fixtures

* `tests/setup/mongo.ts` — spins `mongodb-memory-server` with `--replSet rs0` and initiates the set so transactions work; each test file gets a clean database (`db.dropDatabase()` in `beforeEach`).
* `tests/setup/seed.ts` — inserts the 24-product catalogue from `data/seed.catalog.json` + 3 merchants + categories with `attributeSchema`; exposes `seedFixture('laptopUnder900')` helpers.
* `tests/fixtures/paypal/*.json` — recorded sandbox responses: create order, capture COMPLETED, capture DECLINED, capture PENDING (eCheque), `ORDER_ALREADY_CAPTURED` error, voided order, webhook payloads (with valid signature fixture inputs and a stub `verify-webhook-signature` response).
* `tests/setup/fakeLlm.ts` — scripted `LlmClient`; scripts are keyed by user message and return deterministic tool calls + text, matching the expected components.
* Time is controlled: `vi.useFakeTimers()` for TTL/hold/expiry tests; Mongo TTL monitors are **not** used in tests (jobs are invoked directly and asserted on their effects).
* Clock injection: `services/clock.ts` provides `now()`; every expiry comparison goes through it.

---

## 3. Mandatory test list (the "never break this" suite)

Money & orders
1. `quote: line totals, subtotal, shipping rule table (all 4 branches), tax rounding, total invariant` — table-driven.
2. `quote: tamper resistance` — a client posting `{ priceMinor: 1 }` changes nothing.
3. `order: snapshot immutability` — merchant changes price after order creation; order totals and titles unchanged.
4. `order: state machine` — every allowed transition works; a table of forbidden transitions returns `409 INVALID_STATE`; `payment_failed → paid` is impossible.
5. `order: orderNumber sequence` — 1 000 concurrent creations produce unique sequential numbers without gaps in the demo range.
6. `inventory: oversell` — 5 concurrent captures for a 3-unit product: exactly 3 succeed, 2 fail cleanly, `stock ≥ 0`.
7. `hold: expiry releases stock` — hold expires → available-to-sell recovers → product searchable again.
8. `checkout: quote stale detection` — price change between quote and approve → `409 QUOTE_STALE` with the diff.
9. `checkout: item unavailable` — stock hits 0 after quote → `409 ITEM_UNAVAILABLE`, no PayPal call.
10. `capture: happy path end-to-end` (mocked PayPal) — order `paid`, capture id stored, stock decremented, cart converted, analytics emitted exactly once.
11. `capture: decline` — `payment_failed`, stock unchanged, retry permitted, exactly one `payment_attempts` row.
12. `capture: idempotent replay` — same `Idempotency-Key` twice → one attempt-less capture, `Idempotent-Replay: true`, one PayPal capture call.
13. `capture: concurrent` — two parallel calls → one PayPal call, both return the same paid order.
14. `capture: amount mismatch` — PayPal returns a different amount → never `paid`, `VERIFY_MISMATCH` recorded, alert metric incremented.
15. `capture: duplicate capture id on another order` → `DUPLICATE_CAPTURE`, no state change.
16. `capture: pending → webhook completes` — `payment_processing` → `PAYMENT.CAPTURE.COMPLETED` webhook → `paid`.
17. `capture: hold expired` → `409 HOLD_EXPIRED`, order `expired`, no PayPal call.
18. `retry after failure` — new attempt, new PayPal order, final state exactly one `paid`.
19. `webhook: signature invalid` → stored with `signatureVerified:false`, no state change.
20. `webhook: duplicate` → `deduplicated: true`, single transition.
21. `webhook: capture completed for failed write` (simulated crash) → reconciliation or webhook applies `paid` from PayPal truth.
22. `recon job: pending order completed upstream` → converges to `paid`; `voided` upstream → `payment_failed`.
23. `integrity: no paid order without capture id` (invariant I3) — runs over the seeded demo DB too.

Agent & catalogue
24. `agent: constraints respected` for G-01, G-03, G-07, G-09 — no card outside the hard constraints.
25. `agent: no hallucination` — every numeric claim in the text maps to a tool result.
26. `agent: clarification policy` — ≤ 2 questions, only from the allowed set.
27. `agent: no payment by agent` — no tool can create/capture a payment; `prepare_checkout` returns `requiresApproval`.
28. `agent: supersession` — after a revision bump, no stale cards in the new payload.
29. `agent: tool errors relayed honestly` — a simulated catalogue failure produces an apology, not a fabricated result.
30. `agent: off-topic redirect` and `agent: PII redaction` (card-number-like input).
31. `search: attribute filter translation` — `ramGb_gte=16` yields only matching products; unknown filter key → 400.
32. `search: ranking determinism` — same inputs → same ordered ids (pinned weights).
33. `catalogue: merchant edit → search visibility` — stock 0 removes the product from agent results in the next call.

Auth & security
34. `auth: guest → register merges cart` (sums capped by stock, unavailable lines dropped) and claims eligible orders.
35. `auth: refresh rotation + reuse detection`.
36. `authz: tenant isolation` — merchant A cannot read/patch B's product/order (404), customer cannot see another session's order.
37. `csrf: missing token rejected` on `/orders`, `/cart/items`, `/payments/*/capture`, `/chat/stream`.
38. `validation: NoSQL injection attempts rejected`.
39. `rate limit: chat 20/5min, auth 10/15min` return 429 with headers.
40. `logs: no secrets/PII` — capture stdout during a scripted flow and assert the redaction list.

Analytics
41. `events: exactly once per action` (including retry scenarios).
42. `analytics: funnel math` against a hand-computed fixture.
43. `analytics: PII rejection` — an event with `email` in props is dropped.

UI/E2E
44. Guest happy path: land → chat → cards → add to cart → checkout → approve → PayPal sandbox (test buyer) → confirmation with `paid`.
45. Payment failure path: declined buyer → failed panel → retry → success; DB shows one order, two attempts.
46. Merchant stock edit hides the product from chat search within the same session.
47. `jest-axe`/`axe-core` scan on `/`, `/chat`, `/checkout/[id]`, `/orders/[id]/confirmation`, `/merchant/*` — zero violations (critical/serious).
48. Keyboard-only run of the money path (Playwright keyboard).

---

## 4. PayPal testing approach (no live money in CI)

| Technique | Use |
|---|---|
`nock` fixtures | default for unit/contract/integration — fast, deterministic |
Sandbox with test buyers | nightly E2E only, using sandbox credentials and low-value ($1) test products |
Sandbox "negative testing" | enable in the app settings to force `INSTRUMENT_DECLINED`/`INSUFFICIENT_FUNDS` responses deterministically |
Webhook delivery | ngrok tunnel + PayPal's webhook simulator for manual verification; recorded payloads become fixtures |
Assertion helper | `expectPayPalPayload(order)` verifies 2-decimal strings, breakdown sum, `custom_id`, quantities as strings |
Secret hygiene | sandbox creds in CI secrets; tests assert the flag `PAYPAL_ENV !== 'live'` before any real network call |

Idempotency testing: run the same logical operation twice and assert payload equality **including** the `PayPal-Request-Id` header — this is what proves we never double-charge.

---

## 5. Accessibility testing

* Automated: `jest-axe` per component story + `@axe-core/playwright` per E2E page; CI fails on `serious`/`critical`.
* Manual per release: keyboard-only checkout, VoiceOver (Safari) and NVDA (Firefox) pass over the chat transcript and the payment panel, 200 % zoom, `prefers-reduced-motion`, forced-colors/high-contrast.
* Specific checks: streaming text does not flood the live region; the `Approve & Pay` button exposes the amount in its accessible name; error alerts are announced; price changes are announced politely in the cart.
* Colour: contrast tokens verified once with a script (`tests/a11y/contrast.test.ts`) that computes ratios for the token pairs in `design_system.md` §2.2 — fails the build if a pair drops below AA.

---

## 6. Performance & load testing

* `k6` script `tests/load/catalogue.js`: 200 VU, 3 min mixed browse+search; budgets: p95 < 250 ms, error rate < 1 %.
* `k6` script `tests/load/chat.js`: 20 concurrent SSE streams with FakeLlm; budget: first token p95 < 1 000 ms, no dropped frames, memory stable.
* `k6` script `tests/load/checkout.js`: 50 orders/min against mocked PayPal for 5 min; asserts no oversell, no duplicate order numbers, no 5xx.
* Frontend: Lighthouse CI on `/`, `/chat`, `/products/[slug]`, `/checkout` — LCP ≤ 2.5 s, CLS ≤ 0.1, INP ≤ 200 ms, bundle budget: chat route JS ≤ 220 kB gzip (PayPal SDK loaded lazily and excluded from the initial bundle).
* Regression guard: PRs that add > 15 kB gzip to a route need a justification in the PR body.

---

## 7. CI pipeline

```yaml
# .github/workflows/ci.yml (shape)
jobs:
  verify:
    steps:
      - pnpm install --frozen-lockfile
      - pnpm format:check
      - pnpm lint
      - pnpm typecheck
      - pnpm test:unit -- --coverage
      - pnpm test:integration        # mongodb-memory-server
      - pnpm test:contract           # nock fixtures + openapi drift
      - pnpm test:evals              # FakeLlm golden prompts
      - pnpm check:invariants        # data_model.md §4 assertions on a seeded DB
      - pnpm build                   # next build + api tsc
  e2e:
    needs: verify
    steps: [start web+api, pnpm test:e2e, upload traces]
  nightly:
    schedule: '0 2 * * *'
    steps: [live-model evals, sandbox smoke, k6 load, Lighthouse, security audit]
```
Merge gates: `verify` + `e2e` green; coverage delta ≥ −2 %; no new `pnpm audit --prod` high/critical; PR body contains the required checklist from `AGENTS.md`.

---

## 8. Test data management

* Never write tests against production or live PayPal.
* Fixtures are versioned with the docs; when `docs/api_spec.md` changes, the contract test must be updated in the same PR (CI enforces a "docs touched" check when `packages/shared/src/api.ts` changes).
* Time-dependent tests use the injected clock; no `Date.now()` in domain code (lint rule).
* Randomised/property tests use a fixed seed (`SEED=1337`) so failures reproduce; property tests cover money math (`fast-check`: subtotal/tax/shipping/total invariants over random carts, quantities and prices).

---

## 9. Definition of done (any ticket)

1. Unit + integration tests for the new behaviour, including at least one negative case.
2. Error codes added to `docs/api_spec.md` §9 if new.
3. Analytics events added to `docs/analytics_spec.md` §1 if new.
4. `pnpm verify` green locally; PR CI green.
5. For money-path tickets: an explicit note in the PR body on how idempotency and verification are preserved.
6. For agent tickets: an eval report (case-by-case pass/fail) attached.
7. Docs updated in the same PR (a doc drift check runs in CI).
