# Analytics specification

First-party, privacy-preserving product analytics for the merchant dashboard and platform console.
Implementation: `app/server/domain/analyticsEvents.mjs` (catalogue + validation) and
`app/server/services/analytics.service.mjs` (emit + aggregation).

## Principles

1. Events are facts about completed actions, not intentions.
2. Server events are authoritative. Client events are accepted only for view/impression context and
   are re-attributed to the server session.
3. No PII. Each event has a strict prop allow-list; unknown props are dropped and PII-like keys reject
   the event.
4. Analytics never fails a user request. Emit/ingest errors are logged and swallowed.
5. Every event carries `eventId`, `name`, `ts`, `source`, and optional
   `sessionId`, `userId`, `merchantId`, `productId`, `orderId`, `props`, `dedupeKey`.

## Event catalogue

The runtime catalogue is `EVENT_NAMES` (26 events):

| Event | Typical source | Meaning |
|---|---|---|
| `session_started` | server | Guest session created or user signed in |
| `chat_message_sent` | server | Shopper message persisted |
| `chat_clarification_asked` | server | Agent asked a targeted clarification |
| `requirement_updated` | server | Structured requirement revision changed |
| `recommendation_shown` | server | Product cards emitted; may carry `merchantIds[]` |
| `product_impression` | client | Product card seen |
| `product_viewed` | client/server | Product detail viewed |
| `comparison_shown` | server | Comparison table emitted |
| `cart_item_added` | server | Cart line added |
| `cart_item_removed` | server | Cart line removed |
| `cart_updated` | server | Quantity changed |
| `quote_requested` | server | Checkout quote computed |
| `checkout_started` | server | Draft order + PayPal order created |
| `payment_attempted` | server | Capture attempt began |
| `payment_captured` | server | Verified capture applied; deduped per order |
| `payment_failed` | server | Attempt failed with an allowed reason |
| `payment_pending` | server | Capture returned pending |
| `payment_cancelled` | server | Payer cancelled |
| `payment_settlement_fallback` | server | Split settlement downgraded; reason recorded |
| `order_expired` | server | Hold/order expired before payment |
| `order_cancelled` | server | Order cancelled |
| `order_confirmed_viewed` | client/server | Confirmation viewed |
| `agent_turn_completed` | server | Agent turn finished; profile/iterations/duration |
| `agent_tool_error` | server | Tool returned/throw an error |
| `guardrail_triggered` | server | Refusal/redaction guardrail fired |
| `product_updated` | server | Merchant product mutation or stock change |

Allowed prop shapes live in `EVENT_PROPS`. Examples:

- `cart_item_added`: `productId`, `quantity`, `unitPriceMinor`, `surface`
- `checkout_started`: `orderId`, `orderNumber`, `itemCount`, `totalMinor`, `attemptNo`, `fromSurface`
- `payment_failed`: `orderId`, `attemptNo`, `reason` (enum)
- `payment_settlement_fallback`: `orderId`, `reason`
- `agent_turn_completed`: `toolCalls`, `iterations`, `durationMs`, `stopped`, `profile`

Failure reasons: `INSTRUMENT_DECLINED`, `INSUFFICIENT_FUNDS`, `PAYER_ACTION_REQUIRED`, `CANCELED`,
`NETWORK`, `TIMEOUT`, `VERIFY_MISMATCH`, `STOCK_COMMIT_FAILED`, `ATTEMPT_LIMIT`, `UNKNOWN`.

Surfaces: `agent`, `card`, `grid`, `product_page`, `cart`, `chat`, `landing`, `search`, `checkout`.

## Ingestion

- Server: `analytics.emit(name, context)` validates, dedupes by `dedupeKey` when supplied, inserts.
- Client: `POST /api/v1/analytics/events` accepts a batch. Events are validated, deduped by `eventId`,
  and stamped with the server session/user. Invalid events are dropped, not stored.
- The storefront uses `navigator.sendBeacon`/`fetch` for view events; transactional events are emitted
  by services, not the browser.

## Attribution

- Session identity is the server `sessions._id`, not a client-generated id.
- Merchant attribution comes from the product/order, or from `props.merchantIds` for cross-store
  recommendations. Chat/turn/guardrail events are platform-level and intentionally carry no merchant.
- Guest vs signed-in is captured at event time; dashboards can combine or split.
- Timestamps are stored UTC. Merchant analytics accepts `range=7d|30d|90d` (default 30d).

## Merchant dashboard aggregation

`GET /api/v1/merchant/analytics` returns:

- `funnel`: cumulative **per-session** deepest stage reached:
  - F1 views = sessions that reached `product_viewed`
  - F2 cart adds = sessions that reached `cart_item_added`
  - F3 checkout attempts = sessions that reached `checkout_started`
  - F4 purchases = sessions that reached `payment_captured`
- `rates`: basis-point conversion rates between stages.
- `timeseries`: daily counts for the four funnel events.
- `products`: top products by views with cart/purchase counts and view→purchase rate.
- `paymentHealth`: attempt totals and failure-reason mix.
- `counts`: AI/agent telemetry (recommendations, chat messages, turns, guardrails) with scope label.
- `reconcile.emitViolations`: warns if raw emit counts are non-monotone; never mutates data.

The funnel is monotone by construction: F1 ≥ F2 ≥ F3 ≥ F4. `funnelViolations()` asserts this.

## Privacy & retention

- No IP addresses, emails, names, addresses, phone numbers, tokens or card data are stored on events.
- PII-like prop keys (`email`, `name`, `address`, `phone`, `password`, `payerEmail`, `card`, `token`)
  reject the event.
- No third-party pixels or ad-tech SDKs.
- The reference file store keeps events until reset; it does not yet implement a production TTL for
  analytics. A production deployment should add retention/rollups and an export policy.
- Seeded synthetic analytics makes the demo dashboard non-empty; seeded history is marked `demo:true`
  and uses `SIMH-*` order numbers so it is never mistaken for a live PayPal transaction.

## Admin console

The admin Platform Console reads `/api/v1/admin/overview` for marketplace GMV, platform commission,
seller disbursements and orders needing attention. AG Grid tables support sorting/filtering and
client-side CSV export. Admins can reconcile an order via
`POST /api/v1/admin/orders/:orderId/reconcile`.
