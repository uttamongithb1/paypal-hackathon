# ShopPilot AI — What's Needed to Make It Fully Functional

Audited against the running code, not the docs. Verified 2026-10-16 against `dev-up.sh`,
`npm run verify`, and greps of `server/`, `shop/js/`, `scripts/`, `tests/`.

**Headline (updated 2026-10-16 after MOV-1):** the app is a *working* product demo with a real
model-driven agent behind `FEATURE_LIVE_LLM`, and `npm run verify` is green and read-only. What
remains for a *functional submission*: a real provider key, a real PayPal sandbox capture, a hosted
URL, and the video. MongoDB is still a deliberate stub — see A3.

---

## Part A — The four blockers

These are the things that stop it being "fully functional". Nothing else on this page matters until
these are done.

### A1 — ~~There is no LLM~~ ✅ **FIXED 2026-10-16**

**Done:** `server/agent/llm.mjs` (OpenAI-compatible client) + `Orchestrator.runLiveTurn()` (bounded
tool-calling loop over the same closed registry) + `server/agent/toolBridge.mjs` (contract → tool
schemas + argument validation). A model that asks for a payment capability is refused on screen and
traced; a price no tool returned is caught and replaced. Profiles are honest. Covered by
`tests/evals/live-agent.test.mjs` (8/8), which runs with no API key by driving a scripted
protocol-compatible provider.

**Still outstanding:** run it once against a real provider and name that model in the submission.

**Evidence:** the only outbound `fetch()` calls in the entire server are in
`server/payments/paypal.gateway.mjs` (OAuth token + Orders v2). `orchestrator.plan()` is a
`switch (intent)` statement. There is no `server/agent/llm.mjs`, no provider SDK, and nothing
anywhere reads `llmBaseUrl` / `llmApiKey` / `llmModel` — those three env vars are read only by
`config/env.mjs` and printed in a startup banner.

**Worse:** `profile: env.featureLiveLlm ? 'live' : 'deterministic'` is stamped on analytics events
and agent turns. Setting `FEATURE_LIVE_LLM=true` today would **relabel the logs as "live" while
still running the rule-based planner.** That is the kind of thing a judge who reads code will find.

**What's needed**
1. `server/agent/llm.mjs` — a provider-agnostic client (OpenAI-compatible `/chat/completions` works
   with OpenAI, Groq, Together, DeepSeek, or a local Ollama; one shape covers all of them).
2. A real tool-calling loop in `orchestrator`: model → tool_calls → execute via the **existing**
   14-tool registry → feed results back → repeat, bounded by the documented limits (6 iterations /
   8s per call / 45s total — enforce what `ai_agent_spec.md` §4 already states).
3. Keep the deterministic planner as an explicit, honestly-labelled **fallback** (`profile:
   'deterministic-fallback'`) so a missing key degrades instead of lying.
4. A grounded system prompt: the model may only reference products the tools returned, must never
   state a price it didn't get from a tool, and must not claim it can pay.
5. Cost/latency guardrails: token budget per turn, timeout, and a hard failure path back to the
   deterministic planner.

**Acceptance:** with `FEATURE_LIVE_LLM=true` and a key, a multi-step request ("find me a laptop
under $900 with 16GB RAM, compare the top two, add the cheaper one to my cart") plans across ≥3
tool calls driven by the model; with the key removed, the same request still succeeds via the
fallback and the event `profile` accurately reads `deterministic-fallback`.

**Est:** 6–10 h. **Why it's first:** every prize category names AI, and the demo video's strongest
moment is a model visibly choosing tools.

---

### A2 — ~~`npm run verify` fails~~ ✅ **FIXED 2026-10-16**

`tests/evals/` now exists (live-agent evals, 8/8), and `verify` is split: `npm run verify` is
read-only (tests + ledger) while `npm run verify:demo` is the destructive reset+seed path. Verified
by fingerprinting the store before and after a `verify` run — unchanged.

**Evidence:** `verify` = `reset && seed --demo-orders && test && ledger`, and `test` =
`node --test tests/unit tests/integration tests/evals`. The last path doesn't exist:

```
Could not find '/home/user/shoppilot-ai/app/tests/evals'
```

So the project's own documented quality gate is red, while `dev-up.sh --check` (unit only, 15/15)
is green — two gates, one of them lying by omission.

**Also note:** `npm run verify` **reseeds the store**. I ran it during this audit and it reset the
demo data (7 orders → the seeded 3, analytics rebuilt). It is not read-only. That's a footgun the
night before a demo.

**What's needed**
1. Write `tests/evals/` — the doc `testing_strategy.md` already specifies them:
   - requirement extraction accuracy over a fixture message set
   - grounding: zero invented products/prices when tools return nothing
   - the "agent cannot pay" assertion (no payment tool is ever callable, attempted refusal is traced)
   - clarification behaviour on under-specified asks
   - budget compliance (never recommends above the stated cap)
2. Split `verify` into `verify` (read-only: tests + ledger) and `verify:demo` (reset + seed + tests),
   so the demo state can never be destroyed by running the quality gate.

**Est:** 3–5 h. **Why it matters:** evals are the difference between "we built an agent" and
"we can show our agent is good" — and they're cheap insurance for the video.

---

### A3 — MongoDB is a stub, so the stated stack isn't met. 🟠

**Evidence:** `server/store/mongo.driver.mjs` is 27 lines and exports
`MONGO_DRIVER_NOT_IMPLEMENTED`. `createStore()` deliberately **throws** if `MONGO_URI` is set, so
the app cannot run on MongoDB at all. It ships the JSON file store (`store.mjs`) instead, which is
a genuinely nice engineering choice for a demo but is not the MongoDB in the product description.

**What's needed** — two honest options:

- **Option 1 (recommended, ~6–8 h):** implement the driver against the documented schema
  (`docs/data_model.md`). The file store already defines the exact method surface to match
  (`find/findOne/count/insert/insertMany/updateOne/findOneAndUpdate/deleteOne/deleteMany`), so the
  services don't change at all. Requires a replica set for transactions and `mongodb-memory-server`
  in tests. **Must verify the atomic `findOneAndUpdate` guard** used for stock commits — that's the
  one place correctness depends on real database semantics.
- **Option 2 (~30 min):** keep the file store, and say so plainly in the README and the video
  ("file-backed store, Mongo adapter specified in `docs/data_model.md`, driver intentionally
  stubbed"). Honest and defensible — but it contradicts the pinned stack, so only take this if
  time runs out.

**Acceptance (Option 1):** `MONGO_URI` set → `/readyz` reports `mongo: up`, the full integration
suite passes against Mongo, and a concurrent stock-commit test proves no oversell.

---

### A4 — Real PayPal has never run end to end. 🔴

**Evidence:** `PAYPAL_MODE=simulator`. The real client exists and is complete
(`paypal.gateway.mjs` does OAuth + Orders v2 create/capture/verify), and
`npm run paypal:check` is built for exactly this — but no live sandbox capture has ever been
recorded. `webhook_events` has **0 rows**, so signature verification and dedupe have never executed.

**What's needed**
1. PayPal developer app → sandbox client ID + secret; sandbox **business** + **personal** accounts.
2. `.env`: `PAYPAL_MODE=sandbox`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and a fresh
   `JWT_SECRET` (≥32 chars) + `PII_HASH_PEPPER` (≥16 chars).
3. Run the two-step flow: `npm run paypal:check` → approve as the sandbox buyer → `--capture` with
   the returned order id → record the real `captureId`.
4. Webhooks need a **public HTTPS URL**: the app's own webhook route must be reachable, which means
   deploying first (A5) or tunneling. Then set `PAYPAL_WEBHOOK_ID` and re-verify signature handling.
5. Deliberately exercise the failure paths for the video: `INSTRUMENT_DECLINED` → retry, pending,
   cancel. Simulator already does this; do it once for real.

**Est:** 1 h of work + waiting on the approve step. **Why it's first-tier:** Stage 1 is pass/fail on
real PayPal usage. A `payments: simulator` badge in the topbar will not clear it.

---

## Part B — Product gaps (functionality that's specified-but-absent or unreachable)

| # | Gap | Detail | Needed |
|---|---|---|---|
| B1 | **Refunds unreachable** | `ORDER_STATUS.REFUNDED` exists and the state machine allows it, but there is **no refund endpoint** in the 49 routes — the state can never be reached | `POST /merchant/orders/:id/refund` → PayPal refund API, ledger entry, event |
| B2 | **No address capture** | `orders.contact` holds only `{email, name}`. There is no `addresses` collection and no shipping address on the order | Address form on checkout, address on order, validation, used for shipping |
| B3 | **No shipment record** | Merchant `ship` transition accepts free-text tracking in `meta`; there's no `shipments` collection, no carrier, no delivery confirmation | `shipments` collection + tracking display on order page |
| B4 | **No notifications** | No email at any point — order confirmation, payment receipt, shipping update, failure notice. `send_email` is correctly a forbidden agent tool, but nothing sends mail either | Transactional email (Resend/SMTP) on `paid` and `shipped`; queue + retry |
| B5 | **No reviews** | `rating`, `ratingCount` are seeded fields; shoppers cannot write a review | `reviews` collection + write endpoint + merchant moderation |
| B6 | **No promotions** | No discounts, coupons, or sale pricing; `priceMinor` is flat | Optional; only if the demo needs a "deal" story |
| B7 | **Single currency** | USD only. `currency` is hardcoded `'USD'` in several services and DTOs | Multi-currency is **out of scope** — leave it, but say so |
| B8 | **No admin surface** | `admin` role exists and one endpoint (`reconcile`); no UI, no user/merchant management, no audit view | Decide: admin UI, or document admin-as-API |
| B9 | **Price history never written** | `price_history` collection exists, **0 rows** — merchant price changes aren't recorded | Hook `product_updated` → append a history row, or drop the collection |
| B10 | **No search facets/sort UI** | API supports filters; the rail has category + text search only | Facet chips (price range, brand) if the catalogue grows |

## Part C — Production & deployment readiness

| # | Item | State | Needed |
|---|---|---|---|
| C1 | Deploy config | **none** — no `Dockerfile`, `render.yaml`, `Procfile` or `fly.toml` | Pick a host (Render is a hackathon sponsor with credits), add the config, pin Node 24 (docs say 24; running 20 — warn only) |
| C2 | Secrets | `.env.example` exists (2.8 KB); **no `.env`** | Generate real `JWT_SECRET` + `PII_HASH_PEPPER`, set `COOKIE_SECURE=true`, `WEB_ORIGIN` to the deployed origin |
| C3 | Durable storage | File store on an ephemeral host means data loss on redeploy | Mongo (A3) or a mounted volume |
| C4 | Webhook reachability | Route exists; needs a public URL | Public HTTPS endpoint + `PAYPAL_WEBHOOK_ID` (blocked by C1) |
| C5 | Observability | Structured JSON logs only; no metrics/tracing/alerts | Minimum: request-rate + error-rate visibility, and an uptime check on `/readyz` |
| C6 | Backups | None | Snapshot the store before the demo; `npm run seed` restores a known-good state |
| C7 | Load sanity | Never measured | One `autocannon`-style run so "it survives a demo" is a fact, not a hope |
| C8 | Rate limits active | ✅ configured (`RATE_CHAT=60/5m`, etc.) | Verify they don't trip your own demo video |

## Part D — Docs vs. built (a real contradiction to resolve)

`docs/backlog.md` (391 lines, M0–M8) specifies a **different architecture** than what exists: a pnpm
+ Turborepo monorepo, `apps/api` + `apps/web` with **Next.js App Router and TypeScript**,
`packages/shared`, Mongoose schemas, `docker-compose` with a Mongo replica set, CI workflows, and
`pnpm verify`.

The implementation is a **single Node/Express app with a vanilla-JS frontend** — no workspace, no
Next.js, no TypeScript, no Mongo, no CI.

Both are internally coherent; together they contradict each other. A judge — or an AI agent told to
"build this from the docs" — will hit that mismatch immediately.

**Needed:** decide which is authoritative and make the other defer to it.
- If the Express app is the submission: add a short "Implementation note" at the top of
  `docs/backlog.md` and `docs/architecture.md` stating the reference build is the single-app
  Express implementation, and that the monorepo plan is a future/alternate track.
- If the docs win: that's a rebuild, not a patch — don't.

**Est:** 30 min for the honest-labelling option.

## Part E — Submission deliverables still missing

| Deliverable | State |
|---|---|
| Public repo + visible OSI license | ✅ done (`LICENSE`, README, 3 commits) |
| Hosted demo URL | ❌ **required** — blocked by C1/C2 |
| < 3-minute demo video | ❌ **required** — script already exists (`docs/demo_script.md`, 190 lines / 15 sections) |
| Devpost write-up + category choice | ❌ not started. Categories to target: *Best Use of Agentic Commerce* ($5k), *Best Use of PayPal + AI* ($5k) |
| Judge-facing run instructions | ⚠️ README covers it; needs a "run it in 2 minutes" block at the very top |
| Agent evals | ❌ blocked by A2 |

---

## Recommended order

**Do these five, in this order, before touching anything else:**

1. **A2 evals + split `verify`** (3–5 h) — cheapest, makes the gate green, protects the demo state
2. **A4 real PayPal sandbox capture** (1 h + approve step) — required for Stage 1
3. **A1 live LLM with deterministic fallback** (6–10 h) — the AI story and the best video moment
4. **C1+C2 deploy** (2–4 h) — unlocks the hosted URL *and* PayPal webhooks
5. **E video + Devpost** (3–4 h) — cannot be done well at the last minute

**Then, if time remains:** A3 Mongo driver, B1 refunds, B4 email, D doc reconciliation.
**Explicitly skip:** B7 multi-currency, B6 promotions, B10 facets, and any admin UI that isn't
needed for the demo.

**Definition of fully functional (checklist):**
- [ ] `npm run verify` green, read-only, with evals included
- [ ] A real sandbox `captureId` captured in an order, plus one real webhook delivered
- [ ] The agent's plan visibly produced by a model, with the fallback honestly labelled
- [ ] Public URL serving the storefront and the merchant dashboard
- [ ] Demonstration video under 3 minutes, ending on the "agent cannot pay" moment
