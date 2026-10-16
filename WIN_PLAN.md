# ShopPilot AI — Hackathon Win Plan

**Target:** [PayPal AI Hackathon — "Build what's next with PayPal and AI"](https://paypalaihackathon.devpost.com/)
**Deadline:** Nov 12, 2026, 12:00pm Pacific = **Nov 13, 2026 ~01:30 IST**
**Prize targets:** Best Use of Agentic Commerce ($5,000) · Best Use of PayPal + AI ($5,000) · Most Impactful ($5,000) · Presentation + Innovation (overall)
**Sponsor bolt-ons:** AG Grid ($5,000/$2,000/$1,000) · Render ($1,000/$750/$500 credits)

---

## 0. The scoring frame (read this before writing a line of code)

Five **equally weighted** criteria — tech is only 20%:

| Criterion | Weight | Where ShopPilot stands |
|---|---|---|
| Technological Implementation | 20% | Strong once real sandbox + real LLM are on |
| Design | 20% | Strong — complete product, not a mock |
| Potential Impact | 20% | Needs a sharper, quantified audience |
| Innovation / Idea | 20% | Strong — agent that shops but cannot approve |
| Presentation | 20% | **Weakest today** — no video, no hosted URL |

**Rule of engagement:** after Tier 0 is green, every further hour goes to story, polish and video before it goes to another feature.

### The thesis, in one sentence

> ShopPilot's agent does the buying work — discovers, compares, prepares, and initiates PayPal orders — and is *structurally* unable to approve payment, because approval is a human act and verification happens server-side.

This matters because the hackathon's own inspiration asks for agents that "actually transact", while PayPal's docs confirm there is no universal human-confirmation gate before agent tool calls. We supply the missing gate as a designed capability, not a limitation.

---

## Tier 0 — Gates (nothing else counts until these are done)

- [x] **T0-1 · Real PayPal sandbox wired end-to-end**
  - `/version` exposes `paypalClientId` (public value) so the browser SDK can mount — *was the blocker: the Buttons never rendered*
  - client falls back to `order.payment.clientId` from the order-create/retry response
  - `npm run paypal:check` preflight validates credentials against `api-m.sandbox.paypal.com` and prints a real capture id
  - **Exit test:** with sandbox creds, a sandbox-buyer approval produces a real `captureId`, order flips to `paid`, webhook with signature verification is accepted and deduped
- [x] **T0-2 · Repo readiness** — public repo, LICENSE detectable in About, judge-facing README with setup + demo logins for judges
- [ ] **T0-3 · Real LLM behind `FEATURE_LIVE_LLM`** — implement `runLiveTurn()`; the submission must name the AI tool used *(needs an API key)*
- [ ] **T0-4 · 3-minute demo video on YouTube + hosted demo URL** *(Render deploy doubles as the Render prize entry)*

---

## Tier 1 — Highest-leverage tech (on-theme, judge-recognisable)

- [ ] **T1-1 · Adopt PayPal's Agent Toolkit / MCP server for the agent's PayPal actions.**
  The hackathon resources page *itself* links `github.com/paypal/AI-Toolkit`, the MCP quickstart and the agent tools reference. Replace the hand-rolled gateway path for money actions with `@paypal/agent-toolkit` (`sandbox: true`), keeping the approval gate in our own registry.
- [ ] **T1-2 · Second agent surface: expose the store as an MCP server.**
  Other agents can shop from a ShopPilot store while ShopPilot's own buyer agent shops from it — "agentic commerce from both sides", matching PayPal's Agent Ready + Store Sync direction. Strongest Innovation play available.
- [ ] **T1-3 · Payment Inspector (trust panel, and the demo's money moment).**
  Live buttons a judge can press: replay the capture (same capture id, no double charge) · re-deliver the webhook (ignored) · force an amount mismatch (order stays unpaid) · expire the quote (safe retry). Showing a payment system that *refuses to be lied to* is more memorable than another happy path.

---

## Tier 2 — Sponsor prizes, best points-per-hour

- [ ] **T2-1 · AG Grid** on the merchant orders + analytics tables → opens the AG Grid prize pool.
- [ ] **T2-2 · Render deploy** → satisfies the hosted-demo requirement *and* opens the Render prize pool.
- [ ] **T2-3 · Merchant-side agent** (refunds, disputes, shipment tracking via the PayPal toolkit) → leans into the Business Solutions category.

---

## Tier 3 — Story, polish, submission

- [ ] **T3-1 · Audience + impact numbers.** "SMB merchants whose catalogues are invisible to AI shopping agents" + the analytics funnel as evidence.
- [ ] **T3-2 · Failure-first demo script** (3 min): decline → retry → verified capture → duplicate webhook ignored. Rewrite `docs/demo_script.md`, which currently references pnpm/port 3000/ngrok and is stale.
- [ ] **T3-3 · Polish pass:** mobile layout, empty states, keyboard/a11y, seeded data that makes the dashboard look alive.
- [ ] **T3-4 · Submission text** naming the AI tools used and how.

---

## What we deliberately do NOT do

- **No new endpoints.** 49 exist; the product needs 35. Breadth is not a criterion.
- **No stack rewrite.** The docs pin Next.js/MongoDB, but judges score the running app; rewriting burns the calendar for zero score.
- **No sponsor-prize chasing beyond AG Grid + Render.** A bolted-on Elastic/Bryntum integration is not worth the days.
- **Don't lead with safety.** Lead with "the agent buys it for you"; land the approval gate as *why you can trust it*.

---

## Calendar

| Days | Work |
|---|---|
| 1–4 | **Tier 0**: sandbox ✅ · repo ✅ · live LLM · video+hosting |
| 5–10 | **Tier 1**: Agent Toolkit/MCP · MCP store surface |
| 11–16 | **Tier 1/2**: Payment Inspector · merchant agent |
| 17–20 | **Tier 2**: AG Grid + Render deploy |
| 21–24 | **Tier 3**: story, polish, seeded dataset |
| 25–27 | Video shoot/cut, submission text, buffer |
