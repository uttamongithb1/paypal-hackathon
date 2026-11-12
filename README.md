# ShopPilot AI

Conversational commerce with a PayPal checkout the AI agent cannot approve.

[![CI](https://github.com/uttamongithb1/paypal-hackathon/actions/workflows/ci.yml/badge.svg)](https://github.com/uttamongithb1/paypal-hackathon/actions/workflows/ci.yml)

**Live demo:** <https://paypal-hackathon.onrender.com/> · **Architecture & invariant proof:** <https://paypal-hackathon.onrender.com/how-it-works> · **Tests:** 162 passing · **License:** MIT

A shopper describes what they need in plain language. ShopPilot grounds every recommendation in a
real catalogue, builds a multi-seller cart, prepares a server-priced order, and opens PayPal checkout.
The agent has **no payment tool**: only the human can approve, and only the server can mark an order
paid after verifying PayPal's capture.

## What it does

- **Grounded AI shopping** — requirement extraction, catalogue search, comparison, stock checks,
  cart edits, quote estimates and policy answers through a closed, validated tool registry.
- **Human-approved PayPal checkout** — Orders v2 create/approve/capture, idempotency, webhook
  signature verification, capture verification, refunds and reconciliation.
- **Multi-seller settlement** — one purchase unit per seller with `payee` and optional platform fees;
  an honest fallback ladder when the sandbox account lacks a capability.
- **Role-based surfaces** — shoppers land on the storefront, merchants on `/merchant`, admins on the
  `/admin` Platform Console with AG Grid sorting/filtering and CSV export.
- **Auditable state** — integer-cent money math, stock holds, order state machine, payment attempts,
  timeline events and a ledger invariant report.

## Quick start

Requires Node.js **20.11+** and npm. No database, PayPal account or API key is needed for the offline
simulator.

```bash
git clone https://github.com/uttamongithb1/paypal-hackathon.git
cd paypal-hackathon
./dev-up.sh
```

Open <http://localhost:4000/>.

```bash
./dev-up.sh --check    # install if needed, seed if empty, run the verification gate; do not start a server
./dev-up.sh --reseed   # reset to the documented demo state, then start
```

Manual equivalent:

```bash
cd app
npm ci
npm run seed
npm start
```

### Demo accounts

| Role | Email | Password | Lands on |
|---|---|---|---|
| Shopper | `customer@demo.dev` | `Customer@12345` | Storefront |
| Merchant | `merchant@demo.dev` | `Merchant@12345` | `/merchant` dashboard |
| Admin | `admin@demo.dev` | `Admin@12345` | `/admin` Platform Console |

Guest checkout works without sign-in. To approve a real sandbox payment, use a **Personal** sandbox
buyer account from PayPal Developer → Testing Tools → Sandbox Accounts. Never use live credentials.

## PayPal sandbox

The default `PAYPAL_MODE=simulator` exercises the full payment lifecycle in-process. To use the real
PayPal sandbox:

```bash
cd app
cp .env.example .env
```

Set:

```dotenv
PAYPAL_MODE=sandbox
PAYPAL_CLIENT_ID=<sandbox REST app client id>
PAYPAL_CLIENT_SECRET=<sandbox REST app secret>
PAYPAL_WEBHOOK_ID=<webhook id, required to trust inbound webhooks>
WEB_ORIGIN=http://localhost:4000
```

Then:

```bash
npm run paypal:check                         # OAuth + create order + buyer approval URL
npm run paypal:check -- --capture <orderId>  # after buyer approval: capture + verify
npm run paypal:settlement                    # multi-seller capability/settlement probe
npm run paypal:settlement -- --capture <id>  # after approval: per-seller captures
```

`PAYPAL_SETTLEMENT=auto|split|single` controls settlement. `auto` tries split settlement and records
any downgrade to split-without-fees or single-unit capture. Configure confirmed sandbox **business**
payees with `PAYPAL_PAYEE_<SLUG>`; seeded placeholder payees are never used for real split capture.
See [docs/payments_paypal.md](docs/payments_paypal.md).

## AI tools and how they are used

| Tool | Use in this project |
|---|---|
| **Groq Cloud — `openai/gpt-oss-120b`** | Live tool-calling model for the deployed demo: interprets shopper intent, selects closed registry tools and composes grounded responses. |
| **OpenAI-compatible chat-completions API** | Provider abstraction in `app/server/agent/llm.mjs`; any compatible endpoint/model can be configured. |
| **Deterministic planner** | Offline fallback and CI path. Same tool registry, guardrails and SSE frames; no API key or network model required. |
| **PayPal Orders v2 + Webhooks** | Central payment capability: server-created orders, human approval, verified capture, multi-seller settlement and event reconciliation. |
| **AG Grid Community** | Admin financial console: sortable/filterable order and settlement grids with CSV export. |
| **Render** | Hosted Node deployment via `render.yaml`. |

The model never receives PayPal credentials and cannot create, approve, capture or refund a payment.
Prices, stock, totals and payment state come from server tools, not model text. A turn reports whether
it was served by the live model or the deterministic fallback.

To run a live model locally:

```dotenv
FEATURE_LIVE_LLM=true
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_API_KEY=<your key>
LLM_MODEL=openai/gpt-oss-120b
```

## Verification

```bash
cd app
npm test          # unit + integration + agent evals
npm run verify    # tests + ledger invariants + recorded test-count gate
npm run ledger    # invariant report against the current store
npm run smoke     # simulator-only HTTP smoke test against a running local server
npm run test:ui   # simulator-only browser regression against a local server
```

CI runs `npm run verify` and the UI import-graph check. The current suite is **162 tests / 13 suites**.
Do not run simulator-only smoke/UI scripts against the public deployment.

## Deploy on Render

The repository includes `render.yaml`. In Render: **New → Blueprint → select this repository**, then
set the secret environment variables in the dashboard:

- `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`
- `LLM_API_KEY`
- optional confirmed sandbox business payees: `PAYPAL_PAYEE_VERTEX_SYSTEMS`,
  `PAYPAL_PAYEE_NOVATECH_RETAIL`, `PAYPAL_PAYEE_AUDIOPEAK`

`JWT_SECRET` and `PII_HASH_PEPPER` are generated by Render. The blueprint uses sandbox PayPal, live
Groq, HTTPS cookies and `SEED_ON_BOOT=true`.

**Storage trade-off:** the reference build uses a JSON file store. Render's free plan has an ephemeral
disk, so visitor-created data can disappear on redeploy/restart; the catalogue and demo accounts are
reseeded when empty. Payment invoice ids include a unique order id so counter resets cannot reuse a
captured PayPal invoice. For durable data, implement the documented Mongo driver or attach persistent
storage. The bundled `MONGO_URI` path is intentionally a stub and refuses to boot rather than pretend
persistence works.

## Repository layout

```text
app/
  server/        Express 5 API, agent, services, PayPal gateway, file store
  shop/          Vanilla-ESM storefront, merchant dashboard, admin AG Grid console
  scripts/       seed/reset, tests, verification, ledger, PayPal probes, photo import
  tests/         unit, integration and agent evals
contracts/       agent_tools.json — runtime tool contract loaded by the server
data/            catalogue seed and product-photo provenance
docs/            as-built architecture, API, payments, security, setup and runbooks
.github/         CI workflow
render.yaml      Render blueprint
dev-up.sh        one-command local bootstrap
```

Product photos are vendored WebP assets under `app/shop/products/`; provenance is in
`data/product-photo-sources.json`. Nothing is hot-linked at request time. Re-import external photos
with `cd app && npm run photos` (ImageMagick recommended).

## Documentation

- [Architecture](docs/architecture.md)
- [API reference](docs/api_spec.md)
- [AI agent specification](docs/ai_agent_spec.md)
- [PayPal payments](docs/payments_paypal.md)
- [Data model & invariants](docs/data_model.md)
- [Security & privacy](docs/security_privacy.md)
- [Environment & local setup](docs/env_setup.md)
- [Testing strategy](docs/testing_strategy.md)
- [Runbooks](docs/runbooks.md)
- [Analytics](docs/analytics_spec.md)
- [UI flows](docs/ui_flows.md)
- [Design system](docs/design_system.md)

## Scope

This is a working reference implementation, not a production marketplace. The PayPal integration is
real and sandbox-switchable; the file store, single-instance locks and demo catalogue are deliberate
hackathon trade-offs. The agent's inability to pay is a safety property, not a missing feature.

## License

[MIT](LICENSE).
