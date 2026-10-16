# ShopPilot AI — Environment & Local Setup

## 1. Prerequisites

| Tool | Version | Notes |
|---|---|---|
Node.js | **24 LTS** (>= 24.0.0; 26 becomes LTS on 28 Oct 2026) | `fnm`/`nvm` recommended; `engines` field enforces it |
pnpm | 10.x | `corepack enable && corepack prepare pnpm@latest --activate` |
Docker + Compose | recent | for Mongo (and optional full stack) |
MongoDB | 8.0 | via Docker locally, Atlas free tier for hosted demos. **Replica set required** (transactions) |
ngrok (or Cloudflare Tunnel) | any | only needed for PayPal webhooks |
PayPal Developer account | — | sandbox app + test buyers |
LLM API key | — | optional: `FEATURE_LIVE_LLM=false` uses the deterministic planner (no model) |

Optional: `mongosh`, `mongodb-database-tools` (`mongodump`/`mongorestore`), `k6` for load tests.

---

## 2. Quickstart

```bash
git clone <repo> shoppilot-ai && cd shoppilot-ai
cp .env.example .env                      # fill values (see §4)
corepack enable && pnpm install
docker compose up -d mongo                # single-node replica set on :27017
pnpm env:check                            # validates every required var
pnpm db:indexes && pnpm seed              # 24 products, 3 merchants, demo users
pnpm dev                                  # web → http://localhost:3000, api → http://localhost:4000
```
Verify: `curl -s localhost:4000/healthz`, open `http://localhost:3000`, type *"laptop for full-stack dev under $900, 16GB RAM"* and confirm real products come back with prices.

Demo logins (seeded): `customer@demo.dev` / `Customer@12345` · `merchant@demo.dev` / `Merchant@12345` (merchant role) · `admin@demo.dev` / `Admin@12345`.

---

## 3. Scripts

| Command | What it does |
|---|---|
`pnpm dev` | Turborepo: api (`tsx watch`) + web (`next dev`) |
`pnpm build` | `next build` + api `tsc` |
`pnpm start` | Production start for both |
`pnpm verify` | format:check + lint + typecheck + unit + integration + contract + evals |
`pnpm test:unit` / `:integration` / `:contract` / `:evals` / `:e2e` | Individual suites |
`pnpm seed` | Idempotent seed from `data/seed.catalog.json` |
`pnpm seed:reset --demo-orders` | Drop + reseed + demo orders + synthetic analytics |
`pnpm db:indexes` | `syncIndexes()` on all models and print the diff |
`pnpm env:check` | Validates env against this doc |
`pnpm ledger:check` | Runs the invariant suite (I1–I10) against the current DB |
`pnpm job:reconcile` | Runs the payment reconciliation job once |
`pnpm job:replay-webhooks --since=1h` | Replays stored webhook events |
`pnpm gen:client` | Regenerates web API types from `contracts/openapi.yaml` |
`pnpm demo` | Prints the demo script with the current sandbox buyer emails |

---

## 4. Environment variables

`.env.example` (server secrets never enter `NEXT_PUBLIC_*`; `NEXT_PUBLIC_*` values are compiled into the browser bundle).

```dotenv
# ── Core ────────────────────────────────────────────────────────────────
NODE_ENV=development
PORT=4000
WEB_ORIGIN=http://localhost:3000
API_ORIGIN=http://localhost:4000
LOG_LEVEL=debug
TZ=Asia/Kolkata

# Public (safe to expose)
NEXT_PUBLIC_API_URL=http://localhost:4000           # leave empty to use the Next rewrite proxy (recommended)
NEXT_PUBLIC_PAYPAL_CLIENT_ID=AXxxxxxxxxxxxxxxxxxx_sandbox
NEXT_PUBLIC_PAYPAL_CURRENCY=USD

# ── Database ────────────────────────────────────────────────────────────
MONGODB_URI=mongodb://localhost:27017/shoppilot?replicaSet=rs0&directConnection=true
MONGODB_DB=shoppilot

# ── Auth / sessions ─────────────────────────────────────────────────────
JWT_SECRET=change-me-32-bytes-minimum-secret
JWT_ISSUER=shoppilot-api
JWT_AUDIENCE=shoppilot-web
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL=30d
GUEST_SESSION_TTL=30d
SESSION_COOKIE_NAME=sid
COOKIE_DOMAIN=                     # empty for localhost
COOKIE_SECURE=false                # true in production
PII_HASH_PEPPER=change-me-another-long-random-string

# ── PayPal (sandbox) ────────────────────────────────────────────────────
PAYPAL_ENV=sandbox                 # 'sandbox' | 'live' — boot asserts consistency
PAYPAL_CLIENT_ID=AXxxxxxxxxxxxxxxxxxx_sandbox
PAYPAL_CLIENT_SECRET=EXxxxxxxxxxxxxxxxxxxxxxxxx
PAYPAL_WEBHOOK_ID=WH-xxxxxxxxxxxxxxxxxxxxxxxx     # from the sandbox app's webhook config
PAYPAL_BRAND_NAME=ShopPilot AI (demo)
PAYPAL_TIMEOUT_MS=10000
PAYMENT_MAX_ATTEMPTS=3
QUOTE_TTL_MINUTES=15

# ── LLM / agent ─────────────────────────────────────────────────────────
FEATURE_LIVE_LLM=false             # false → deterministic planner, zero model calls (CI default)
LLM_PROVIDER=openai-compat         # openai-compat | anthropic | fake
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=
LLM_MODEL=gpt-4.1-mini
LLM_TEMPERATURE=0.2
AGENT_MAX_TOOL_ITERATIONS=6
AGENT_MAX_TOKENS_PER_TURN=12000
AGENT_CONTEXT_TURNS=20
AGENT_TOOL_TIMEOUT_MS=8000
AGENT_TURN_TIMEOUT_MS=45000
RANKING_WEIGHTS=0.30,0.25,0.15,0.20,0.10
BUDGET_GRACE_BPS=300
CLARIFY_MAX_QUESTIONS=2

# ── Business rules ──────────────────────────────────────────────────────
TAX_RATE_BPS=825
SHIPPING_FREE_THRESHOLD_MINOR=50000
SHIPPING_STANDARD_MINOR=999
SHIPPING_SMALL_ORDER_MINOR=1499
SHIPPING_OVERSIZED_SURCHARGE_MINOR=1999
MAX_CART_LINES=20
MAX_LINE_QTY=10

# ── Feature flags ───────────────────────────────────────────────────────
FEATURE_CHECKOUT=true
FEATURE_WEBHOOKS=true
FEATURE_ANALYTICS=true
FEATURE_GUEST_ORDERS=true
FEATURE_LIVE_LLM=false            # true = real model; needs LLM_API_KEY (see §6)
FEATURE_MERCHANT_DASHBOARD=true

# ── Framing / embedding ─────────────────────────────────────────────────
# Origins allowed to frame the app (CSP `frame-ancestors`). Empty in production, so the app can
# only be framed by itself. Development defaults to the workspace preview proxy host so the live
# preview iframe renders the app; set explicitly for any other embedding host.
PREVIEW_EMBED_ORIGINS=https://*.e2b.app

# ── Rate limits (per window; see security_privacy.md §7) ────────────────
RATE_CHAT=20/5m
RATE_AUTH=10/15m
RATE_CHECKOUT=10/5m
RATE_PAYMENT=10/5m
RATE_GLOBAL=300/1m

# ── Analytics ───────────────────────────────────────────────────────────
ANALYTICS_ENABLED=true
ANALYTICS_TZ=Asia/Kolkata
ANALYTICS_RETENTION_DAYS=180

# ── Mail (dev) ──────────────────────────────────────────────────────────
MAIL_TRANSPORT=console             # console | smtp
MAIL_FROM=receipts@shoppilot.local
```

Validation rules enforced by `env.ts` at boot: `JWT_SECRET` ≥ 32 chars; `PAYPAL_CLIENT_SECRET` present when `FEATURE_CHECKOUT=true`; `LLM_API_KEY` present when `FEATURE_LIVE_LLM=true`; `PAYPAL_ENV` must be `sandbox` unless `ALLOW_LIVE_PAYPAL=true` **and** `NODE_ENV=production`; `PAYPAL_WEBHOOK_ID` required when `FEATURE_WEBHOOKS=true` (warn-only in dev).

---

## 5. PayPal sandbox setup (15 minutes, do it early)

1. `developer.paypal.com` → **Apps & Credentials** → toggle to **Sandbox** → **Create App** (`ShopPilot AI Demo`, type *Merchant*).
2. Copy **Client ID** → `NEXT_PUBLIC_PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_ID`; **Secret** → `PAYPAL_CLIENT_SECRET`.
3. Ensure the app has the scope `https://uri.paypal.com/services/payments/payment/authcapture` (included by default) and enable **Negative Testing** for decline scenarios.
4. **Sandbox → Accounts**: create/collect two test buyers — one personal buyer with a positive balance (happy path) and one for decline testing. Sandbox buyer passwords are set from the dashboard.
5. Start the tunnel: `ngrok http 4000` → copy the HTTPS URL.
6. In the sandbox app → **Webhooks** → add `https://<tunnel>/api/v1/webhooks/paypal`, subscribe to `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.PENDING`, then copy the generated **Webhook ID** → `PAYPAL_WEBHOOK_ID`.
7. Re-run `pnpm job:reconcile` and `pnpm demo` to confirm the connection; a `GET /readyz` should report `paypal: ok`.
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
  | Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
  | Together | `https://api.together.xyz/v1` | `Qwen/Qwen2.5-72B-Instruct-Turbo` |
  | DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
  | Ollama (offline) | `http://localhost:11434/v1` | `qwen2.5:14b-instruct` |

  Requirements: multi-call tool use and reliable JSON arguments. Keep `LLM_TEMPERATURE` low (0.2).

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

## 7. Database helpers

```bash
# Inspect
mongosh "$MONGODB_URI" --eval 'db.products.countDocuments({status:"active"})'

# Reset to a demo-ready state (drops data)
pnpm seed:reset --demo-orders

# Backup / restore for demos
mongodump --uri="$MONGODB_URI" --archive=demo-$(date +%F).archive
mongorestore --uri="$MONGODB_URI" --archive=demo-$(date +%F).archive --drop

# Verify the money invariants (must print zero violations)
pnpm ledger:check
```

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
`Transaction numbers are only allowed on a replica set member or mongos` | Mongo started standalone | use the provided `docker-compose.yml` (RS) or Atlas; check `?replicaSet=rs0&directConnection=true` |
`/readyz` shows `paypal: down` | wrong sandbox creds or no network | re-copy Client ID/Secret; confirm `PAYPAL_ENV=sandbox`; check egress |
PayPal Buttons do not render | ad-blocker, CSP, or missing `NEXT_PUBLIC_PAYPAL_CLIENT_ID` rebuilt into the bundle | rebuild after changing `NEXT_PUBLIC_*` (they are compile-time); check the console for CSP violations; the fallback panel should appear |
`INVALID_SIGNATURE` on webhooks | `PAYPAL_WEBHOOK_ID` does not match the current tunnel/app | re-copy the webhook id from the sandbox app; verify the tunnel URL still points at `:4000` |
Order stuck in `payment_processing` | capture response lost, webhook never delivered | `pnpm job:reconcile` or `POST /admin/orders/{id}/reconcile`; inspect `webhook_events` |
`CORS` error in the browser | split mode misconfigured | set `WEB_ORIGIN` exactly (scheme+host+port, no trailing slash) or use the proxied mode (`NEXT_PUBLIC_API_URL` empty) |
429 during a demo | rate limits | raise the relevant `RATE_*` env var for the demo, or restart with `NODE_ENV=development` budgets |
Agent answers without products | `FEATURE_LIVE_LLM=true` but the model is not calling tools | check the model name/base URL; run `pnpm test:evals` against the same model; try a stronger model for tool use |
`E11000 duplicate key` on seed | seed against a partially populated DB | `pnpm seed:reset` |

---

## 9. Production-ish checks before sharing a demo URL

- [ ] `COOKIE_SECURE=true`, `COOKIE_DOMAIN` set, `NODE_ENV=production`, real TLS
- [ ] `PAYPAL_ENV=sandbox` visible in `/version` and the footer discloses the sandbox
- [ ] The model actually used is named on the submission page (rules require naming the AI tool)
- [ ] Rate limits configured for the expected audience
- [ ] Logs shipped or at least `LOG_LEVEL=info` and redaction verified
- [ ] `pnpm ledger:check` clean on the hosted DB
- [ ] Backup taken before the demo and the restore path rehearsed
