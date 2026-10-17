# ShopPilot AI — Win Plan (v3)

**Target:** [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) · **Deadline:** Nov 12, 2026, 12:00pm PT = **Nov 13, 01:30 IST**
**Judging:** Dec 1–15 · **Winners:** ~Dec 21 · **Today:** Oct 17, 2026 → **26 days left**

> v2 was written when the LLM did not exist and PayPal had never been called. Both are now real.
> This version is grounded in a full audit of the deployed site run on Oct 17, 2026. Every claim
> below has a probe behind it.

---

## 0. The scoreboard, honestly

| Criterion | Weight | Now | Why |
|---|---|---|---|
| **Technological Implementation** *(tiebreaker)* | 20% | **8.5** | Real sandbox order IDs, 14 agent tools, split settlement with a fallback ladder, grounding guardrail, idempotency, 78 tests, 49 endpoints. One link missing: no completed real capture yet. |
| Design | 20% | **7.5** | Coherent Ledger theme across every view, light+dark. Spoiled by empty dashboards and a funnel that contradicts them. |
| Potential Impact | 20% | **6.0** | The argument is implied, never made. No named user, no numbers. |
| Innovation / Idea | 20% | **7.5** | Multi-merchant split with human-approved spend is genuinely novel. It is not the headline. |
| Presentation | 20% | **5.0** | No video exists. That is the entire criterion, worth 20%. |

**≈ 7.6 / 10 after the Oct 17 build pass** (up from 6.9 measured that morning):
Design 7.5 → **8.5** (header fixed at every width, dashboards now reconcile, gate no longer empty),
Technological Implementation 8.5 → **9.0** (`/how-it-works` makes the depth visible).
Presentation is still **5.0** — the video does not exist. That remains the largest single gap, and
it is a recording task, not an engineering one.

---

## 1. What is verified working (Oct 17, 2026)

| Probe | Result |
|---|---|
| Live AI turn | `profile: live`, 2,726 ms, `search_products` running→done, `product_cards` returned |
| Model | `openai/gpt-oss-120b` via Groq, `/diagnostics/llm` → `ok:true, modelAvailable:true` |
| **Live PayPal order** | `POST /api/v1/orders` → `SP-2026-000001`, **`mode: sandbox`**, `paypalOrderId: 3ED562239V124582A` |
| Catalogue | 24 products, 3 merchants, 4 categories, server-side prices |
| Demo logins | `customer@demo.dev` verified against production (`200`) |
| Health | `/api/v1/readyz` → `paypal: ok`, `llm: live`, store 17 collections |
| Tests | 78/78, 10/10 invariants |

The simulator is gone from the production path. `createPaypalGateway()` returns `PaypalSandbox`
whenever `PAYPAL_MODE=sandbox`, and the order IDs prove it is talking to PayPal.

**The one unproven link: capture.** An order is created for real; no capture has ever completed,
because capture needs a buyer to approve inside PayPal's UI and there is no browser in the build
environment. Until you click through that once, the claim "end-to-end" is one step short.

---

## 2. What the audit found wrong

### 2.0 The header was broken on every phone and tablet (Design) — FIXED

Rendering the site in a real browser (rather than reading the CSS) showed the bar kept its desktop
60px height while the mobile nav wrapped to a second row, and `overflow` stayed visible — so the nav
painted *outside* the white bar, on top of the page heading. Every phone showed "Catalogue" twice,
overlapping. Separately, the header's minimum content width is 938px and the only reflow breakpoint
was 720px, so **every viewport from 721–938px scrolled sideways** — an iPad in portrait had its cart
button off-screen. Fixed in `4e57c30`, verified in Chrome at 320/360/375/390/414/430/721/768/820/
900/938/940/980/1024/1280px: no horizontal overflow anywhere, 78/78 tests still pass.

### 2.1 The dashboards contradict each other (Design)

Merchant overview on the live instance:

```
revenueMinor: 0        paidOrders: 0        avgOrderValueMinor: 0
conversionRateBps: 4242
```

Analytics on the same instance:

```
views: 735   cartAdds: 128   checkoutAttempts: 33   purchases: 14
```

Zero revenue beside a 42.42% conversion rate and 14 purchases. The merchant product table makes it
worse: it lists "SOLD 356" per SKU while all-time paid revenue reads `$0.00`. A judge who opens the merchant
dashboard sees a shop that either is not selling or does not know whether it is. Two causes:

- `SEED_ON_BOOT` seeds *products and analytics events* but not *orders*, so history is half-there.
- Conversion is computed from event counts while revenue is computed from orders.

**Fix:** seed a small set of historical orders on boot, marked `demo: true`, whose merchant split,
status and timestamps agree with the seeded event stream — and derive the funnel from the same
orders so the two can never disagree again.

### 2.2 A cold judge waits ~40 seconds (Presentation)

`render.yaml` sets `plan: free`. Render spins a free service down after ~15 minutes idle and takes
30–60 s to come back. The first human to click the Devpost link after a quiet hour gets a blank tab.
For a judged demo that is fatal, and it is invisible in every test we run because our probes warm it.

**Fix:** Starter instance ($7/mo for the submission window), or an external 10-minute keep-alive
pinger. Verify by leaving it idle an hour and timing the first request.

### 2.3 Our strongest criterion is our least visible (Design, Presentation)

Technological Implementation is the tiebreaker and our best score, but on the site it is invisible.
A judge sees a nice shop and a chat box. They do not see 14 tools, a settlement ladder that survives
`PLATFORM_FEES_NOT_SUPPORTED`, a grounding check that refuses ungrounded prices, or 78 tests.

**Fix:** one public `/how-it-works` page — the agent loop, the tool list, the money path with the
fallback ladder, the safety rails, a link to the test output. Judges score what they can see.

### 2.4 Nothing on the site states who this is for (Impact)

"The AI shopping assistant" is a crowded, generic frame. Our defensible claim is narrower and much
stronger: *one cart, many merchants, one approval* — an agent that can assemble a basket across
sellers and settle to each of them, while never being able to spend. Nobody else in this field of
1,800–2,800 entries is likely to have solved multi-merchant split settlement with a documented
fallback. That is the sentence the whole submission should repeat.

---

## 3. The prize map — and the rule most entrants will miss

Official rules, §8:

> A project can only win up to one (1) Grand Prize **and** one (1) Sponsor Prize **OR** one (1)
> Honorable Mention Prize **and** one (1) Sponsor Prize.

So the realistic ceiling is **one $5,000 Honorable Mention + one Sponsor prize**, stackable. Prizes
we can actually contest:

| Prize | Value | Why we are eligible |
|---|---|---|
| **Best Use of Agentic Commerce** | $5,000 | We *are* agentic commerce: an agent assembles the basket, a human keeps the spend. Most entries will be recommenders; we execute and settle. |
| **Best Use of PayPal + AI** | $5,000 | Split settlement across merchants with platform fees, plus a degradation ladder. This is deep API use, not a button. |
| **Best Demo Delivery** | $5,000 | Won or lost entirely on the video. Currently 0% done. |
| **Best Use of Render** | $1,000 credits | We deploy on Render with a committed `render.yaml` blueprint. *Sponsor prize — stacks with an HM.* Nearly free to contest, and most entrants deploy elsewhere. |

**Strategic consequence:** pick *one* HM thesis and make one video serve all of them. The thesis:
**agentic commerce with a spend rail.** That single story is simultaneously the Agentic Commerce
prize, the PayPal+AI prize, and the best demo — you do not need three narratives, you need one told
properly. Then declare Render in the submission's tools list so the sponsor pool sees us.

Grand prize is a stretch: it needs all five criteria high, and Presentation can't be fixed by code.
One HM + Render credits is a realistic, winnable target. $6,000 combined.

---

## 4. The plan, in order

### Done in the Oct 17 build pass

| | |
|---|---|
| Responsive header | Fixed at 320–1280px; two faults, both invisible in code review (`4e57c30`) |
| Dashboard coherence | 44 seeded orders, sold counts derived from them, agent events seeded (`1654d5d`) |
| `/how-it-works` | The 14 tools, settlement ladder, five rails, test posture (`419fa68`) |
| Shop polish | In-stock products lead; duplicate prompt chips removed; gate redesigned (same commits) |
| Video script | `VIDEO_SCRIPT.md`, timed to 2:50 (`7dee57c`) |

### P0 — the things that gate the submission (do first, in this order)

1. **Complete one real capture.** Run the checkout on the live site, approve with a sandbox buyer,
   confirm the capture server-side. Everything else is downstream of this being true. *(You click;
   I verify the order, the capture ID and the settlement split afterwards.)*
2. **Kill the cold start.** Upgrade to Starter for the window, or add a pinger. Re-test after 60 min
   idle.
3. **Record the video (≤3:00).** Problem → agent shops → human approves → PayPal captures → order
   ledger. Script in `VIDEO_SCRIPT.md`. Judges are not required to run the project; the video *is*
   the submission.

### P1 — the things that move the score

4. **Seed coherent history on boot** (§2.1) so the merchant dashboard shows revenue, orders and a
   funnel that agrees with itself.
5. **Ship `/how-it-works`** (§2.3) — architecture, tool table, money path, safety rails, test count.
6. **Write the Devpost submission.** Feature description, the one-sentence thesis, tools used *with
   how each was used* (name **Render**, **Groq**, **PayPal**), demo link, video link, repo.

### P2 — the polish that wins a tiebreak

7. **Impact paragraph with a real scenario** — a small multi-brand retailer whose checkout cannot
   source across its own catalogue; a shopper who describes a need and approves one total.
8. **Homepage "try this" script** — three prompts that reliably produce a good demo turn, so a judge
   who pokes at it cold gets the same result the video shows.

---

## 5. Video beat sheet (3:00 hard cap)

| Time | Beat | On screen |
|---|---|---|
| 0:00–0:15 | The problem | "Shopping across brands means three carts, three checkouts, three shipping fees." |
| 0:15–0:40 | The ask | Type: *"headphones for flights, noise cancelling, under $350"*. Agent calls tools; cards appear with grounded prices. |
| 0:40–1:10 | The negotiation | Tighten a constraint. Agent re-searches, compares, explains the trade-off. |
| 1:10–1:40 | The basket across merchants | Add a laptop from Vertex and headphones from AudioPeak. Two merchants, one cart. |
| 1:40–2:20 | **The money** | Human clicks Pay. PayPal sandbox opens. Approve. Capture lands server-side. Order shows two payouts + platform fee. |
| 2:20–2:45 | The rail | "The agent can never spend." Show the tool list — no payment tool exists. |
| 2:45–3:00 | Close | "One cart. Many merchants. One approval." Repo + live URL. |

Rule for the edit: no dead air, no loading spinner longer than two seconds, no voice-over reading
the UI aloud.

---

## 6. Standing risks

- **Groq free tier: 8,000 tokens/minute.** A turn now costs ~2,600, and retries honour the provider's
  `retry-after`. A judge hammering the chat can still queue behind the window; the fallback answers
  deterministically rather than failing, which is the correct behaviour to show.
- **Ephemeral disk.** Every spin-down resets the store to the seeded state. Good for consistency
  between judges, bad unless the seed is rich enough that the shop looks alive on first load (§2.1).
- **PAT must be revoked** after this push.
