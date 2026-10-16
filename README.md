# ShopPilot AI — conversational commerce with a PayPal checkout the agent cannot approve

**PayPal AI Hackathon 2026 submission** · *Best Use of Agentic Commerce · Best Use of PayPal + AI*

A shopper states a job to be done in plain language. An AI agent grounds every recommendation in a
real catalogue, prepares a real order, and opens a real PayPal checkout — then stops.
**The agent has no payment tool and no way to obtain one.** Only the human approves; only the
server, after verifying PayPal's capture, may mark the order paid.

> ### The one-line pitch
> Every other agent demo asks you to trust it with your money. This one **cannot** spend it —
> not because it chooses not to, but because approval is structurally outside the tool registry.

---

## Run it in one command

```bash
git clone <this-repo> && cd shoppilot-ai
./dev-up.sh
```

Then open **http://localhost:4000/**

`dev-up.sh` checks Node, installs dependencies, seeds the demo store if missing, runs the
self-check (unit tests + ledger invariants), and starts the server.

```bash
./dev-up.sh --check     # verify without starting a server (used by judges/CI)
./dev-up.sh --reseed    # reset to the documented demo state, then start
```

**No API keys, database, or PayPal account required.** The default `PAYPAL_MODE=simulator` drives
the complete payment lifecycle — including declines, pending captures, amount mismatches and
duplicate webhooks — entirely in-process. A real PayPal sandbox is one env var away (below).

### Demo accounts (seeded)

| Role | Email | Password | What to look at |
|---|---|---|---|
| Shopper | `customer@demo.dev` | `Customer@12345` | Orders, receipts, the payment audit trail |
| Merchant | `merchant@demo.dev` | `Merchant@12345` | Catalogue, orders, payment attempts, analytics funnel |
| Admin | `admin@demo.dev` | `Admin@12345` | Reconciliation endpoint |

---

## The 90-second tour

1. **Ask for something real** — on `/`, type:
   > *I need a laptop for full-stack development under $900 with 16 GB RAM and a 512 GB SSD*

   The agent extracts a structured requirement (category · budget · hard constraints), emits
   `tool.activity` frames while it searches, and returns **4 real products** with per-item
   `whyItFits`, pros **and honest cons** — every number read from the catalogue, not invented.

2. **Watch it reason about your budget** — *"actually make it under $700"* → requirement revision
   increments, the card set changes, and nothing over budget survives.

3. **Cart → checkout** — the agent prepares the order. A stock hold is placed, prices are frozen
   into a quote hash, and the checkout summary shows subtotal, shipping, tax and total.

4. **The agent stops at the payment boundary** — the PayPal order exists, but no tool in the
   registry can capture it. You approve. PayPal captures. Only then does the backend verify.

5. **See why that matters** — the trust panel lets you attack the payment you just made:
   replay the capture, re-deliver the webhook, force an amount mismatch. The order does not budge.

6. **Merchant side** — `/merchant` shows the same order with its payment attempt trail
   (`failed → succeeded`), the verification outcome, and a funnel of views → cart adds →
   checkout attempts → purchases.

---

## Why this is hard, and what we built for it

A payment integration is easy to demo and hard to get right. This one treats the hard parts as the
product:

| Failure that eats real money | What ShopPilot does |
|---|---|
| Agent spends without consent | No payment tool exists in the registry — enforced by construction, not by prompt |
| Double charge on a double click | Idempotency keys on order creation **and** capture; a replay returns the *same* capture id |
| Charged but no goods | Stock commits inside the same transaction as the paid transition; failure rolls back and flags for reconcile |
| Attacker-supplied "payment succeeded" | Nothing is trusted until the backend fetches the capture from PayPal and re-checks V1–V7 |
| Price changed between quote and pay | Quote hash mismatch → `409 QUOTE_STALE`, re-approval required, never a silent overcharge |
| Webhook replay or forged webhook | Signature verified against PayPal's API + deduplicated by `event.id`; a forged payload cannot move an order |
| Order stuck "pending" forever | Webhook-driven confirmation plus a reconciliation job; the order only becomes `paid` on verified capture |

### PayPal surface actually exercised

- **Orders v2** — create, get, capture, void (`/v2/checkout/orders`)
- **OAuth2** `client_credentials` with token caching and expiry
- **Idempotency** — `PayPal-Request-Id` on create and capture
- **Webhooks** — `POST /v1/notifications/verify-webhook-signature`, signature verification +
  `event.id` dedupe; handles `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED|DENIED|REFUNDED|REVERSED`
- **Failure semantics** — `INSTRUMENT_DECLINED` → actionable retry, `PENDING` → 202 and poll,
  `ORDER_NOT_APPROVED` refused, capture-amount mismatch → order stays unpaid + support reference
- **JavaScript SDK** Buttons wired server-side (`createOrder` returns the server-created order id)

---

## Switching on the real PayPal sandbox (2 minutes)

```bash
cd app
cp .env.example .env
# then set:
#   PAYPAL_MODE=sandbox
#   PAYPAL_CLIENT_ID=...        (developer.paypal.com → Apps & Credentials → Sandbox)
#   PAYPAL_CLIENT_SECRET=...
#   PAYPAL_WEBHOOK_ID=...       (optional — required for webhook signature verification)

npm run paypal:check
```

`paypal:check` performs a real OAuth2 handshake, creates a real sandbox order, prints the buyer
approval URL, and re-verifies the amount and `custom_id` the way the backend does at capture time.
Approve it as a sandbox **buyer** account, then:

```bash
npm run paypal:check -- --capture <paypalOrderId>   # prints the real capture id
```

---

## Run the AI on a real model

The shipped default is a deterministic planner: same tool registry, same SSE frames, same
guardrails, reproducible for judging without a key.

```bash
# app/.env
FEATURE_LIVE_LLM=true
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4.1-mini
```

---

## Architecture

```
shop/                 Vanilla-ESM storefront: chat rail, catalogue, cart drawer, checkout, orders, merchant
server/
  http/               Express 5 app, routes, validation (zod), middleware, error mapping
  agent/              Requirement extraction · prompt builder · tool registry · orchestrator (SSE)
  services/           catalogue · inventory · cart · quote · order · payment · analytics · session
  payments/           paypal.gateway.mjs  → PaypalSandbox (real API) | PaypalSimulator (in-process)
  store/              Document store (JSON-file now, Mongo driver stub for MONGO_URI)
  domain/             Order state machine, analytics event catalogue, business policies
scripts/              seed · reset · ledger-check · smoke · demo · product art · paypal:check
tests/                unit (money, state machine, requirement parsing, intents) · integration (HTTP)
docs/                 Full engineering doc set — PRD, API spec, agent spec, payments, security, runbooks
```

### Verified state

| Suite | Result |
|---|---|
| `node --test tests/unit` | 15/15 |
| `node --test tests/integration` | 11/11 — real HTTP: cart maths, stock caps, decline → retry → verified capture, replay safety, pending + reconcile, webhook forge/replay, merchant scoping, quote staleness |
| `node scripts/ledger-check.mjs` | all invariants hold (no order paid without a verified capture, no double capture, stock never negative) |
| `BASE_URL=http://localhost:4000 npm run smoke` | 24/24 end-to-end against a running server |

```bash
npm run verify     # reset → seed → tests → ledger invariants
npm test           # unit + integration + evals
```

---

## Documentation

Written to be built from, not skimmed: `prd.md` (with numbered acceptance criteria), `design_system.md`,
`docs/api_spec.md` (every endpoint, every error code), `docs/ai_agent_spec.md` (tools, limits,
guardrails), `docs/payments_paypal.md` (the full lifecycle and failure matrix),
`docs/data_model.md`, `docs/architecture.md`, `docs/security_privacy.md`, `docs/testing_strategy.md`,
`docs/runbooks.md`, `docs/decisions.md` (DEC-01…DEC-12), plus machine-readable contracts in
`contracts/` (`openapi.yaml`, `agent_tools.json`) and seed data in `data/`.

`WIN_PLAN.md` tracks this submission against the hackathon's judging criteria.

---

## Scope & honesty notes

- The store, catalogue and merchant tools are a **reference implementation** of the real thing —
  the PayPal integration is genuine and switchable to the live sandbox API.
- The document store ships as a JSON file so the project runs anywhere with zero setup; the Mongo
  schema in `docs/data_model.md` is what this mirrors, and `MONGO_URI` is the documented switch.
- The agent cannot pay. That is not a missing feature — it is the thesis.

## License

MIT — see [LICENSE](LICENSE).
