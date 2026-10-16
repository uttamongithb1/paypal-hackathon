# ShopPilot AI — Decision Log

Architecture-level decisions live in `docs/architecture.md` §10 (D1–D10). This file records **build-time decisions** taken while implementing, in `DEC-NN` format, as required by `AGENTS.md` §2. Append, never rewrite: if a decision changes, add a new entry that supersedes the old one and mark the old one `superseded by DEC-NN`.

Template:

```
### DEC-NN — Title
Date · Status: accepted | superseded by DEC-MM · Owner
Context: what forced a choice
Options: what was considered
Decision: what we chose
Consequences: what this makes easy/hard, and what to revisit
```

---

### DEC-01 — Ranking weights are configuration, not code constants
2026-10-16 · accepted · Platform
**Context:** recommendation quality will be tuned repeatedly, and tests need deterministic ordering.
**Options:** (a) constants in `ranking.ts`, (b) env-configurable weights, (c) learned model.
**Decision:** env-configurable `RANKING_WEIGHTS` with defaults `0.30,0.25,0.15,0.20,0.10`, validated at boot; tests pin the defaults.
**Consequences:** prompt-free tuning and reproducible tests; a mis-set env var silently changes recommendations, so `/healthz` reports the active weights and the eval suite pins them.

### DEC-02 — Ranking in code, explanation in the model
2026-10-16 · accepted · Platform
**Context:** the model must not decide prices or eligibility, but it must explain choices in natural language.
**Decision:** `search_products` returns a deterministic `score`, `matched`, `unmet` and a machine-written `whyItFits`; the model may rephrase but not re-order.
**Consequences:** explainable, testable results; the model cannot invent a "better" product, which occasionally makes it say "I'd pick the one ranked first" instead of arguing — acceptable.

### DEC-03 — Fake LLM is a first-class adapter, not a test double
2026-10-16 · accepted · AI
**Context:** CI must run without keys or network, and demos must survive provider outages.
**Decision:** `FakeLlmClient` implements the same interface with scripted tool calls and text, is used in CI, and can serve the whole demo via `FEATURE_LIVE_LLM=false`.
**Consequences:** deterministic evals and offline demos; the risk is scripted responses drifting from real model behaviour, mitigated by a nightly live-model eval that must stay within one assertion of the fake.

### DEC-04 — Soft holds instead of hard reservations
2026-10-16 · accepted · Backend
**Context:** checkout must show accurate availability without partitioning stock per shopper.
**Decision:** available-to-sell = `stock − active holds`; holds live 15 minutes, are committed on capture, and are released by expiry/cancel.
**Consequences:** simple and demo-friendly; oversell is still possible if a hold expires mid-payment, which is why capture re-checks and `STOCK_COMMIT_FAILED` has a documented refund path (RB-4).

### DEC-05 — Capture is synchronous in the request; webhooks are the safety net
2026-10-16 · accepted · Payments
**Context:** the demo must work without a public webhook URL, yet stay correct when webhooks do arrive.
**Decision:** `POST /payments/{orderId}/capture` performs capture + verification + state change synchronously; webhooks and the reconciliation job converge the same state idempotently.
**Consequences:** demo reliability without tunnels; requires the `payment_processing` state and reconciliation to exist from day one, which they do.

### DEC-06 — Guests are persisted user rows
2026-10-16 · accepted · Backend
**Context:** carts, orders, sessions and analytics need an owner for guests.
**Decision:** `users.role = 'guest'` rows with no credentials, upgraded in place on login.
**Consequences:** uniform ownership and simple queries; requires a `pruneGuests` job (90 days) to avoid unbounded growth.

### DEC-07 — SSE rather than WebSockets for chat
2026-10-16 · accepted · Frontend/Backend
**Context:** streaming answers, proxy-friendly deployment, no need for server push.
**Decision:** one SSE stream per turn, closed at `message.end`; no long-lived socket registry.
**Consequences:** trivially scalable and debuggable (`curl -N`); payment status uses polling, which is adequate and simpler.

### DEC-08 — 8.25 % flat demo tax and a fixed shipping table
2026-10-16 · accepted · Product
**Context:** real tax/shipping engines are out of scope, but the total must be computed server-side and be explainable.
**Decision:** tax = `round(subtotal × 825 / 10 000)`; shipping from the four-branch table in `prd.md` §5.4.1; the UI labels it "Demo tax rate 8.25 %".
**Consequences:** deterministic tests; a stakeholder might mistake it for real tax, so the disclosure is mandatory on the checkout page and in the cart totals.

### DEC-09 — Single platform merchant of record
2026-10-16 · accepted · Product
**Context:** marketplace payouts (PayPal multiparty) would multiply integration risk.
**Decision:** the platform is the merchant of record in v1; merchants manage catalogue and see orders but do not receive funds.
**Consequences:** simpler payment integration; commission/payout logic is deferred (`FUT-10`) and must not be implied in merchant UI copy.

### DEC-10 — Analytics in the same MongoDB behind a sink interface
2026-10-16 · accepted · Platform
**Context:** a real analytics store is unnecessary for the demo, but the code should not assume Mongo forever.
**Decision:** `AnalyticsSink` interface with a Mongo implementation; writes are fire-and-forget with validation and TTL retention.
**Consequences:** zero extra infrastructure; high-volume production would need a different sink and the daily rollups already exist to make that migration easier.

### DEC-11 — Two deployment topologies, proxied by default in dev
2026-10-16 · accepted · Platform
**Context:** local development and sandboxed preview environments cannot rely on cross-origin cookies.
**Decision:** Next.js rewrites `/api/*` to the Express service by default; split mode remains supported for production-like setups.
**Consequences:** one origin in dev (no CORS/CSRF headaches, works inside restricted iframes); production must set `WEB_ORIGIN`/`API_ORIGIN` correctly — covered by `/readyz` checks and RB-2.

### DEC-12 — `payment_attempts` is append-only and user-visible
2026-10-16 · accepted · Payments
**Decision:** every attempt is a row with its verification checks; the UI shows attempt counts to the customer ("attempt 2 of 3").
**Consequences:** excellent auditability and a natural retry UX; requires the attempt cap to be enforced server-side to prevent abuse (PAY-20).

---

## Open questions (to be resolved and then promoted to DEC entries)

| # | Question | Impact if wrong | Owner | Target |
|---|---|---|---|---|
Q1 | Should `ORDER_ALREADY_CAPTURED` auto-refund when the amounts differ? | Customer funds held | Payments | after M6 |
Q2 | Do we keep 15-minute holds, or shorten to 8 for demo snappiness? | `HOLD_EXPIRED` errors during slow demos | Product | M6 |
Q3 | Should the agent be allowed to apply a promo code? | Scope creep into a promotions engine | Product | post-v1 |
Q4 | Multi-tab cart conflict handling (last-write-wins vs merge) | Lost quantity edits | Frontend | M3 |
Q5 | Do guests see order history beyond 24 h with an email magic link? | Support load | Product | post-v1 |
Q6 | Replace the fake client with a recorded-replay cassette for demos? | Demo authenticity | AI | M9 |
