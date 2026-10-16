# ShopPilot AI — System Architecture

## 1. Shape of the system

```
                     ┌───────────────────────────────────────────────┐
  Browser            │  Next.js 16 (apps/web)                        │
  ┌──────────────┐   │  • RSC pages: /, /products, /cart, /orders,    │
  │ React 19 UI  │◄──┤    /checkout, /merchant/*                      │
  │ SSE chat     │   │  • Route handlers = BFF proxy → Express API    │
  │ PayPal SDK   │   │  • Analytics beacon, session cookie handling   │
  └──────┬───────┘   └───────────────┬───────────────────────────────┘
         │ fetch (same-origin, httpOnly cookie)                      
         ▼                                                           
  ┌────────────────────────────────────────────────────────────────┐
  │  Express 5 API (apps/api, TypeScript, Node 24 LTS)             │
  │                                                                │
  │  routes/  →  controllers/  →  services/  →  repositories/      │
  │                      │                                         │
  │   ┌──────────────────┴──────────────────┐                      │
  │   │ Agent Orchestrator (LLM tool loop)  │   Payment Service    │
  │   │  • OpenAI-compatible tool-calling   │   • PayPal Orders v2 │
  │   │  • tool registry + validation       │   • idempotency      │
  │   │  • SSE streamer                     │   • capture verify   │
  │   └──────────────────┬──────────────────┘   • webhooks         │
  │                      ▼                                         │
  │   Domain services: Catalogue · Cart · Quote · Order · Auth ·   │
  │                    Analytics · Inventory                       │
  └───────────┬───────────────────────────────┬────────────────────┘
              │ Mongoose                      │ HTTPS + OAuth token (cached)
              ▼                               ▼
      ┌────────────────┐            ┌──────────────────────┐
      │ MongoDB 8      │            │ PayPal Sandbox       │
      │ (replica set   │            │ api-m.sandbox...     │
      │  for txns)     │            │ Orders v2 + Webhooks │
      └────────────────┘            └──────────────────────┘
              ▲
              │  fire-and-forget events
      ┌───────┴─────────┐
      │ analytics_events│  (same Mongo in v1; swappable behind an
      └─────────────────┘   AnalyticsSink interface)
```

**Why Next.js *and* Express?** The web app owns rendering, routing, SEO for catalogue pages, and the cookie boundary. The API is a separate, independently testable service that owns all domain rules and secrets, and is the only thing that talks to PayPal and the LLM provider. In the demo both run in one repository and are started by one `pnpm dev`.

Two deployment topologies are supported:

| Mode | Web → API | Web serves | Cookie domain | Use |
|---|---|---|---|---|
| **A. Split (default, production-like)** | `NEXT_PUBLIC_API_URL` cross-origin with CORS allow-list + credentials | RSC pages only | API domain; `SameSite=Lax`, `Secure`; SSO-free single domain recommended | Real deploys |
| **B. Proxied (dev, previews, containers)** | Next.js rewrites `/api/*` → `http://api:4000/*` server-side | All traffic | Same-origin, `SameSite=Lax` | Local dev, sandbox previews, single-app hosting |

Default to **B** in development so the app works over a single port/host and can be previewed in restricted environments. Keep the API host out of the browser entirely in mode B.

---

## 2. Repository layout (monorepo)

Use **pnpm workspaces + Turborepo**. Keep it flat and boring.

```
shoppilot-ai/
├─ apps/
│  ├─ web/                      # Next.js 16 App Router
│  │  ├─ src/app/               # routes: (marketing) (shop) (merchant) api/
│  │  ├─ src/components/        # ui/ chat/ product/ cart/ checkout/ merchant/
│  │  ├─ src/lib/               # apiClient, sse, formatMoney, analytics, session
│  │  ├─ src/hooks/             # useChatStream, useCart, useOrder, useTheme
│  │  ├─ src/styles/            # tokens.css, globals.css
│  │  ├─ messages/en.json
│  │  └─ next.config.ts, tailwind.config.ts (v4 uses CSS @theme)
│  └─ api/                      # Express 5 service
│     ├─ src/index.ts           # bootstrap: env → db → app → listen
│     ├─ src/app.ts             # express app, middleware chain, error handler
│     ├─ src/config/            # env.ts (zod), logger.ts, db.ts, paypal.ts
│     ├─ src/routes/            # v1/*.routes.ts
│     ├─ src/controllers/       # thin: parse → service → respond
│     ├─ src/services/          # auth, catalogue, cart, quote, order, payment,
│     │                         # inventory, analytics, mailer
│     ├─ src/agent/             # orchestrator.ts, prompt.ts, tools/*.ts, stream.ts
│     ├─ src/repositories/      # mongoose data access only
│     ├─ src/models/            # mongoose schemas
│     ├─ src/middleware/        # session, auth, rbac, rateLimit, idempotency,
│     │                         # validate(zod), requestContext, errorHandler
│     ├─ src/jobs/              # releaseExpiredHolds, reconcilePayments, pruneEvents
│     └─ tests/                 # unit/ integration/ contract/
├─ packages/
│  ├─ shared/                   # types, zod schemas, order state machine, money,
│  │                            # categorySchemas, constants, eventNames
│  └─ config/                   # eslint, tsconfig, prettier presets
├─ docs/                        # this documentation set
├─ contracts/                   # openapi.yaml, agent_tools.json
├─ data/seed.catalog.json
├─ scripts/                     # seed.ts, reset.ts, gen-openapi.ts, demo.ts
├─ AGENTS.md · README.md · prd.md · design_system.md
└─ pnpm-workspace.yaml · turbo.json · .env.example · docker-compose.yml
```

**Layering rule (enforced by lint):** `routes → controllers → services → repositories → models`. A controller may not import a model; a service may not import Express types; the agent layer may only call **services** (never repositories, never models) so all business rules are reusable and testable.

---

## 3. Core runtime flows

### 3.1 Guest bootstrap + chat turn (streaming)

```
Client                     Web (BFF)              API                     LLM           Mongo
  │ GET /chat               │                       │                        │             │
  │────────────────────────►│  GET /api/v1/session  │                        │             │
  │                         │──────────────────────►│ no sid → create guest  │             │
  │                         │                       │────────────────────────────────────►│
  │◄── httpOnly sid cookie ─┤◄── {userId, role}─────┤                        │             │
  │ POST /api/v1/chat/stream│                       │                        │             │
  │────────────────────────►│  (proxy, keep SSE)    │                        │             │
  │                         │──────────────────────►│ load session, requirement, history      │
  │                         │                       │────────────────────────────────────►│
  │                         │                       │ build messages + tool defs             │
  │                         │                       │───────────────────────►│ stream       │
  │◄─ event: tool.activity ─┤◄──────────────────────┤◄── tool_call ──────────┤             │
  │                         │                       │ execute tool (catalogue service)       │
  │                         │                       │────────────────────────────────────►│
  │◄─ event: ui.component ──┤◄──────────────────────┤  (cards payload)       │             │
  │◄─ event: message.delta ─┤◄──────────────────────┤◄── text deltas ────────┤             │
  │◄─ event: message.end ───┤◄──────────────────────┤ persist message + revision + events    │
  │                         │                       │────────────────────────────────────►│
```

SSE details: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, heartbeat `:ping` every 15 s, `retry: 3000`, single stream per request, server closes on `message.end` or abort. Event names and payloads: `api_spec.md` §7.

### 3.2 Cart → quote → order → PayPal (the money path)

```
Client                        API                            Mongo           PayPal
  │ POST /cart/items           │                              │                │
  │───────────────────────────►│ inventory.check(qty) → cart update            │
  │◄── cart (server prices) ───┤                              │                │
  │ POST /checkout/quote       │                              │                │
  │───────────────────────────►│ read prices NOW, compute shipping+tax,        │
  │                            │ create/refresh soft holds (15 min)            │
  │                            │─────────────────────────────►│                │
  │◄── quote {breakdown,expiresAt} ───────────────────────────┤                │
  │ POST /orders (Approve & Pay clicked)                       │                │
  │───────────────────────────►│ create order (snapshot lines, status=awaiting_payment,
  │                            │ idempotencyKey from client), commit holds     │
  │                            │─────────────────────────────►│                │
  │                            │ POST /v2/checkout/orders (PayPal-Request-Id)  │
  │                            │──────────────────────────────────────────────►│
  │                            │◄── { id: PAYPAL-ORDER } ──────────────────────┤
  │◄── {orderId, paypalOrderId, clientId} ────────────────────┤                │
  │  PayPal Buttons approval in payer's browser ──────────────────────────────►│
  │ POST /payments/{orderId}/capture                            │                │
  │───────────────────────────►│ lock order → POST .../capture │                │
  │                            │──────────────────────────────────────────────►│
  │                            │◄── capture result (COMPLETED, amount, id) ────┤
  │                            │ VERIFY amount+currency vs order; commit stock │
  │                            │ set paid; record attempt; emit analytics      │
  │                            │─────────────────────────────►│                │
  │◄── {status:"paid", captureId} ─────────────────────────────┤                │
  │  redirect → /orders/{id}/confirmation                      │                │
```

Every arrow into PayPal carries an idempotency key; every arrow out is validated before it can change order state (see §5).

---

## 4. Service boundaries

| Service | Owns | Never does |
|---|---|---|
| `sessionService` | guest create, cookie payload, session→user upgrade, cart merge | reads products |
| `authService` | register, login, argon2 hash/verify, JWT issue/rotate/revoke | touches orders |
| `catalogueService` | product CRUD, search/filter/sort, facets, price history | mutates stock on payment |
| `inventoryService` | stock reads, atomic decrements, soft holds (create/extend/release/commit), release-expired job | prices |
| `cartService` | cart CRUD, line merge, stock caps, price-change flags | creates orders |
| `quoteService` | shipping rule table, tax rule, quote persistence + TTL, staleness check | charges money |
| `orderService` | draft order creation from quote, snapshots, state machine transitions, order numbers, history queries | talks to PayPal directly (delegates) |
| `paymentService` | PayPal token cache, create order, capture, verify, attempts, idempotency locks, webhook ingestion, reconciliation | writes prices or totals of its own |
| `agentOrchestrator` | LLM loop, tool dispatch, guardrails, streaming | any direct DB writes outside services |
| `analyticsService` | event validation + insert, funnel + timeseries aggregation | blocks request path |
| `mailer` | receipt/retry emails, `console` transport in dev | — |

---

## 5. Reliability & correctness patterns

1. **Single write path for money.** Only `paymentService.verifyAndApplyCapture()` may set `status: paid`. It re-reads the order inside a transaction, validates `status ∈ {awaiting_payment, payment_processing, payment_failed}` and compares amounts.
2. **Idempotency keys everywhere.**
   * Client → API: `Idempotency-Key` header on `POST /orders`, `POST /payments/*/capture`, `POST /cart/items`. Stored in `idempotency_keys` with `{key, userId, route, requestHash, response, status, expiresAt}` (24 h).
   * API → PayPal: `PayPal-Request-Id` = `sha256("pp:"+orderId+":"+attemptNo)` — deterministic, so a retried request maps to the same PayPal operation.
3. **Locks.** `paymentService` takes a MongoDB advisory lock (`locks` collection: `{_id: orderId, holder, expiresAt}`) with a 30 s TTL before creating/capturing. Losers get `409 PAYMENT_IN_PROGRESS` and the UI shows the processing state.
4. **Atomic stock.** `inventory.commitHolds()` uses `findOneAndUpdate({_id, stock: {$gte: qty}}, {$inc: {stock: -qty}})` per line, inside a transaction with the order status update; any failure aborts all lines and leaves the order `payment_failed` with a clear reason (no partial fulfilment).
5. **Reconciliation.** Job every 5 min: orders in `payment_processing` older than 2 min → `GET /v2/checkout/orders/{paypalOrderId}` → if `COMPLETED`, verify + apply; if `VOIDED`/expired, mark `payment_failed`. Webhook `PAYMENT.CAPTURE.COMPLETED` for an unknown-then-known order uses the same function.
6. **Webhook ingestion.** Raw body kept for signature verification (`express.raw` on that route only), verified with `POST /v1/notifications/verify-webhook-signature`, deduplicated by `event.id` in `webhook_events` (unique index), always answered `200` (PayPal retries on non-2xx), processing transactional and idempotent.
7. **Timeouts & retries.** PayPal HTTP: connect 3 s, total 10 s, retry 2× with jittered backoff **only** for `5xx`/network and only for idempotent calls (same request id). LLM: 30 s total, 1 retry, circuit breaker after 5 consecutive failures (open 60 s).
8. **Graceful degradation.** If the LLM is down, `/products` and cart/checkout still work end-to-end. If PayPal is down, orders can be created as `awaiting_payment` and the UI shows "Payments temporarily unavailable — your cart is safe."
9. **Hold expiry.** TTL index on `inventory_holds.expiresAt`; job every minute releases expired holds and marks their orders `expired` when still `awaiting_payment`.
10. **Transactions.** Mongo replica set required (single-node RS in docker-compose). Used for: cart→order conversion, capture application, stock commit, hold release.

---

## 6. Configuration & environment

`apps/api/src/config/env.ts` validates with Zod at boot and **fails fast** with a readable list of missing vars. See `docs/env_setup.md` for the full table. Secrets never reach the browser: only `NEXT_PUBLIC_PAYPAL_CLIENT_ID`, `NEXT_PUBLIC_PAYPAL_CURRENCY`, `NEXT_PUBLIC_API_URL` (dev) are public.

Feature flags (env-driven, defaulted for the demo): `FEATURE_LIVE_LLM` (false → deterministic fake LLM for CI), `FEATURE_WEBHOOKS`, `FEATURE_ANALYTICS`, `FEATURE_GUEST_ORDERS`, `PAYMENT_MAX_ATTEMPTS=3`.

---

## 7. Observability

* **Logging:** pino JSON; fields `ts, level, msg, requestId, sessionId, userId, route, durationMs, orderId?, paymentAttemptId?, toolName?`. Redaction list: `req.headers.cookie|authorization`, `body.password`, `body.email`, PayPal tokens, payer email (hash instead: `payerEmailHash`).
* **Request IDs:** generated at the edge (Next.js middleware) → forwarded as `x-request-id` → echoed in every response and shown in user-facing errors.
* **Metrics (in-process counters + `/metrics` text or logs):** `chat_turns_total`, `llm_tokens_in/out`, `tool_calls_total{tool,status,duration}`, `payments_created_total`, `payments_captured_total`, `payments_failed_total{reason}`, `holds_expired_total`, `reconciled_orders_total`.
* **Alerts (documented, not wired in demo):** capture-verify mismatch (P1), webhook signature failures > 5/min (P2), `payments_failed` rate > 15 % (P2), LLM circuit open (P3).
* **Health:** `/healthz` (process only, 200), `/readyz` (Mongo ping + PayPal token fetch cached result), `/version` (git sha + build time).

---

## 8. Security architecture (summary — details in `docs/security_privacy.md`)

* Cookie session (guest) + JWT access (15 min) / rotating refresh (30 d, httpOnly, hashed in DB) for accounts.
* RBAC middleware: `requireAuth`, `requireRole('merchant')`, `requireOrderOwner`, `requireMerchantScope`.
* All input validated with Zod at the route boundary; unknown keys stripped; Mongo operator injection blocked (`strictQuery`, no raw `req.body` into queries, `$`-key rejection in sanitizer).
* Rate limiting per IP + per session (Redis optional; in-memory LRU in demo) with different budgets per route class.
* CORS: explicit allow-list per environment; `credentials: true`; no wildcard with credentials.
* CSRF: state-changing requests require `Origin` match plus `x-sp-csrf` double-submit token bound to the session (chat SSE and payment endpoints included).
* Prompt-injection defence: product descriptions/spec text are wrapped as untrusted data, the system prompt declares them non-instructions, and the agent has no tool that can move money or read other users' data.
* PayPal: server-side secrets only; webhook signature verification; never trust client-reported payment status; capture verification recomputes totals from our DB.

---

## 9. Deployment

**Local (documented in `docs/env_setup.md`)**
`docker compose up -d mongo` → `pnpm install` → `pnpm --filter api seed` → `pnpm dev` (turbo runs web :3000 + api :4000) → `ngrok http 4000` for sandbox webhooks.

**Containers**
`apps/api/Dockerfile` (node:24-alpine, multi-stage, non-root, `tini`), `apps/web/Dockerfile` (Next standalone output). `docker-compose.yml` with `mongo` (single-node replica set), `api`, `web`, optional `mongo-express`.

**Single-host demo**
Any container host (Fly/Render/Railway/EC2) with: Mongo Atlas free tier or managed RS, API service, web service, env vars, sandbox PayPal app. Set `WEB_ORIGIN` + `API_ORIGIN` correctly; in proxied mode the browser only ever sees the web origin.

**Scaling notes**
API is stateless (sessions in Mongo/JWT) except in-memory rate limiting → move to Redis before multi-instance. SSE connections are long-lived: set `proxy_read_timeout ≥ 120 s`, disable response buffering, and prefer a Node runtime (not edge) for the API.

---

## 10. Decision log (ADRs)

| # | Decision | Rationale | Consequence |
|---|---|---|---|
| D1 | Separate Express API instead of Next route handlers for domain logic | Testable in isolation, clear ownership of secrets, easier to show the "backend enforces business rules" requirement | Two processes; mitigated by proxied mode |
| D2 | MongoDB + Mongoose | Required by the brief; flexible specs/attributes fit typed-but-varied product data | Must add explicit zod validation + indexes to avoid schema drift |
| D3 | Integer minor units for money | Eliminates float rounding bugs in totals and PayPal payloads | Formatting only at the edge |
| D4 | Server-side PayPal Orders v2 (never the deprecated client-only `actions.order.create`) | Correct amount, verified capture, idempotency | Requires more endpoints + open-order handling |
| D5 | SSE, not WebSockets | One-way stream, works through proxies, trivially retryable, no sticky sessions | No server-initiated push; polling covers order status if needed |
| D6 | Agent can read/compare/mutate cart, but **cannot** create or capture payments | Safety + requirement that the user explicitly approves | Payment is a plain HTTP flow in the UI, independent of the agent loop |
| D7 | Ranking in code, not in the model | Deterministic, testable, explainable `whyItFits` | Model explains and adapts, code decides |
| D8 | Fake-LLM adapter for CI | Deterministic tests, zero cost, no rate limits | Must be kept behaviour-compatible with the real adapter (`ai_agent_spec.md` §7) |
| D9 | Soft holds instead of hard reservations | Simpler than per-user stock partition, adequate for demo | Oversell risk bounded by re-check at capture + reconciliation |
| D10 | Single platform merchant of record in v1 | Avoids marketplace payouts complexity | Merchant sees orders but does not receive funds in the demo |
