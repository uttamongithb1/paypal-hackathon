# ShopPilot AI — Security & Privacy

Threat-informed requirements. Every item here maps to a test or a CI check; anything not testable is documented as an operational control.

---

## 1. Trust boundaries

```
[ Browser ] --cookie/TLS--> [ Web (Next) ] --server fetch--> [ API (Express) ] --TLS--> [ PayPal ]
      |                             |                              |
      |                             |                              +-- TLS --> [ LLM provider ]
      |                             |                              +-- local --> [ MongoDB ]
      +-- PayPal JS SDK iframe (sandbox.paypal.com) ---------------- hosted by PayPal, out of our trust domain
```
Never trusted: anything from the browser (prices, totals, quantities, order status, payment status, `userId`, `sessionId`, tool arguments produced by the LLM), and anything inside product text/LLM output.

---

## 2. Authentication

| Concern | Requirement |
|---|---|
Guest | Server-generated 256-bit `sid` (base64url, stored hashed-in-DB as the session `_id`), httpOnly, `SameSite=Lax`, `Secure` in prod, `Path=/`, 30-day rolling expiry. Never used for authorisation beyond the session's own cart/orders. |
Passwords | argon2id (`memoryCost 19456, timeCost 2, parallelism 1`), min length 10, zxcvbn score ≥ 2, breach-check hook (k-anonymity, optional), constant-time verify, per-IP + per-account throttling, generic error messages. |
Access tokens | JWT (HS256, 32-byte secret or rotating keys), 15 min, claims `{ sub, role, merchantId?, sid, jti }`, verified with `algorithms: ['HS256']`, `iss`/`aud` checked. |
Refresh tokens | 30 days, random 256-bit, stored **hashed**, rotated on every use, reuse revokes the whole family (theft detection → `401 TOKEN_REUSE` + forced re-login + audit log). |
Logout | Revokes the current refresh family and clears cookies; server-side cart/orders remain. |
Merchant/admin | Same JWT mechanism + `role` claim + `merchantId` scoping; no separate login surface, but `/merchant/*` requires `role === 'merchant'|'admin'` (server-side check in the loader, not only middleware). |
Step-up (documented, not v1) | Require password re-entry for refund/admin actions. |

Session fixation: on login, the guest `sid` is **upgraded in place** (same row, `kind: 'user'`, `userId` swapped) and the `csrf` token rotates.

---

## 3. Authorisation (RBAC + ownership)

```ts
// middleware/auth.ts
requireAuth()                       // 401 if no valid session/user
requireRole('merchant'|'admin')     // 403
requireOrderAccess(param='orderId') // owner | session owner | merchant of any line | admin, else 404
requireMerchantScope()              // every query is filtered by req.auth.merchantId
```
Rules:
* Merchant queries always include `merchantId: req.auth.merchantId` — cross-tenant reads return **404**, not 403 (no existence leak).
* `POST /products`, `PATCH /products/:id` assert `product.merchantId === req.auth.merchantId`.
* Orders: a merchant may read/update only orders containing one of their lines; they can `mark_shipped` but never change amounts or payment status.
* Admin endpoints are namespaced (`/admin/*`), rate-limited harder, and every call writes an `admin_audit` entry (`actorId, action, targetId, at, requestId`).
* Object-level checks live in services (not only middleware) so the agent path and the REST path share the same rules.

---

## 4. Input validation & injection defence

* Zod schema per route (`validate({ body, query, params })`); `.strict()` so unknown keys are rejected; numbers coerced explicitly; strings length-capped.
* Mongo safety: `mongoose.set('strictQuery', true)`; no `req.body` spread into queries; a sanitiser removes keys starting with `$` or containing `.` at every nesting level; `$where`, `$function`, `$expr` from user input are rejected.
* NoSQL/operator injection tests: `{"email":{"$gt":""}}` on login → `400 VALIDATION_ERROR`.
* Query/param limits: `limit ≤ 100`, filter arrays ≤ 20 keys, text query ≤ 200 chars, chat message ≤ 4 000 chars (server truncates with a notice), attached product ids ≤ 10.
* Path traversal: product images are served from `/public` with fixed names; no user-controlled file paths; no uploads in v1.
* SSRF: the API never fetches URLs supplied by users; product `images[].url` must match `/^\/(products|merchants)\//` or an allow-listed CDN host; the web app renders images via `next/image` with `remotePatterns` pinned.
* Prompt injection: product text wrapped as untrusted data, scanned for instruction patterns, never executed as tool calls; the agent's tool registry is closed and every argument is re-validated (`docs/ai_agent_spec.md` §9).
* Output encoding: React escapes by default; no `dangerouslySetInnerHTML` anywhere (lint rule); assistant text is rendered as plain text/markdown with a restricted renderer (no raw HTML, no images from model text, links only to internal product slugs).
* Headers: `helmet` with CSP (`default-src 'self'`, `script-src 'self' https://www.paypal.com https://www.sandbox.paypal.com`, `frame-src https://www.paypal.com`, `connect-src 'self' https://api-m.sandbox.paypal.com`, `img-src 'self' data:`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self' https://www.paypal.com`), HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` denying camera/mic/geo.

---

## 5. CSRF, CORS, clickjacking

* CSRF: double-submit `csrf` cookie (readable, `SameSite=Lax`) + `x-sp-csrf` header, compared in constant time, required on all state-changing routes **including** `POST /chat/stream`, `/orders`, `/payments/*/capture`, `/cart/*`. Origin/Referer must match `WEB_ORIGIN`.
* CORS (only relevant in split mode): `origin: [WEB_ORIGIN]`, `credentials: true`, methods restricted, `Access-Control-Max-Age: 600`. No wildcard; no reflection of arbitrary origins.
* Clickjacking: `frame-ancestors 'self'` (PayPal's own iframe is unaffected — we frame nothing of ours); the checkout page sets `X-Frame-Options: DENY` for extra safety.
* Webhook route: no cookies, no CSRF, raw body preserved for signature verification, IP-agnostic (signature is the auth).

---

## 6. Payments security (PCI boundary)

| Item | Position |
|---|---|
Card data | **Never** touches our systems. PayPal's JS SDK renders its own iframe; our CSP only allows `paypal.com` scripts. We are SAQ-A style scope (no cardholder data environment). |
PayPal credentials | Server env only; never logged, never sent to the browser; only `NEXT_PUBLIC_PAYPAL_CLIENT_ID` is public (safe by design). |
Amount integrity | Totals are computed server-side from DB prices; client-supplied amounts are ignored; the PayPal request is built from the order document; the capture is verified against the order (`payments_paypal.md` §4). |
Idempotency | `Idempotency-Key` (client) + deterministic `PayPal-Request-Id` (server) + per-order advisory lock prevent duplicate charges. |
Webhooks | Signature verified with PayPal's API; deduplicated; never used to *lower* a paid order; amounts re-checked against our DB. |
Refunds | Admin-only, explicit, audited; no refund tool for the agent. |
Sensitive logging | PayPal responses stored PII-stripped; payer email hashed with a server pepper; `responseSnapshot` excludes tokens and `payer.name`. |

---

## 7. Rate limiting & abuse

| Endpoint class | Limit | Key | On breach |
|---|---|---|---|
Global | 300 req/min | IP | 429
`/auth/*` | 10 / 15 min | IP + emailLower | 429 + audit; 5 failures → 15-min lockout of that email
`/chat/stream` | 20 msg / 5 min, 200 / day | sessionId | 429 + `Retry-After`, UI copy
`/checkout/quote`, `/orders` | 10 / 5 min | sessionId | 429
`/payments/*` | 10 / 5 min, 3 attempts per order | sessionId + orderId | 429 / `PAYMENT_ATTEMPT_LIMIT`
`/analytics/events` | 60 / min, batch ≤ 20 | sessionId | 429, drop batch
`/webhooks/paypal` | 600 / min | IP | 429 (PayPal retries; the event store is idempotent)
Implementation: in-memory LRU (single instance) behind a `RateLimiter` interface with a Redis implementation documented for multi-instance. Always emit `RateLimit-*` headers. Sensitive-key (email, IP, sessionId) hashing with a rotating salt for the limiter keys.

Other abuse controls: a maximum of 3 active orders per session; a maximum of 20 chat turns without a purchase (soft nudge, not a hard block); a global circuit breaker on the LLM provider; a spend guard on PayPal sandbox is unnecessary but production would add per-account velocity checks.

---

## 8. Data protection & privacy

| Data | Classification | Handling |
|---|---|---|
Email | PII | Stored plain on `users`/`orders.contact` (needed for receipts); hashed copy in analytics/limiter keys; never in logs. |
Password | Secret | argon2id hash only; never logged, never returned. |
Address | PII | Collected by PayPal at payment; stored on the order only when returned; not editable in chat; masked in merchant UI for non-fulfilment roles. |
Chat transcript | User content | Accessible to the owning session/user only; 180-day retention; summarised after 20 turns; redaction pass strips card-like/SSN patterns before storage in the summary. |
Payment identifiers | Sensitive | `paypalOrderId`, `captureId` stored (needed for support/reconciliation), never exposed to other users; only the last 6 chars of a capture id are used in analytics. |
Tokens | Secret | Refresh tokens hashed at rest; JWT secret in env/secret manager; rotation procedure documented. |
Logs | Mixed | Pino redaction list enforced in tests: `*.password`, `*.token`, `req.headers.cookie`, `req.headers.authorization`, `paypal*`, `payer.email`. |
Backups | PII | Mongo snapshots encrypted at rest; restore runbook includes re-applying TTLs. |

User rights: export (`GET /me/export` — JSON of user, orders, chat), deletion (anonymisation runbook in `docs/data_model.md` §6), and correction (`PATCH /me`). Retention table lives in `docs/data_model.md` §6 — the docs and the TTL indexes must agree (CI check compares TTL indexes to the documented values).

---

## 9. Threat model (top risks & controls)

| # | Threat | Impact | Controls | Test |
|---|---|---|---|---|
T1 | Client tampers with price/total | Fraud | Server-side quote + PayPal payload built from DB + capture verification | `tamperPrice` integration test
T2 | Duplicate capture (double-click, retry storm) | Double charge | Idempotency key, deterministic request id, advisory lock, `ORDER_ALREADY_CAPTURED` handling | `doubleClickApprove` e2e, `concurrentCapture`
T3 | Webhook spoofing | Fake "paid" | Signature verification, custom_id matching, amount re-check | `webhookSignatureInvalid`
T4 | Payment marked paid without capture | Silent loss | `paid` only in `verifyCapture`; invariant I3 test | nightly integrity job
T5 | Prompt injection via product text | Data leak / bad action | Untrusted-data wrapping, closed tool registry, no money tools | `injection_*` eval cases
T6 | LLM hallucination of price/stock | Trust loss, disputes | Tool-grounded facts, UI renders from structured payloads, eval `no_hallucination` | eval suite
T7 | Credential stuffing | Account takeover | Rate limits, argon2id, lockout, generic errors, optional breach check | rate-limit tests
T8 | XSS via chat/merchant content | Session theft | React escaping, no raw HTML renderer, CSP, input length caps | `renderSafety` test + CSP report-only in demo
T9 | CSRF on payment endpoints | Unauthorised order | Double-submit token + Origin check on all mutating routes | csrf test
T10 | Tenant data leak (merchant A sees B) | Confidentiality | `merchantId` scoping in every query, 404 semantics | tenant isolation suite
T11 | Oversell under concurrency | Fulfilment failure | Conditional atomic decrement, holds, re-check at capture | concurrency test
T12 | Guest order enumeration | Privacy | Opaque session-bound ids, 24 h guest window, rate limits | `guestOrderAccess` test
T13 | Cost/DoS via chat | Cost, availability | Turn/token budgets, tool timeouts, circuit breaker, rate limit | `llmBudget` test
T14 | Supply-chain (npm) | Compromise | `pnpm audit` in CI, lockfile committed, no post-install scripts for unknown deps, Dependabot | CI gate
T15 | Secret leakage to browser | Full compromise | Only `NEXT_PUBLIC_*` non-secret values bundled; a CI grep asserts no server secret appears in `.next/static` | build check

---

## 10. Security checklist for PRs (enforced in `AGENTS.md`)

- [ ] New route: Zod validation, auth/role middleware, rate limit class assigned, and an error catalogue entry
- [ ] New DB query: tenant/ownership filter present; no user input interpolated into filters
- [ ] New tool: closed registry entry, argument schema, side-effect declared, confirmation rule if destructive
- [ ] No new secret in client code; no secret in logs or error messages
- [ ] Money path change: idempotency + verification untouched or re-tested
- [ ] Migration/retention change reflected in docs (CI compares)
- [ ] `pnpm test:security` (authz, csrf, injection, rate limit, tenant isolation) passes

---

## 11. Incident response (lightweight, documented)

1. **Detect** — alerts from §7 metrics, `payments_verify_mismatch_total > 0`, webhook signature failures, 5xx spikes.
2. **Contain** — feature flag kill switches (`FEATURE_CHECKOUT`, `FEATURE_LIVE_LLM`, `FEATURE_WEBHOOKS`), rotate PayPal client secret and JWT secret, revoke refresh families.
3. **Assess** — reconcile all orders in `payment_processing`/`payment_failed` against PayPal (`POST /admin/orders/{id}/reconcile`), dump `webhook_events` for the window.
4. **Notify** — affected customers (email), merchant, and PayPal support if amounts are in question; include `requestId`s rather than internal details.
5. **Remediate & learn** — add a regression test, update this document, ticket in `docs/backlog.md` under `SEC-*`.
