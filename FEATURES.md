# ShopPilot AI — Feature Inventory

What is **built and working today**, what is **built but dormant**, and what is **not built yet**.
Verified against the running app on port 4000 (file store, 17 collections, 24 products, 3 merchants).

---

## 1. Autonomous shopping agent (the core)

| Feature | Status | Detail |
|---|---|---|
| Natural-language requirement capture | ✅ | Free-text turns → structured requirement (category, budget, RAM, storage, use case, quantity) with revisions |
| Clarification when under-specified | ✅ | Asks a targeted question instead of guessing |
| Grounded discovery | ✅ | `search_products` over the real catalogue — no invented products or prices |
| Comparison | ✅ | `compare_products` → side-by-side component with pros/cons/specs |
| Live stock + availability | ✅ | `check_availability` reads available-to-sell |
| Server-priced totals | ✅ | `get_quote_estimate` — agent never computes tax/shipping |
| Cart mutation by chat | ✅ | `add_to_cart`, `update_cart_item`, `remove_cart_item`, `clear_cart` |
| Order preparation | ✅ | `prepare_checkout` builds the PayPal order — **and stops** |
| Policy Q&A | ✅ | `answer_policy` (returns, warranty, shipping) |
| Remembered preferences | ✅ | `remember_preference`, `set_requirement` |
| Streaming responses | ✅ | SSE (`POST /chat/stream`), incremental tool-progress frames |
| **No payment tool at all** | ✅ | 14 tools registered; payment abilities are absent by construction, not by prompt |

**The safety property (demo this):** the agent is *structurally* unable to pay. `FORBIDDEN_TOOLS`
blocks `create_paypal_order`, `capture_payment`, `authorize_payment`, `refund`, `cancel_order`,
`delete_account`, `send_email`, `read_other_user_data`, `http_request`, `shell`, `eval`. Approval
is a human act; verification happens server-side.

---

## 2. Commerce & catalogue

- 24 products across 3 merchants and 4 categories, with specs, badges, ratings, stock, price history
- Product DTO with price, availability, merchant, images, warranty, return window
- Cart: add / update / remove / clear, line limits (20 lines, qty ≤ 10)
- **Soft inventory holds with TTL** — available-to-sell is honest; holds commit atomically at capture
- Guest checkout (flag on) + guest→customer cart merge on sign-in
- Order history with price snapshots

## 3. Money & order lifecycle

- Integer minor-unit USD everywhere; tax `round(subtotal × 8.25%)`; shipping tiers (free ≥ $500, $9.99, $14.99, +$19.99 oversized)
- State machine: `draft → awaiting_payment → payment_processing → paid → processing → shipped → delivered`, plus `cancelled`, `payment_failed`, `expired`, `refunded`
- Quote freezes prices + holds; stale-quote detection (`QUOTE_STALE`) re-prices instead of silently charging

## 4. PayPal payment flow

| Feature | Status | Detail |
|---|---|---|
| Human approval gate | ✅ | Checkout page: "HUMAN APPROVAL REQUIRED" — only a human click starts payment |
| Order create + approve + capture | ✅ | Orders v2 create/capture wired end-to-end (simulator mode) |
| Capture verification | ✅ | Server re-checks amount, currency **and** order id against PayPal before marking paid |
| Failure handling | ✅ | `INSTRUMENT_DECLINED` → safe retry with `actions.restart()`; pending/timeout and cancel paths |
| Attempt limit | ✅ | Max 3 attempts per order, each recorded in `payment_attempts` |
| Idempotency | ✅ | Keys like `pp-create\|pp-capture-<orderId>-<attemptNo>`; replay-safe |
| Webhook verify + dedupe | ✅ coded | Signature verification + `event.id` dedupe (no live events recorded yet) |
| Reconciliation | ✅ | `POST /admin/orders/:orderId/reconcile` fixes "captured but not confirmed" |
| Order status only after confirmed payment | ✅ | Paid requires verified capture — never optimistic |
| Real PayPal sandbox credentials | ⏸ **dormant** | `PAYPAL_MODE=simulator`. Path coded + `npm run paypal:check` drives the real sandbox API |

## 5. Merchant dashboard

- KPIs: paid revenue, orders in flight, active products, conversion
- Discovery funnel (views → cart → checkout → paid) + per-step rates, **monotone by construction**
- AI telemetry: agent recommendations shown, chat messages, agent turns, guardrails
- Daily timeseries sparklines, top products with view→purchase rate
- Payment health: attempts / captured / failed / pending + failure reasons
- Product management: create, edit price, edit stock, archive; category filter
- Orders with payment status + attempt audit; merchants **cannot** mark an order paid

## 6. Platform & API

- **49 REST endpoints** implemented (spec'd minimum was 35)
- Session auth: guest → customer upgrade, register, login, refresh, logout; roles `guest / customer / merchant / admin`
- CSRF guard, per-route rate limits, security headers, PII hashing, no card data stored
- Analytics: 25 typed event names with a PII-rejecting allow-list validator
- Dual store driver: JSON file (default) and Mongo driver
- `/version`, `/readyz`, `/healthz`, `GET /dev/state`
- **17 collections**, 15 design docs, `openapi.yaml` + `agent_tools.json` contracts

## 7. Frontend

- Chat-first storefront with hero, quick-reply chips, streaming tool-progress
- Catalogue rail (all 24 products, searchable, category filter)
- Product cards with real generated art, compare + add-to-cart
- Cart drawer, order list/detail, checkout with live progress timeline
- Dark/light themes, reduced-motion & high-contrast support, responsive to 360px

## 8. Verification

| Suite | Result |
|---|---|
| `dev-up.sh --check` unit + invariants | ✅ 15/15, "All invariants hold" |
| `tests/integration` | ✅ 11/11 |
| `smoke.mjs` | ✅ 24/24 (dirties the store) |
| Ledger invariants | ✅ balance + stock + attempt consistency |
| Browser journey (Chrome 131) | ✅ chat → 4 cards → cart → checkout, zero console/HTTP errors |

---

## Not built yet (honest gaps)

| Gap | Impact |
|---|---|
| `tests/evals/` does not exist | `npm run test:evals` fails — no agent-quality evals |
| `FEATURE_LIVE_LLM=false` | Agent runs the deterministic planner; the live-LLM path exists but is unexercised |
| Real PayPal sandbox run | Never executed with live sandbox credentials — no real `captureId` yet |
| `webhook_events` and `price_history` are empty | Those code paths have never run at runtime |
| No MCP server / PayPal agent-toolkit integration | Planned Tier 1; the "agent can transact" story currently stops at order preparation |
| No hosted deployment URL, no demo video | Both are hard submission requirements |
