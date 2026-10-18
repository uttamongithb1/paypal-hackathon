# ShopPilot AI — Environment & Local Setup

## 1. Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | **20.11 or newer** (`engines` in `app/package.json`) | the deployment runs Node 26; CI runs 22 and 26 |
| npm | 10+ | ships with Node; this is a single package, not a monorepo |
| PayPal Developer account | — | only for the real sandbox path — a sandbox REST app and a personal test buyer |
| LLM API key | — | only for the live model — a Groq key (`console.groq.com/keys`) |

No database, no Docker, no message queue. The store is file-backed and the app ships with a
catalogue seed, so **the demo runs with zero configuration** if you use the offline defaults.

If you want the real thing — a real PayPal sandbox capture and a real language model — you need
the three credentials in §4. Everything else is optional.

---

## 2. Quickstart

### 2a. Offline, no credentials (30 seconds)

```bash
git clone https://github.com/uttamongithb1/paypal-hackathon.git
cd paypal-hackathon/app
npm install
npm run seed        # 24 products, 3 merchants, 44 orders, demo users
npm start           # http://localhost:4000
```

`.env` defaults to `PAYPAL_MODE=simulator` and `FEATURE_LIVE_LLM=false`, so the checkout flow
runs against an in-process PayPal simulator and the agent runs a deterministic planner. Both
exercise the same code paths; only the network calls are stubbed.

### 2b. The real thing (sandbox PayPal + a live model)

```bash
cd paypal-hackathon/app
npm install
cp .env.example .env
# fill in three values (see §4):
#   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET   ← developer.paypal.com → Sandbox → your REST app
#   LLM_API_KEY                              ← console.groq.com/keys
npm run paypal:check                         # proves the PayPal credentials authenticate
npm run seed
npm start
```

The app refuses to boot if a credential it was told to use is missing, rather than quietly
falling back — so if it starts, the configuration is real.

Verify: `curl -s localhost:4000/api/v1/readyz` should report `"paypal":"ok"` and `"llm":"live"`,
and <http://localhost:4000> should load a shop.

Demo logins (seeded): `customer@demo.dev` / `Customer@12345` · `merchant@demo.dev` / `Merchant@12345` (merchant role) · `admin@demo.dev` / `Admin@12345`.

---

## 3. Scripts

All commands run from `app/`.

| Command | What it does |
|---|---|
| `npm start` | production start on `PORT` (default 4000) |
| `npm run dev` | same, with `--watch` |
| `npm run seed` | idempotent seed from `../data/seed.catalog.json` — catalogue, merchants, demo users, 44 orders, analytics |
| `npm run reset` | drop the local store |
| `npm test` | the whole suite: unit, integration and evals |
| `npm run test:unit` / `:integration` / `:evals` | one suite |
| `npm run verify` | tests **+** the money invariants **+** the recorded test count, in one run |
| `npm run ledger` | the invariant report (I1–I10) against the current store |
| `npm run test:count` | checks that the published test count matches the suite |
| `npm run test:count:write` | re-records it after adding or removing tests |
| `npm run smoke` | end-to-end smoke against a running server |
| `npm run paypal:check` | PayPal sandbox preflight: does OAuth authenticate? |
| `npm run paypal:settlement` | exercises multi-seller settlement against the sandbox |
| `npm run photos` | re-imports product photography from the dummy product API |
| `npm run demo` | prints the demo script with the current sandbox buyer emails |

---

## 4. Environment variables

Every variable the server reads is listed below, with the value the **deployed demo** actually
uses. The list is generated from `app/server/config/env.mjs` — the code is the source of truth,
and `app/.env.example` is the same list in copy-paste form.

The app validates its configuration at boot and **refuses to start** rather than running in a
degraded state it does not admit to. If you see `ShopPilot AI cannot start:`, the message names
the exact variable.

```dotenv
# ── Core ────────────────────────────────────────────────────────────────
NODE_ENV=development                # 'production' on a real deployment
PORT=4000
HOST=0.0.0.0
WEB_ORIGIN=http://localhost:4000    # the origin the browser loads the app from
LOG_LEVEL=info

# ── Storage ─────────────────────────────────────────────────────────────
# The reference build ships a file-backed store that mirrors the Mongo schema
# (app/server/store/store.mjs). It is the default and needs no service.
DATA_DIR=.data
# MONGO_URI is reserved: setting it makes the server refuse to boot rather than
# pretend persistence works (app/server/store/mongo.driver.mjs).
MONGO_URI=

# ── Auth / sessions ─────────────────────────────────────────────────────
JWT_SECRET=change-me-32-bytes-minimum-secret
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL=30d
GUEST_SESSION_TTL=30d
SESSION_COOKIE_NAME=sid
COOKIE_SECURE=false                # true in production
PII_HASH_PEPPER=change-me-another-long-random-string
# Seed the catalogue when the store is empty — required on an ephemeral disk
# (Render, Cloud Run, any free tier) so a fresh instance comes up as a shop.
SEED_ON_BOOT=true

# ── PayPal (sandbox) ────────────────────────────────────────────────────
PAYPAL_MODE=sandbox                # 'sandbox' → real Orders v2 calls; 'simulator' → offline
PAYPAL_CLIENT_ID=                   # from developer.paypal.com → Sandbox → your REST app
PAYPAL_CLIENT_SECRET=               # never exposed to the browser
PAYPAL_ENV=sandbox
PAYPAL_WEBHOOK_ID=                  # optional; without it inbound events are refused
# Multi-seller settlement. 'auto' asks PayPal for one purchase unit per seller and
# falls back to a single unit, recording why, if the account lacks the capability.
PAYPAL_SETTLEMENT=auto              # auto | split | single
PLATFORM_FEE_BPS=500                # ShopPilot's commission per seller unit
PAYPAL_DISBURSEMENT_MODE=INSTANT
# Simulator-only switches, for exercising the fallback paths offline.
PAYPAL_SIM_SPLIT_UNSUPPORTED=false
PAYPAL_SIM_FEES_UNSUPPORTED=false
PAYPAL_TIMEOUT_MS=10000
PAYMENT_MAX_ATTEMPTS=3
QUOTE_TTL_MINUTES=15
# Overrides the PayPal Orders v2 base URL. Point it at a local fake to test the
# real sandbox client (auth failures, retries, error mapping) without calling PayPal.
PAYPAL_API_BASE_URL=

# ── LLM / agent ─────────────────────────────────────────────────────────
# The deployed demo runs a real model: Groq, openai/gpt-oss-120b (free tier).
FEATURE_LIVE_LLM=true
LLM_PROVIDER=groq
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_API_KEY=                       # console.groq.com/keys
LLM_MODEL=openai/gpt-oss-120b
LLM_TEMPERATURE=0.2
# Loop budgets — the agent is bounded on every axis.
LLM_MAX_ITERATIONS=6
LLM_PER_CALL_TIMEOUT_MS=8000
LLM_TURN_TIMEOUT_MS=45000
LLM_MAX_RETRIES=2
BUDGET_GRACE_BPS=300
CLARIFY_MAX_QUESTIONS=2

# ── Business rules ──────────────────────────────────────────────────────
TAX_RATE_BPS=825
SHIPPING_FREE_THRESHOLD_MINOR=50000
SHIPPING_STANDARD_MINOR=999
SHIPPING_SMALL_ORDER_MINOR=1499
MAX_CART_LINES=20
MAX_LINE_QTY=10

# ── Feature flags ───────────────────────────────────────────────────────
FEATURE_ANALYTICS=true
FEATURE_GUEST_ORDERS=true

# ── Framing / embedding ─────────────────────────────────────────────────
# Origins allowed to frame the app (CSP `frame-ancestors`). Empty in production, so the app can
# only be framed by itself.
PREVIEW_EMBED_ORIGINS=

# ── Rate limits (per window) ────────────────────────────────────────────
RATE_CHAT=60/5m
RATE_AUTH=20/15m
RATE_CHECKOUT=30/5m
RATE_PAYMENT=30/5m
RATE_GLOBAL=600/1m
```

Validation rules enforced at boot (`validateEnv()` in `app/server/config/env.mjs`): `JWT_SECRET`
≥ 32 characters; `PII_HASH_PEPPER` ≥ 16 characters; `PAYPAL_CLIENT_ID` **and**
`PAYPAL_CLIENT_SECRET` present when `PAYPAL_MODE=sandbox`; `LLM_API_KEY` present when
`FEATURE_LIVE_LLM=true`; `PAYPAL_ENV=live` refused outside `NODE_ENV=production`;
`COOKIE_SECURE=true` required in production.

Two endpoints answer different questions, and the difference matters when something breaks:

| Endpoint | Question | Behaviour |
|---|---|---|
| `GET /api/v1/healthz` | is the process serving? | always `200` while it is — this is what the host health-checks, so a PayPal outage degrades checkout instead of taking the site down |
| `GET /api/v1/readyz` | is every dependency working? | `503` when PayPal cannot authenticate — the deep check, for operators |


## 5. PayPal sandbox setup (15 minutes, do it early)

1. `developer.paypal.com` → **Apps & Credentials** → toggle to **Sandbox** → **Create App** (`ShopPilot AI Demo`, type *Merchant*).
2. Copy **Client ID** → `PAYPAL_CLIENT_ID`; **Secret** → `PAYPAL_CLIENT_SECRET`. The storefront reads the client id from `/api/v1/version` at runtime, so there is nothing to rebuild and nothing to expose in the browser beyond that public value.
3. Ensure the app has the scope `https://uri.paypal.com/services/payments/payment/authcapture` (included by default) and enable **Negative Testing** for decline scenarios.
4. **Sandbox → Accounts**: create/collect two test buyers — one personal buyer with a positive balance (happy path) and one for decline testing. Sandbox buyer passwords are set from the dashboard.
   - **Give the happy-path buyer a balance of $10,000.** A personal sandbox account pays from its own
     PayPal balance, so a basket above the balance cannot be paid — and the failure surfaces inside
     PayPal's own checkout page, not as an error message from ShopPilot. The catalogue's cheapest
     items are $129–$219, so a $300 basket is a good demo; a $2,539 basket is not.
   - The buyer also needs an address in its wallet, or at least a country. ShopPilot now sends
     `shipping_preference: SET_PROVIDED_ADDRESS` with the address the shopper typed, so the wallet
     address is not needed — but the buyer account must still be a *confirmed* personal account.
5. Start the tunnel: `ngrok http 4000` → copy the HTTPS URL. (Only needed for webhooks — the demo captures synchronously.)
6. In the sandbox app → **Webhooks** → add `https://<tunnel>/api/v1/webhooks/paypal`, subscribe to `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.PENDING`, then copy the generated **Webhook ID** → `PAYPAL_WEBHOOK_ID`.
7. Run `npm run paypal:check` to confirm the connection; a `GET /api/v1/readyz` should report `paypal: ok`.
8. The tunnel URL changes on every restart — update the webhook URL and `PAYPAL_WEBHOOK_ID` when it does (the runbook `docs/runbooks.md` covers this).

**Multi-seller settlement (as-built, F1).** A ShopPilot basket can span several sellers, and a
correct multi-seller order needs the *Complete Payments Platform for Marketplaces and Platforms*
capability (`PARTNER_FEE`) on the app — plus a **business** sandbox account to create the app in the
first place (an individual/personal account can never enable it). Three variables control it:

```bash
PAYPAL_SETTLEMENT=auto          # auto | split | single  (see docs/payments_paypal.md §3a)
PLATFORM_FEE_BPS=500            # ShopPilot's 5% commission, per seller unit
PAYPAL_DISBURSEMENT_MODE=INSTANT  # INSTANT | DELAYED
PAYPAL_SIM_SPLIT_UNSUPPORTED=false  # simulator only: pretend the account cannot split, to test the fallback
```

**And one account per seller.** A seller is only paid *directly* if the account behind
`payee.email_address` really exists on PayPal — the demo placeholders
(`vertex-systems@sandbox.demo`) are not real accounts, so a split capture cannot pay them. For a
real multi-seller demo, create one **business** sandbox account per seller and point the
environment at them (the variable name is the merchant slug in upper case, dashes as underscores):

```bash
PAYPAL_PAYEE_VERTEX_SYSTEMS=vertex-systems@example.com
PAYPAL_PAYEE_NOVATECH_RETAIL=novatech-retail@example.com
PAYPAL_PAYEE_AUDIOPEAK=audiopeak@example.com
```

Leaving them empty is safe: the settlement falls back to a single unit and records why.

Ask your own account what it supports before recording a demo — this creates a real two-seller
sandbox order and reads the payees straight back out of it:

```bash
npm run paypal:settlement                     # ~5s verdict, exits 0 either way
npm run paypal:settlement -- --capture <id>   # after a sandbox buyer approves: per-seller captures
```

If the capability is missing, keep `PAYPAL_SETTLEMENT=auto`: the app completes the order as a single
unit and *says so* in the UI, the timeline and analytics. That is the intended behaviour, not a bug.

Note for CI/previews: webhooks are unnecessary. The capture endpoint works synchronously, and the nightly sandbox job is the only place that needs a live tunnel.

---

## 6. LLM provider setup

Two interchangeable brains sit behind one contract. Both use the same closed tool registry
(`contracts/agent_tools.json`), the same guardrails and the same SSE frames — only the tool
*selection* differs.

* **Deterministic planner (default, `FEATURE_LIVE_LLM=false`)** — no key needed. A rule-based intent
  router with template composition over tool results. Not a language model. It exists so the product
  is demoable, testable and CI-friendly offline, and so a missing key degrades instead of breaking.

* **Live model (`FEATURE_LIVE_LLM=true`)** — a real tool-calling loop:

  ```bash
  FEATURE_LIVE_LLM=true
  LLM_PROVIDER=openai-compatible      # free-text label, recorded on agent_turn_completed
  LLM_BASE_URL=https://api.openai.com/v1
  LLM_API_KEY=sk-...
  LLM_MODEL=gpt-4.1-mini
  LLM_TEMPERATURE=0.2
  ```

  Any OpenAI-compatible `/chat/completions` endpoint works, so the provider is a three-variable
  change with no code change:

  | Provider | `LLM_BASE_URL` | Example `LLM_MODEL` |
  |---|---|---|
  | OpenAI | `https://api.openai.com/v1` | `gpt-4.1-mini` |
  | Groq | `https://api.groq.com/openai/v1` | `openai/gpt-oss-120b` |
  | Together | `https://api.together.xyz/v1` | `Qwen/Qwen2.5-72B-Instruct-Turbo` |
  | DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
  | Ollama (offline) | `http://localhost:11434/v1` | `qwen2.5:14b-instruct` |

  Requirements: multi-call tool use and reliable JSON arguments. Keep `LLM_TEMPERATURE` low (0.2).

  > **Groq model availability changes.** `llama-3.3-70b-versatile` is now an *Enterprise* model on
  > GroqCloud — a developer key gets `404 The model ... does not exist or you do not have access to
  > it`. On a standard key use `openai/gpt-oss-120b` (tool use, 131k context) or
  > `openai/gpt-oss-20b` (cheaper, faster). List what your key can actually reach with:
  >
  > ```bash
  > curl -s https://api.groq.com/openai/v1/models \
  >   -H "Authorization: Bearer $LLM_API_KEY" | grep -o '"id":"[^"]*"' | sort
  > ```

* **Loop budgets** (defaults from `contracts/agent_tools.json` `limits`): `LLM_MAX_ITERATIONS=6`,
  `LLM_PER_CALL_TIMEOUT_MS=8000`, `LLM_TURN_TIMEOUT_MS=45000`, `LLM_MAX_RETRIES=1`. The loop is
  bounded on all three axes; exceeding a budget degrades to the deterministic planner, never hangs.

* **Honest labels.** `message.end.usage.profile` and the `agent_turn_completed` event report what
  *actually ran*: `live`, `live-degraded`, `live-iteration-capped`, `live-grounding-corrected`,
  `deterministic-fallback`, or `deterministic`. A turn served by the rule-based planner is never
  labelled `live`, even when the flag is on.

* **Verified without a key.** `tests/evals/live-agent.test.mjs` drives the real loop against a
  scripted OpenAI-compatible provider (`tests/helpers/fake-provider.mjs`) over the real SSE
  endpoint, so the loop, the registry, argument validation and the grounding check are all covered
  in CI. That provider is a **test fixture, not an AI** — the submission names the real model in the
  write-up.

---
## 7. Store helpers

The store is a single JSON file at `app/.data/db.json` (override with `DATA_DIR`).

```bash
# Inspect it
node -e "const d=require('./.data/db.json').data; console.log(d.orders.length,'orders')"

# Reset to a demo-ready state
npm run reset && npm run seed

# Verify the money invariants (must print zero violations)
npm run ledger

# Check the published test count still matches the suite
npm run test:count
```

`npm run seed` is idempotent: it writes the catalogue, three merchants, the demo users, 44
orders and the synthetic analytics funnel, and it never overwrites a store that already has data.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ShopPilot AI cannot start: …` | the configuration is incomplete, and the server says exactly which variable | the message names the variable; set it or unset the flag that requires it |
| `PAYPAL_MODE=sandbox requires PAYPAL_CLIENT_ID…` | no sandbox credentials | developer.paypal.com → Apps & Credentials → Sandbox → your REST app → copy Client ID and Secret |
| `npm run paypal:check` → `AUTHENTICATION_FAILURE` | the credentials are stale, or they are the **live** app's rather than the sandbox app's | re-copy them from the Sandbox tab, not Live; check for a trailing space |
| `/api/v1/readyz` shows `paypal: down` | PayPal is unreachable, or the credentials are wrong | `npm run paypal:check`; the storefront still serves, and the top bar shows "payments degraded" |
| `/api/v1/readyz` shows `llm: misconfigured-no-key` | `FEATURE_LIVE_LLM=true` with an empty key | set `LLM_API_KEY` |
| the model answers but never calls a tool | the model or base URL is wrong for the provider | `curl -s localhost:4000/api/v1/diagnostics/llm` — it lists the models your key can actually call |
| PayPal Buttons do not render | the SDK was blocked, or the client id is missing | the client id comes from `/api/v1/version` at runtime — nothing to rebuild; check the console for CSP violations |
| `INVALID_SIGNATURE` on a webhook | `PAYPAL_WEBHOOK_ID` does not match the app that signed the event | re-copy the webhook id from the sandbox app's webhook config |
| an order is stuck in `payment_processing` | the capture response was lost | `POST /api/v1/admin/orders/{id}/reconcile` with an admin session |
| 429 during a demo | the rate limit is doing its job | raise the relevant `RATE_*` variable, or restart with development budgets |
| `npm test` fails with `Could not find 'tests/**/*.test.mjs'` | a glob was passed to `node --test` on Node 20 | use the directory form (`node --test tests/unit tests/integration tests/evals`) — glob support needs Node 21+ |
| `npm run verify` says the test count is stale | tests were added or removed without re-recording | `npm run test:count:write` |

---

## 9. Production-ish checks before sharing a demo URL

- [ ] `COOKIE_SECURE=true`, `NODE_ENV=production`, real TLS
- [ ] `curl /api/v1/readyz` reports `paypal: ok` and `llm: live`
- [ ] `curl /api/v1/version` names the model that is really being called, and the storefront footer says the same
- [ ] the model is named on the submission page — the rules require naming the AI tool
- [ ] a real PayPal sandbox capture completes end to end, and the V1–V8 panel shows the recorded checks
- [ ] `npm run ledger` is clean against the live store
- [ ] the host health-checks `/api/v1/healthz`, so a PayPal outage degrades checkout instead of taking the site down
- [ ] rate limits are sized for the expected audience
- [ ] `LOG_LEVEL=info` at minimum, and redaction verified
