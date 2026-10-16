# ShopPilot AI — Demo Script (≤ 10 minutes, reproducible)

Audience: stakeholders, reviewers, or a new engineer seeing the product for the first time.
Two operators are ideal (one drives the storefront, one drives the merchant dashboard), but one person can do it in two browser windows.

**Before you start (2 minutes, off-camera)**
1. `pnpm seed:reset --demo-orders` → then `pnpm ledger:check` (expect **zero violations**).
2. `pnpm dev` running; `curl -s localhost:4000/readyz` shows `mongo: up`, `paypal: ok`, `llm: fake|ok`.
3. Two browser windows side by side: **Window A** = storefront (`localhost:3000`, signed out), **Window B** = `/merchant` signed in as `merchant@demo.dev`.
4. `ngrok http 4000` running and the sandbox webhook URL pointing at it (only needed for scene 7b).
5. Open `docs/runbooks.md` in a third tab in case PayPal sandbox is slow.

---

## Scene 1 — "It understands the request" (60 s)

**Window A.** Land on `/`. Type (do not paste silently — let the audience read it):

> I need a laptop for full-stack development under $900, with at least 16 GB RAM, a 512 GB SSD, and good battery life.

**Say:** "No filters, no facets — the customer states the job to be done."

**Expected within ~2 s:** a requirement bar of editable chips (`Laptop` · `≤ $900` · `RAM ≥ 16 GB` · `SSD ≥ 512 GB`), a `Searching the catalogue` activity row, then **4 real products** with prices from MongoDB:

| Product | Price | RAM / SSD | Note |
|---|---|---|---|
Ascent Book 14 Pro | $879.00 | 16 GB / 512 GB | 11 h battery, price-drop badge |
Ascent Book 14 | $729.00 | 16 GB / 512 GB | upgradeable RAM |
NovaBook Air 13 | $649.00 | 16 GB / 512 GB | 1.18 kg |
NovaBook Studio 15 | $899.00 | 32 GB / 1 TB | most machine per dollar |

**Point out:** every number came from the database; each card has a `Why it fits`, two or more pros and at least one honest con; nothing over $900 or under 16 GB appears (the two over-budget laptops in the catalogue are excluded).

---

## Scene 2 — "Clarification without friction" (45 s)

Open a fresh tab (or clear the conversation) and type:

> I need a good laptop

**Say:** "It asks one useful question, not twenty."

**Expected:** a single clarification about budget with quick replies (`< $500`, `$500–$900`, `$900–$1,500`, `No limit`). Click `$500–$900`.
**Expected:** results in that band; if any filter was relaxed the agent says exactly what it relaxed.

---

## Scene 3 — "Comparison and grounded follow-ups" (75 s)

Back in the scene-1 conversation:

> Compare the top two

**Expected:** a comparison table over real attributes (price, RAM, storage, battery Wh, weight, processor, warranty), with the winner marked by text and a dot — not colour alone.

Then ask a question the catalogue cannot answer:

> Does the cheaper one have a 2 TB SSD option?

**Expected:** a grounded answer about the actual storage, plus "I don't have that information" for what is not in the data. It must **not** invent an option.

---

## Scene 4 — "Requirements change, results change" (45 s)

> Actually make it under $700 and lighter than 1.4 kg

**Expected:** the previous cards are marked **Superseded**, the requirement bar shows `revision 2` with the new chips, and the new results are all ≤ $700 and ≤ 1.4 kg (Ascent Book 14 $729 and Studio 15 $899 drop out; NovaBook Air 13 1.18 kg and — if still eligible — others remain). If the set becomes thin, the agent says which constraint it relaxed.

**Say:** "The requirement is a first-class object with revisions, so old results can never be mistaken for current ones."

---

## Scene 5 — "Cart with real stock discipline" (45 s)

> Add 2 of the NovaBook Air 13 to my cart

**Expected:** the cart rail/drawer updates, badge pops, `cart.updated` refreshes the totals from the server.
Then use the quantity stepper to push to 10+ and let it clamp, and try to exceed stock.

**Say:** "Quantities are capped by live stock server-side; the client cannot push past it."

---

## Scene 6 — "Checkout is a decision, not a charge" (75 s)

Click **Checkout** (or say *"checkout"* to the agent).

**Expected on `/checkout/{orderId}`:** itemised summary, merchant names, **Subtotal → Shipping → Tax (8.25 %) → Total**, a 15-minute hold countdown, and the button reading **`Approve & Pay $…`** with the caption "You'll review and authorise the payment in PayPal. No charge happens before you approve."

Try the agent here (this is the trust moment):

> Just pay for it for me

**Expected:** the agent declines to pay autonomously and explains the approval step. Prove the mechanism: there is **no payment tool** in the agent's registry (`contracts/agent_tools.json` → `forbiddenTools`).

---

## Scene 7a — "Successful payment" (90 s)

Enter an email, click **Approve & Pay**, and complete the PayPal sandbox flow as the personal test buyer.

**Expected:** `Confirming your payment with PayPal. Do not close this page.` → redirect to `/orders/{id}/confirmation` with:
* `status: paid`, order number `SP-2026-…`, capture id (copyable),
* items with quantities, subtotal/shipping/tax/total, merchant block, payment method,
* and in Window B (refresh `/merchant/orders`): the order appears as **paid** with its payment attempt timeline and a verified amount.

**Say:** "The order only became paid after the backend verified the capture's status, amount and currency against our own total."

## Scene 7b — (optional) "The webhook safety net" (30 s)

Show `db.webhook_events` with `signatureVerified: true` and `processingResult: "applied"`.
**Say:** "If our synchronous write had failed, this verified event or the reconciliation job would still have marked the order paid — PayPal's record is the source of truth, ours is never trusted over it."

---

## Scene 8 — "Failure is a designed state" (90 s)

Second order, same flow, but use the **declined** sandbox buyer (or enable PayPal negative testing).

**Expected:** the payment panel shows a danger alert with a plain-language reason, the explicit reassurance **"No money has left your account and your cart is unchanged."**, and two safe actions: **Try again** and **Back to cart**. The merchant dashboard shows the order as `payment_failed` with the failure reason — never `paid`.

Then click **Try again**, complete with the good buyer, and show:
* the same order ends `paid`,
* `db.payment_attempts` has **two** attempts (one failed, one succeeded), and
* exactly **one** capture id, one order number, one charge.

**Say:** "Retry creates a new attempt, not a new order — and duplicate approvals collapse into a single capture."

---

## Scene 9 — "Merchant control closes the loop" (60 s)

**Window B → `/merchant/products`.** Set `Ascent Book 14 Pro` price to `$899.00` and stock to `0` (or 2), save, and show the price-history entry.

**Back in Window A:** ask *"Is the Ascent Book 14 Pro still available?"*
**Expected:** the agent reports the **new** price/stock honestly — "the price changed from $879.00 to $899.00" and, at zero stock, "out of stock" plus close alternatives. It never recommends an unavailable item.

Then **`/merchant/analytics`**: the funnel (views → cart adds → checkout attempts → purchases) and the payment-health panel now include everything just demonstrated. Point at the definitions footnote.

---

## Scene 10 — "Where the money rules live" (30 s, optional for technical audiences)

Open `docs/payments_paypal.md` §4 on screen and read the V1–V7 verification list; then show the closing slide:

* The agent cannot move money — no such tool exists.
* `paid` is written in exactly one function, after amount and currency verification.
* Every money mutation is idempotent (client key + deterministic PayPal request id + per-order lock).
* Guests can shop end-to-end; signing in merges their cart and keeps their orders.
* Every number on screen is traceable to a database row.

---

## Recovery lines (if something goes wrong live)

| What breaks | What to say | What to do |
|---|---|---|
PayPal sandbox is slow | "This is the sandbox, it queues sometimes — the order is safely in `payment_processing`." | Wait, or run `pnpm job:reconcile` and refresh |
Webhook not arriving | "Webhooks are the safety net; our synchronous capture already confirmed this one." | Continue; show `webhook_events` later |
LLM provider hiccup | "Let me show the same flow on our deterministic model so the demo is stable." | `FEATURE_LIVE_LLM=false` + restart |
Rate limit hit | "That's our abuse protection doing its job." | Raise the `RATE_*` env var, restart (RB-6) |
Product out of stock mid-demo | "Good — this is the case most demos hide. Watch how it's handled." | Let the `ITEM_UNAVAILABLE` flow play out |
Something is genuinely broken | "Let me reset to a known-good state." | `pnpm seed:reset --demo-orders`, restart, resume at scene 1 |

---

## Timing sheet

| Scene | Target | Cumulative |
|---|---|---|
1 Understands the request | 1:00 | 1:00
2 Clarification | 0:45 | 1:45
3 Comparison + grounded Q&A | 1:15 | 3:00
4 Requirement change | 0:45 | 3:45
5 Cart discipline | 0:45 | 4:30
6 Checkout approval | 1:15 | 5:45
7 Payment success (+webhook) | 2:00 | 7:45
8 Failure + retry | 1:30 | 9:15
9 Merchant control | 1:00 | 10:15
10 Money rules (optional) | 0:30 | —

If you must cut: drop scene 2 and scene 10 first, never scene 6, 7 or 8.

---

## Closing summary (the one paragraph to leave on screen)

> ShopPilot AI takes a customer from "here's what I need" to a paid, verified order in one conversation. The AI does the understanding and the explaining; the backend does the pricing, stock, orders and payments — with the language model deliberately incapable of moving money. Every claim on screen comes from the database, every payment is verified against PayPal's own record, and every failure lands in a designed state with a safe way forward.
