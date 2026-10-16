# ShopPilot AI — Analytics Specification

Owner: platform. Storage: `analytics_events` (see `docs/data_model.md` §2.13). Purpose: (a) power the merchant dashboard, (b) prove the funnel to stakeholders, (c) provide the agent/ops telemetry that is not user-facing.

**Principles**
1. Events are **facts about completed actions**, never intentions ("checkout_attempted" means a PayPal order was created, not that a page rendered).
2. Server events are authoritative; client events are for context (views, impressions) and are always re-attributed server-side using the session/model.
3. No PII in any event (PRD FR-8.4). `props` is validated against a per-event allow-list; unknown props are dropped, not stored.
4. Fire-and-forget: analytics must never fail a user request (bounded queue, `insertMany({ordered:false})`, errors logged).
5. Every event carries `eventId` (uuid v7), `ts`, `source ∈ {client, server}`, and, when applicable, `sessionId`, `userId`, `merchantId`, `productId`, `orderId`.

---

## 1. Event catalogue

| Event | Source | When (exact trigger) | Required props | Optional props |
|---|---|---|---|---|
`session_started` | server | guest session created or user signs in | `role` (`guest`/`customer`) | `userAgentFamily`, `referrer` (domain only)
`chat_message_sent` | server | user message persisted | `turnIndex`, `textLength` | `hasAttachments`, `entryPoint` (`landing`/`chat`/`product`)
`chat_clarification_asked` | server | `clarification` component emitted | `questionKind` (`budget`/`category`/`use_case`/`size`) | `optionsCount`
`requirement_updated` | server | revision bumped | `revision`, `changeKinds[]` (`budget`/`attribute_added`/`attribute_removed`/`category`) | —
`recommendation_shown` | server | `product_cards` emitted | `productCount`, `revision` | `relaxed[]`, `minPriceMinor`, `maxPriceMinor`
`product_impression` | client | ≥ 50 % of a card visible for ≥ 1 s (IntersectionObserver) | `productId`, `surface` (`chat_cards`/`chat_rail`/`grid`/`comparison`) | `position`
`product_viewed` | client (server-validated) | product detail page loaded (once per session/product/hour via `dedupeKey`) | `productId`, `surface` (`product_page`/`chat_link`/`search`) | `referrerSurface`
`comparison_shown` | server | `comparison` component emitted | `productIds[]` | `winnerProductId`
`alternative_suggested` | server | out-of-stock fallback rendered | `unavailableProductId`, `suggestedProductIds[]` | `reason`
`cart_item_added` | both (server authoritative) | cart mutation succeeded | `productId`, `quantity`, `unitPriceMinor`, `surface` (`agent`/`card`/`product_page`/`cart`) | `replacedExisting`
`cart_item_removed` | server | line removed | `productId`, `quantity`, `surface` | `reason` (`user`/`agent`/`unavailable`)
`cart_updated` | server | quantity change | `productId`, `fromQuantity`, `toQuantity` | `surface`
`quote_requested` | server | `POST /checkout/quote` succeeded | `itemCount`, `totalMinor` | `warnings[]`
`checkout_started` | server | `POST /orders` succeeded (PayPal order created) | `orderId`, `orderNumber`, `itemCount`, `totalMinor`, `attemptNo` | `fromSurface` (`chat`/`cart`)
`payment_attempted` | server | PayPal create-or-capture attempt begins | `orderId`, `attemptNo`, `amountMinor` | `currency`
`payment_captured` | server | verified capture applied | `orderId`, `amountMinor`, `captureIdSuffix` (last 6) | `fundingSourceCategory` if returned
`payment_failed` | server | attempt fails | `orderId`, `attemptNo`, `reason` (enum in §4) | `paypalDebugId`
`payment_pending` | server | capture returns `PENDING` | `orderId`, `attemptNo` | `instrumentType`
`payment_cancelled` | server | payer cancelled | `orderId`, `attemptNo` | —
`order_expired` | server | hold expired before payment | `orderId`, `itemCount` | —
`order_confirmed_viewed` | client | confirmation page loaded | `orderId`, `status` | —
`order_history_viewed` | client | `/orders` loaded | `count` | `role`
`order_cancelled` | server | user/admin cancel | `orderId`, `previousStatus` | `actorRole`
`product_created` / `product_updated` / `product_archived` | server | merchant mutation | `productId`, `changedFields[]` | `priceFromMinor`, `priceToMinor`, `stockFrom`, `stockTo`
`merchant_login` | server | merchant signs in | `merchantId` | —
`analytics_viewed` | client | merchant analytics page | `range` | —
`agent_turn_completed` | server | turn end | `toolCalls`, `iterations`, `durationMs`, `tokensIn`, `tokensOut` | `stopped`, `profile` (`live`/`fake`)
`agent_tool_error` | server | tool throws/returns error | `tool`, `errorCode`, `durationMs` | `retryable`
`guardrail_triggered` | server | refusal/redaction | `kind` (`off_topic`/`pii_detected`/`injection_suspected`/`budget_refusal`) | `snippetHash`

Delivery: client events POST in batches of ≤ 20, `sendBeacon` on `visibilitychange`, `fetch(keepalive)` otherwise; server events are emitted inline but written via a queue that flushes asynchronously.

---

## 2. Attribution rules

| Question | Rule |
|---|---|
Defining a "session" | `sessions._id` (cookie `sid`), not a client-generated id. Sign-in keeps the same session id (upgrade), so funnels do not break at login. |
Merchant attribution | `merchantId` is taken from the **product/order**, never from the referrer. Chat-only events (e.g. `recommendation_shown`) carry no `merchantId` unless all shown products share one. |
Product identity | always `productId`; `slug` and `title` are denormalised into `props` only for display in exports. |
Guest vs customer | `props.role` at event time; dashboards can split but default to combined. |
Bot filtering | requests with `User-Agent` matching `/bot|crawler|spider|headless/i` are dropped for `product_viewed`/`impression` and flagged in `props.isSynthetic`. |
Deduplication | `product_viewed` once per (`sessionId`,`productId`) per hour via `dedupeKey = view:{sessionId}:{productId}:{YYYYMMDDHH}` (partial unique index; duplicates are ignored by the insert). |
Time zone | stored UTC; dashboards aggregate in `ANALYTICS_TZ` (default `Asia/Kolkata` for the demo) with the boundary shown in the UI footnote. |

---

## 3. Funnel definition (merchant dashboard)

```
F1 product views        = count(distinct (sessionId, productId)) for product_viewed
F2 cart additions       = count(distinct (sessionId, productId)) for cart_item_added
F3 checkout attempts    = count(distinct orderId) for checkout_started
F4 completed purchases  = count(distinct orderId) for payment_captured
```
Rates:
* `view→cart` = F2 / F1
* `cart→checkout` = F3 / F2
* `checkout→paid` = F4 / F3
* `view→purchase` = F4 / F1
* `order conversion` = paid orders / checkout attempts

Additional merchant KPIs: Revenue (Σ `paid` order totals in range, per currency), AOV (revenue / paid orders), refund rate, payment failure rate = `payment_failed` / `payment_attempted`, median time-to-pay (from `checkout_started` to `payment_captured`, p50), low-stock count (`stock ≤ 3` and `status: active`), out-of-stock views (`product_viewed` on a product with `stock = 0` — a missed-sales signal).

Aggregation strategy: for ranges ≤ 30 days use a Mongo aggregation over `analytics_events` with `$match {name, ts, merchantId}` + `$group` on a date bucket; for range > 30 days read a nightly rollup collection `analytics_daily` (`{ date, merchantId, name, count, uniqueSessions, revenueMinor }`). The dashboard must show a "Definitions" disclosure linking to §1–§3 so numbers are auditable.

---

## 4. Enumerations (must match `packages/shared/src/analytics.ts`)

```ts
export const PAYMENT_FAILURE_REASONS = [
  'INSTRUMENT_DECLINED','INSUFFICIENT_FUNDS','PAYER_ACTION_REQUIRED','CANCELED',
  'NETWORK','TIMEOUT','VERIFY_MISMATCH','STOCK_COMMIT_FAILED','ATTEMPT_LIMIT','UNKNOWN'
] as const;

export const SURFACES = ['agent','card','grid','product_page','cart','chat','landing','search'] as const;
export const CHAT_ENTRY_POINTS = ['landing','chat','product'] as const;
export const CLARIFICATION_KINDS = ['budget','category','use_case','size'] as const;
```

Property validation example (shared zod):
```ts
cart_item_added: z.object({
  productId: z.string().length(24), quantity: z.number().int().min(1).max(10),
  unitPriceMinor: z.number().int().min(0), surface: z.enum(SURFACES),
  replacedExisting: z.boolean().optional(),
}).strict()
```
A `.strict()` schema per event is the enforcement mechanism for "no PII": any extra key fails validation and the event is dropped with a `analytics_event_rejected` counter (not an exception).

---

## 5. Retention, privacy, and ethics

* Retention: raw events 180 days (TTL), daily rollups 3 years.
* No IP addresses stored on events; `sessionId` is a server id and `ipHash` (salted, truncated) lives only on `sessions` for abuse prevention.
* No cross-site tracking, no third-party pixels, no ad-tech SDKs. Client events are first-party only.
* Merchant dashboards show **aggregates only** — no individual session timelines, no chat transcripts of customers (transcripts are visible only to the owning user; the platform admin can access them solely for abuse investigation, logged in `admin_audit`).
* Export: `GET /merchant/analytics/export?range=&format=csv` (documented for later; v1 ships chart + numbers, not CSV).
* Do-not-track: if `navigator.doNotTrack === '1'` or the user is `props.isSynthetic`, client events are suppressed (server events, being transactional, still record).

---

## 6. Dashboards & queries (implementation notes for the agent)

Merchant `/merchant` overview tiles (range default 30d):
```js
// revenue + paid orders
db.orders.aggregate([
  { $match: { status: 'paid', merchantIds: merchantId, paidAt: { $gte: from, $lte: to } } },
  { $group: { _id: null, revenueMinor: { $sum: '$amounts.totalMinor' }, orders: { $sum: 1 } } }
])
// funnel counts (one query per event name, or one $facet)
db.analytics_events.aggregate([
  { $match: { name: { $in: ['product_viewed','cart_item_added','checkout_started','payment_captured'] },
              ts: { $gte: from }, merchantId: merchantId } },
  { $group: { _id: '$name', count: { $sum: 1 }, sessions: { $addToSet: '$sessionId' } } }
])
// timeseries (7d/30d)
... plus { $group: { _id: { d: { $dateToString: { format: '%Y-%m-%d', date: '$ts', timezone: tz } }, name: '$name' }, c: { $sum: 1 } } }
```
Performance: always constrain by `ts` and `merchantId` to hit `{ merchantId: 1, name: 1, ts: -1 }`; cap `$facet` results; cache dashboard responses in-process for 60 s keyed by `(merchantId, range, tz)`.

---

## 7. Testing & reconciliation

* Each emit site has a test asserting **exactly one** event per action (no double-fires on retry: server emitters are idempotent via `dedupeKey` where retries are possible, e.g. `checkout_started:{orderId}`).
* Aggregation functions are unit-tested against a synthetic fixture set (10 sessions, known funnel) where the expected numbers are hand-computed in the test file.
* Nightly sanity check: `F1 ≥ F2 ≥ F3 ≥ F4` for every merchant over the last 7 days; violations log a warning (indicates an emit-site bug), never mutate data.
* The seed script generates deterministic events so the demo dashboard shows a plausible funnel: views 1 840 / cart adds 312 / checkout attempts 96 / purchases 41 (with 7 failures) across 30 days.
