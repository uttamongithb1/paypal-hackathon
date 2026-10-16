# ShopPilot AI — Runbooks

Short, executable procedures for the situations that actually happen during a demo or a support call. Each runbook states the symptom, the check, the fix, and the verification.

---

## RB-1 — Order stuck in `payment_processing`

**Symptom:** the customer sees "Confirming your payment with PayPal…" for more than ~2 minutes; the merchant dashboard shows a payment attempt without a final status.

**Why it happens:** the capture response was lost (network/timeout), or the webhook did not arrive (tunnel down, wrong `PAYPAL_WEBHOOK_ID`).

**Steps**
1. Find the order: `mongosh "$MONGODB_URI" --eval 'db.orders.find({status:"payment_processing"},{orderNumber:1,"payment":1}).pretty()'`
2. Check what PayPal thinks:
   ```bash
   curl -s -X POST https://api-m.sandbox.paypal.com/v1/oauth2/token \
     -u "$PAYPAL_CLIENT_ID:$PAYPAL_CLIENT_SECRET" -d 'grant_type=client_credentials' | jq -r .access_token
   curl -s https://api-m.sandbox.paypal.com/v2/checkout/orders/<paypalOrderId> \
     -H "Authorization: Bearer <token>" | jq '{status, purchase_units: [.purchase_units[].payments]}'
   ```
3. Run reconciliation: `pnpm job:reconcile` (or `POST /api/v1/admin/orders/{orderId}/reconcile` as admin).
4. Inspect `webhook_events` for that order to see whether PayPal tried to notify us:
   `db.webhook_events.find({"payload.resource.custom_id":"SP-2026-000123"}).sort({receivedAt:-1}).limit(3)`

**Expected outcomes**
* PayPal `COMPLETED` → order becomes `paid`, stock committed, receipt email/log emitted.
* PayPal `VOIDED`/404 → order becomes `payment_failed`, holds released, customer offered **Retry payment**.
* PayPal still `APPROVED` → safe to capture again from the checkout page: `POST /payments/{orderId}/capture` with the same `paypalOrderId` (idempotent).

**Never** hand-edit `order.status` to `paid` in Mongo. If you must unblock a demo, use the admin reconcile endpoint so the capture id and verification flags are written correctly.

---

## RB-2 — Webhook signature failures flood the log

**Symptom:** `webhook_signature_invalid` lines; orders relying on webhooks stay pending.

**Checks**
1. The tunnel URL changed (ngrok restarts frequently). Compare the URL registered in the PayPal sandbox app with `curl -s localhost:4040/api/tunnels | jq`.
2. `PAYPAL_WEBHOOK_ID` must be the id of **that** webhook registration, not the app id.
3. Clock skew > 3 minutes breaks `paypal-transmission-time` validation.

**Fix**
1. `ngrok http 4000` → copy the new HTTPS URL.
2. Sandbox app → Webhooks → update the URL → copy the new Webhook ID → update `.env` → restart the API.
3. Replay the missed window: `pnpm job:replay-webhooks --since=2h`.
4. Verify: perform one sandbox payment; expect `webhook_events` rows with `signatureVerified: true` and `processingResult: "applied"`.

---

## RB-3 — Duplicate capture / "ORDER_ALREADY_CAPTURED"

**Symptom:** a customer (or a test) sees an error after paying, or support suspects a double charge.

**Checks**
1. `db.orders.find({"payment.paypalCaptureId":"<captureId>"})` — exactly one order must own a capture id (unique index enforces this).
2. `db.payment_attempts.find({orderId})` — expect one `succeeded` attempt; extra attempts must be `failed`/`cancelled`, never `succeeded`.
3. Check PayPal for the capture id in the sandbox dashboard (Activity) and confirm it appears once.

**Fix / interpretation**
* If our DB is missing the capture but PayPal has it → `pnpm job:reconcile` applies `paid` from PayPal's record (PayPal is the source of truth).
* If **two** different orders share a capture id (should be impossible) → P1: stop checkout (`FEATURE_CHECKOUT=false`), collect the requestIds, and escalate per `security_privacy.md` §11.
* Customer-facing: a duplicate attempt on the same order is a **no-op replay** (`Idempotent-Replay: true`), so the customer is shown the paid order, not an error.

**Preventive check:** `pnpm test:integration -- captureIdempotentReplay concurrentCapture doubleClickApprove`

---

## RB-4 — Payment verified but stock could not be committed

**Symptom:** attempt `succeeded`, order `payment_failed` with `failureReason: "STOCK_COMMIT_FAILED"`, alert fired.

**Why:** another buyer took the last unit between hold creation and capture (hold expired, or an over-sell path).

**Steps**
1. Confirm the capture exists in PayPal and the amount matches.
2. Set order to a clearly non-fulfillable state: `payment_failed` + `timeline` note (already written by the service).
3. Refund the customer (admin): `POST /admin/orders/{orderId}/refund` — reason "item unavailable".
4. Email an apology with alternatives (`docs/demo_script.md` §6 has the template language).
5. Post-mortem: check `inventory_holds` for the order; if the hold was `released` early, inspect the expiry job logs.

**Preventive:** the hold TTL (15 min) must exceed typical PayPal approval time; if demos regularly take longer, raise `QUOTE_TTL_MINUTES` deliberately and re-run the oversell test.

---

## RB-5 — Merchant set stock to 0 with active carts/holds

**Symptom:** checkout failures with `ITEM_UNAVAILABLE`; customer confusion.

**Behaviour is intentional:** active holds are honoured until they expire (the merchant is told this in the UI copy: "3 units are reserved by shoppers for up to 15 minutes"). New quotes exclude the product.

**Steps**
1. Let the holds expire naturally, or force it for a demo: `db.inventory_holds.updateMany({productId: ObjectId("…"), status:"active"}, {$set:{expiresAt:new Date()}})` then `pnpm job:release-holds`.
2. Customers with unpaid orders see the item struck through and removed from the total; no charge was made for it.
3. If a demo needs the product back immediately, set `stock` to a positive value in `/merchant/products`.

---

## RB-6 — Rate limits blocking a live demo

**Symptom:** `429 RATE_LIMITED` during a demo when several people use one IP or one session.

**Fix (temporary):** set `RATE_CHAT=200/5m`, `RATE_CHECKOUT=50/5m`, `RATE_GLOBAL=2000/1m` in `.env`, restart the API. Announce it: rate limits are a security control — restore them after the demo and note it in the daily log.

---

## RB-7 — LLM provider outage / cost spike

**Symptom:** chat turns fail with `LLM_UNAVAILABLE`, or token counters jump.

**Fix**
1. Flip to the deterministic model for the demo: `FEATURE_LIVE_LLM=false` → restart → the fake client replays scripted turns so the shopping flow keeps working (catalogue, cart and checkout are unaffected either way).
2. If staying live: check the provider status page, confirm `LLM_MODEL` and `LLM_BASE_URL`, lower `AGENT_MAX_TOKENS_PER_TURN`, and watch `agent_turn_completed` logs for `iterations` > 4 (a sign the prompt or tool schemas need attention).
3. Record the incident in `docs/decisions.md` if a prompt or tool change follows.

---

## RB-8 — Reset the demo environment

```bash
pnpm seed:reset --demo-orders        # drops, reseeds 24 products, 3 merchants, demo users, demo orders, synthetic analytics
pnpm ledger:check                    # must print zero violations
pnpm demo                            # prints the rehearsal script with current sandbox buyers
```
Then open `/merchant/analytics` and confirm the funnel reads 1 840 / 312 / 96 / 41, and `/orders` shows the seeded paid order.

---

## RB-9 — Restore from backup

```bash
mongorestore --uri="$MONGODB_URI" --archive=demo-2026-10-16.archive --drop
pnpm db:indexes     # ensure indexes/TTLs exist after a restore
pnpm ledger:check
```
Note: TTL indexes only delete on the primary's monitor cycle (~60 s), so freshly restored expired documents may linger briefly — this is expected.

---

## RB-10 — Secret rotation

1. **PayPal client secret:** sandbox app → rotate → update `PAYPAL_CLIENT_SECRET` → restart API → `curl /readyz` (expect `paypal: ok`) → run one sandbox purchase.
2. **JWT secret:** add the new secret as `JWT_SECRET_NEXT`, set `JWT_SECRET_ROTATION=true` (verifies both, signs with next), wait one access-token TTL (15 min), promote next → current, restart, disable rotation. Refresh tokens remain valid because they are stored hashed in the DB, not derived from the JWT secret.
3. **`PII_HASH_PEPPER`:** changing it invalidates `payerEmailHash` correlation. Re-hash from `payment_attempts.responseSnapshot` if correlation matters; otherwise rotate and note the cut-off date in `docs/decisions.md`.

---

## Escalation matrix

| Situation | Severity | Who | First action |
|---|---|---|---|
Order marked `paid` without a capture id | P1 | Eng lead | Stop checkout, reconcile, preserve logs |
Two orders sharing a capture id | P1 | Eng lead + PayPal support | Freeze payments, export `payment_attempts` |
Webhook signature failures | P2 | On-call | Fix tunnel/webhook id, replay events |
Payment failure rate > 15 % | P2 | On-call | Inspect `payment_failed` reasons, check sandbox buyers |
LLM circuit open | P3 | On-call | Switch to fake client, open a ticket |
Analytics gaps | P3 | On-call | Check emit logs; analytics never blocks checkout |
