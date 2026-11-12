# Runbooks

Operational procedures for the shipped Express + file-store build. Commands assume `cd app` unless
noted. The default local mode is the PayPal simulator; the hosted demo uses PayPal sandbox.

## RB-1 — Order stuck in `payment_processing`

**Symptom:** checkout says “Confirming your payment…” for more than a couple of minutes.

1. Find the order in the admin console (`/admin`) or inspect the store:
   ```bash
   node -e "const d=require('./.data/db.json').data; console.log(d.orders.filter(o=>o.status==='payment_processing').map(o=>({id:o._id,n:o.orderNumber,p:o.payment})))"
   ```
2. Check PayPal sandbox activity for the PayPal order id / capture id.
3. Reconcile as admin:
   ```http
   POST /api/v1/admin/orders/{orderId}/reconcile
   ```
   or use the **Reconcile** action in the Platform Console.
4. Inspect webhook events:
   ```bash
   node -e "const d=require('./.data/db.json').data; console.log(d.webhook_events.slice(-10))"
   ```

**Outcomes:** PayPal completed + verification passes → paid. Voided/missing → failed/expired and holds
released. Still approved → capture can be retried safely. Never hand-edit `status` to `paid`.

## RB-2 — Webhook signature failures / missing headers

**Symptom:** `webhook_signature_invalid`, `webhook_unverified`, or events stored with
`signatureVerified:false`.

Checks:

- `PAYPAL_WEBHOOK_ID` matches the webhook registration, not the REST app client id.
- The registered URL is the current HTTPS origin + `/api/v1/webhooks/paypal`.
- Local tunnels change URL; update both the URL and webhook id after restarting a tunnel.
- Clock skew and missing PayPal transmission headers cause unverified events.

Fix: update the sandbox webhook registration and env, restart, then make one sandbox purchase.
Missing/invalid events are answered 200 and never applied; reconciliation is the backstop.

## RB-3 — Duplicate capture / `ORDER_ALREADY_CAPTURED` / `DUPLICATE_INVOICE_ID`

**Symptom:** shopper sees “already paid — confirming”, or support suspects a double charge.

1. Confirm exactly one order owns the capture id:
   ```bash
   node -e "const d=require('./.data/db.json').data; const id=process.argv[1]; console.log(d.orders.filter(o=>o.payment?.paypalCaptureId===id || (o.payment?.captures||[]).some(c=>c.id===id)).map(o=>o.orderNumber))" <captureId>
   ```
2. Check `payment_attempts` for the order: one succeeded attempt; duplicates should be unknown/failed,
   never a second succeeded capture.
3. Reconcile the order as admin. `DUPLICATE_INVOICE_ID` is treated as “a prior attempt may already
   have captured”, not as a normal payment failure.

Invoice ids include the internal order id, so reseeding an ephemeral store does not reuse a previously
captured PayPal invoice.

## RB-4 — Payment verified but stock could not be committed

**Symptom:** attempt succeeded/capture exists, order `payment_failed` with
`failureReason: STOCK_COMMIT_FAILED`.

1. Confirm the capture in PayPal and the order timeline.
2. Refund through the merchant/admin refund flow (never mark paid manually).
3. Tell the shopper the item sold out after payment and a refund is being issued.
4. Investigate inventory holds and expiry; raise `QUOTE_TTL_MINUTES` only deliberately if approvals
   routinely exceed the hold window.

## RB-5 — Merchant set stock to 0 with active carts/holds

Active holds are honoured until expiry. New quotes exclude unavailable products. To clear a demo
hold, let it expire or reset the local store. Restoring positive stock in the merchant dashboard makes
the product purchasable again for new quotes.

## RB-6 — Rate limits blocking a demo

**Symptom:** `429 RATE_LIMITED`.

Temporarily raise the relevant limits and restart:

```dotenv
RATE_CHAT=200/5m
RATE_CHECKOUT=50/5m
RATE_PAYMENT=50/5m
RATE_GLOBAL=2000/1m
```

Restore normal limits after the demo. Rate limits are a security control, not a bug.

## RB-7 — LLM provider outage / quota / cost spike

**Symptom:** live turns fail, 429 from the provider, or fallback labels appear.

1. For a guaranteed demo, set `FEATURE_LIVE_LLM=false` and restart. The deterministic planner uses the
   same tools and checkout path.
2. If staying live, check `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, provider status and quota.
3. Watch `agent_turn_completed` logs/events for iterations, duration and profile.
4. The UI labels fallback turns; never present a deterministic turn as live AI.

## RB-8 — Reset the local demo environment

```bash
npm run reset          # clean store + catalogue + demo users + synthetic history/analytics
npm run ledger         # must report zero invariant violations
npm run verify         # full test + invariant + test-count gate
```

Then open `/merchant` and `/admin` to confirm the dashboards are populated. Hosted Render instances
with `SEED_ON_BOOT=true` reseed automatically when the store is empty.

## RB-9 — Backup / restore the file store

The reference store is `app/.data/db.json` (override with `DATA_DIR`).

```bash
# backup (stop the server or use a quiet moment for a consistent copy)
cp .data/db.json ../db-backup-$(date +%F).json

# restore
cp ../db-backup-YYYY-MM-DD.json .data/db.json
npm run ledger
```

Do not restore a backup over a live multi-instance deployment; this build assumes a single writer.
For durable production data, implement the reserved database driver and shared locks.

## RB-10 — Secret rotation

1. **PayPal client secret:** rotate in the sandbox app, update `PAYPAL_CLIENT_SECRET`, restart, check
   `/api/v1/readyz`, then run `npm run paypal:check`.
2. **JWT secret:** update `JWT_SECRET` and restart. Existing access tokens become invalid; users sign
   in again. Refresh tokens are stored hashed and are not derived from the JWT secret.
3. **PII pepper:** rotating `PII_HASH_PEPPER` breaks correlation with previously hashed payer emails.
   Rotate only with a documented cut-over; do not attempt to recover raw emails from hashes.
4. **LLM key:** rotate at the provider, update `LLM_API_KEY`, restart, verify `/api/v1/version` and a
   live chat turn.

Never commit `.env`, tokens, buyer passwords or logs. Rotate any credential pasted into chat/issues.

## Escalation matrix

| Situation | Severity | First action |
|---|---|---|
| Order marked paid without a capture id | P1 | Stop checkout, reconcile, preserve logs |
| Two orders sharing a capture id | P1 | Freeze payments, export attempts, escalate |
| Webhook signature failures | P2 | Fix webhook id/URL, reconcile affected orders |
| Payment failure rate spike | P2 | Inspect failure reasons and sandbox buyer state |
| LLM circuit open / quota exhausted | P3 | Switch to deterministic planner |
| Analytics gaps | P3 | Check emit logs; analytics never blocks checkout |
