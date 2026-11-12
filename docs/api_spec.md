# API reference (as built)

Base path: `/api/v1`. The Express routes in `app/server/http/routes.mjs` and Zod schemas in
`app/server/http/validate.mjs` are the runtime source of truth. This document describes the shipped
API; there is no separate generated OpenAPI client.

## Conventions

- Money is integer USD minor units (`*Minor`) plus `currency: "USD"`; display strings are formatted at
  the edge.
- IDs are opaque strings. Session identity comes from the `sid` cookie; the browser never supplies a
  trusted `userId`/`sessionId`.
- Mutations require the CSRF double-submit pair: `csrf` cookie + `x-sp-csrf` header.
- Order creation and capture accept `Idempotency-Key`; replays return the original result.
- Errors use `{ "error": { "code", "message", "requestId", "details?" } }`.
- Guest carts/orders are session-scoped. Signed-in customers are user-scoped. Merchants see only their
  own lines/products; admins have platform oversight.

## Session & auth

| Method | Path | Purpose |
|---|---|---|
| POST | `/session/guest` | Create a guest session/cart if none exists |
| GET | `/session/me` | Current user, session, cart and chat summary |
| POST | `/auth/register` | Register a customer and sign in |
| POST | `/auth/login` | Sign in; merge guest cart/claim eligible guest orders |
| POST | `/auth/refresh` | Refresh auth tokens where issued |
| POST | `/auth/logout` | Clear session/auth cookies |

Demo roles: `customer`, `merchant`, `admin`, plus `guest`.

## Catalogue

| Method | Path | Purpose |
|---|---|---|
| GET | `/categories` | Category tree/attribute schemas |
| GET | `/products` | Search/filter/paginate active products |
| GET | `/products/:slugOrId` | Product detail |
| GET | `/products/:id/history` | Merchant-owned price/stock history |
| POST | `/products` | Merchant creates a product |
| PATCH | `/products/:id` | Merchant updates own product |
| DELETE | `/products/:id` | Merchant archives own product |

## Cart & checkout

| Method | Path | Purpose |
|---|---|---|
| GET | `/cart` | Current owner's cart, recomputed from live prices |
| POST | `/cart/items` | Add item (`productId`, `quantity`, optional `addedVia`) |
| PATCH | `/cart/items/:productId` | Set absolute quantity; `0` removes |
| DELETE | `/cart/items/:productId` | Remove line |
| DELETE | `/cart` | Clear cart |
| POST | `/checkout/quote` | Recompute totals and create/extend stock holds |
| POST | `/orders` | Consume quote, create order + PayPal order; requires contact email |
| GET | `/orders` | List caller's orders |
| GET | `/orders/:orderId` | Order detail, payment state, timeline, verification checks |
| POST | `/orders/:orderId/cancel` | Cancel an unpaid order and release holds |

A stale quote hash returns `409 QUOTE_STALE`; unavailable stock returns `409 ITEM_UNAVAILABLE` or
`INSUFFICIENT_STOCK` with details.

## Payments

| Method | Path | Purpose |
|---|---|---|
| POST | `/payments/:orderId/capture` | Capture an approved PayPal order; only verified path to `paid` |
| POST | `/payments/:orderId/retry` | New attempt on the same order after a retryable failure |
| GET | `/payments/:orderId/status` | Poll payment/order status |
| POST | `/webhooks/paypal` | Raw-body PayPal webhook; signature verified and deduplicated |
| POST | `/admin/orders/:orderId/reconcile` | Admin forces reconciliation against PayPal |

Capture responses include the order, capture id, amount verification and receipt data. Pending captures
return `202 PAYMENT_PENDING`. Declines return `402`; verification mismatches return
`409 PAYMENT_VERIFICATION_FAILED`. Duplicate invoice/capture states are routed to reconciliation rather
than silently charging again. Webhook requests are answered `200` even when unverified/malformed so
PayPal does not retry forever; unverified events are recorded and never apply payment state.

## Chat (SSE)

| Method | Path | Purpose |
|---|---|---|
| POST | `/chat/stream` | Run one agent turn; response is `text/event-stream` |
| GET | `/chat/sessions/:sessionId/messages` | Restore authorised transcript |
| PATCH | `/chat/sessions/:sessionId/requirement` | Update structured requirement |

SSE frames include `message.start`, `message.delta`, `tool.activity`, `ui.component`, `message.end`
and `error`. `message.end.usage.profile` reports `live` or `deterministic-fallback`. The model can call
only the closed tool registry; it has no payment capability.

## Analytics

| Method | Path | Purpose |
|---|---|---|
| POST | `/analytics/events` | Client beacon; strict event/prop allow-list, no PII |

See [analytics_spec.md](analytics_spec.md).

## Merchant

| Method | Path | Purpose |
|---|---|---|
| GET | `/merchant/overview` | Revenue, paid orders, AOV, low stock, recent orders |
| GET | `/merchant/products` | Own products |
| POST | `/merchant/products` | Create own product |
| PATCH | `/merchant/products/:id` | Update own product |
| GET | `/merchant/orders` | Orders containing own lines |
| GET | `/merchant/orders/:orderId/attempts` | Payment attempt audit for own order |
| PATCH | `/merchant/orders/:orderId` | Fulfilment action (e.g. mark shipped) |
| POST | `/merchant/orders/:orderId/refund` | Refund only own captured lines |
| GET | `/merchant/analytics` | Discovery/conversion funnel |
| GET | `/merchant/categories` | Categories for product management |

Admins may pass `merchantId` where the route explicitly supports oversight. Merchants cannot mark an
order paid or move money outside the verified refund path.

## Admin

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/overview` | GMV, commission, seller disbursements, orders, settlements |
| POST | `/admin/orders/:orderId/reconcile` | Reconcile a capture with PayPal |

## Health & diagnostics

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | Liveness; used by Render |
| GET | `/readyz` | Deep readiness: store, PayPal, LLM |
| GET | `/version` | Build/runtime info, PayPal mode/health, LLM profile, test count |
| GET | `/diagnostics/llm` | Model/provider diagnostics |

Simulator-only `/dev/*` helpers exist for local testing and are not registered in production sandbox
mode. Never run simulator smoke scripts against the public deployment.

## Common error codes

| Code | HTTP | Meaning |
|---|---:|---|
| `VALIDATION_ERROR` | 400 | Invalid request body/query |
| `UNAUTHENTICATED` | 401 | No valid session |
| `FORBIDDEN` | 403 | Role/ownership denied |
| `NOT_FOUND` / `ORDER_NOT_FOUND` / `PRODUCT_NOT_FOUND` | 404 | Missing or cross-tenant resource |
| `QUOTE_STALE` | 409 | Quote hash/price changed |
| `INSUFFICIENT_STOCK` / `ITEM_UNAVAILABLE` | 409 | Stock cannot satisfy request |
| `PAYMENT_IN_PROGRESS` | 409 | Per-order lock busy |
| `ORDER_ALREADY_CAPTURED` | 409 | Capture already exists; reconcile |
| `PAYMENT_VERIFICATION_FAILED` | 409 | Capture did not match order |
| `PAYMENT_DECLINED` / `PAYMENT_INSUFFICIENT_FUNDS` | 402 | Buyer funding failure |
| `PAYMENT_PENDING` | 202 | Capture pending; poll |
| `PAYMENT_PROVIDER_UNAVAILABLE` | 503 | PayPal unreachable |
| `RATE_LIMITED` | 429 | Rate limit exceeded |

The authoritative catalogue is `app/server/lib/errors.mjs`.
