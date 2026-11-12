# Architecture

ShopPilot AI is a single Node.js service that serves both the browser app and the JSON/SSE API.
There is no build step, separate frontend server, message queue or external database requirement.

```text
Browser (vanilla ES modules)
  ├─ storefront / assistant / cart / checkout / orders
  ├─ merchant dashboard (/merchant)
  └─ admin AG Grid console (/admin)
        │ same-origin REST + SSE, cookie session + CSRF
        ▼
Express 5 (app/server)
  ├─ http/        routes, Zod validation, middleware, security headers, error mapping
  ├─ agent/       requirement extraction, prompt, closed tool registry, orchestrator, LLM client
  ├─ services/    session, catalogue, cart, inventory, quote, order, payment, analytics
  ├─ payments/    PayPal sandbox gateway | in-process simulator; settlement math
  ├─ domain/      order state machine, analytics event catalogue, policies
  └─ store/       file-backed document store; Mongo driver stub
        │ HTTPS
        ├─ PayPal Orders v2 / OAuth2 / webhook verification
        └─ OpenAI-compatible LLM endpoint (Groq in the hosted demo)
```

## Runtime shape

| Concern | Implementation |
|---|---|
| Frontend | `app/shop/index.html` + vanilla ES modules in `app/shop/js/`; AG Grid vendored for offline use |
| API | Express 5 under `/api/v1`; SSE for chat; static SPA fallback for deep links |
| Auth | Server-side guest/user session cookie (`sid`), CSRF double-submit cookie/header, role checks |
| Agent | Closed tool registry loaded from `contracts/agent_tools.json`; live LLM or deterministic fallback |
| Money | Integer USD minor units; server-side quote hash; PayPal capture verification before `paid` |
| Storage | JSON document store at `app/.data/db.json` (override with `DATA_DIR`), single-writer transactions |
| Deployment | Render Node service via `render.yaml`; liveness health check; seed-on-boot when empty |

## Request flows

### Shopping

1. `POST /session/guest` creates a session and guest identity if needed.
2. The browser sends chat to `POST /chat/stream`; the orchestrator extracts requirements and calls
   registered tools. Tool results are the only source of product/price/stock facts.
3. Cart writes and reads use the same owner contract: guests are session-keyed; signed-in users are
   user-keyed. The agent and HTTP layer share this normalisation.
4. `POST /checkout/quote` recomputes totals from live prices and creates/extends stock holds.
5. `POST /orders` consumes the quote, snapshots lines/amounts, creates a PayPal order and returns the
   approval URL. The agent can prepare checkout but cannot approve or capture it.

### Payment

1. The human approves in PayPal.
2. `POST /payments/:orderId/capture` captures under a per-order lock and idempotency key.
3. `verifyCapture` checks order reference, amount, currency, capture status, uniqueness and settlement.
4. Only after verification does the service commit stock and transition the order to `paid`.
5. Webhooks and reconciliation recover lost capture responses; they re-fetch the full PayPal order and
   run the same verification path. See [payments_paypal.md](payments_paypal.md).

### Role landing

After sign-in the SPA lands merchants on `/merchant` and admins on `/admin`; shoppers stay on the
storefront. Backend authorisation is independent of the UI: merchant endpoints require merchant/admin
scope, admin endpoints require admin, and cross-tenant reads return 404/403 rather than leaking data.

## Agent safety boundary

The model can call only the tools in `contracts/agent_tools.json`. There is deliberately no tool for
creating, approving, capturing or refunding a payment, and no generic HTTP/shell/eval tool. Argument
schemas are validated before execution; identity is resolved server-side, never supplied by the model.
A grounding guardrail replaces model-invented prices with tool-verified figures. The deterministic
fallback uses the same registry and guards, so losing the LLM does not widen permissions.

## Settlement

`app/server/payments/settlement.mjs` builds one purchase unit per seller when configured payees are
confirmed and the allocation reconciles. Apportionment uses integer cents and largest-remainder
rounding so split units sum exactly to the order total. `payment.service.mjs` implements the fallback
ladder:

1. split + platform fees;
2. split without fees if only `platform_fees` is rejected;
3. single unit if payees/multi-seller capability are rejected.

Every downgrade is recorded on the order timeline and analytics. Invoice ids are
`orderNumber[-referenceId]-orderId` so an ephemeral-store counter reset cannot reuse an invoice id
already captured in the PayPal account. `custom_id` remains the order number for correlation.

## Storage and consistency

The file store implements Mongo-like collections, unique/sparse indexes, guarded updates, TTL sweeps
and serialisable single-writer transactions. It is suitable for a single-instance demo. The payment
service uses advisory locks and idempotency records; horizontal scaling would require a shared lock
and a real database. `MONGO_URI` currently selects a stub that refuses to boot, preventing a false
claim of persistence.

## Key decisions

| Decision | Why |
|---|---|
| Server-side PayPal Orders v2 | Amount, payee and capture state must be verified by the backend, not trusted from the browser. |
| Human approval outside the agent | Prompt injection must not be able to move money. |
| Integer minor units | Avoid floating-point drift in totals, tax, shipping and split settlement. |
| SSE for chat | One-way streaming works through proxies and is simple to retry. |
| File store by default | Judges can run the whole product with zero infrastructure. |
| Vendored assets | Storefront and AG Grid work without a CDN at request time. |
| Honest degradation | Simulator/fallback profiles and settlement downgrades are labelled, not hidden. |

## Related documents

[API](api_spec.md) · [Agent](ai_agent_spec.md) · [Payments](payments_paypal.md) ·
[Data model](data_model.md) · [Security](security_privacy.md) · [Setup](env_setup.md) ·
[Testing](testing_strategy.md) · [Runbooks](runbooks.md)
