# Demo video — shot sheet

**Target: 2:50. Hard cap 3:00.** Judges are not required to watch past it, and the rules say
"Judges are not required to test the Project" — so **the video is the submission**, not a
supplement to it. Presentation is 20% of the score and currently at zero.

Prize this is aimed at: **Best Demo Delivery ($5,000)**, with the same footage serving
**Best Use of Agentic Commerce** and **Best Use of PayPal + AI**.

---

## Before you press record

| Check | Why |
|---|---|
| Open the site 10 minutes early and leave the tab open | Free Render tier sleeps after ~15 min idle; a cold start adds 40s of white screen to shot one. |
| Sign in as `customer@demo.dev` / `Customer@12345` | Checkout needs an email on the order. Guest carts cannot place one. |
| Empty the cart | The demo should build a basket on camera. |
| Zoom the browser to 110%, hide bookmarks bar | Text must be legible on a phone screen at 720p. |
| Note the PayPal sandbox buyer login | You will type it during the approval — have it on a sticky note, not in a tab. |
| 1920×1080, 30fps, record system audio | Even a voiceover recorded after the fact beats silence. |

**One take per beat, stitched.** Do not try to do it in one continuous take; every retry costs a
full pass through PayPal.

---

## The script

### 0:00–0:12 — The problem (no app on screen)

> "Buying a laptop and headphones from two different stores means two carts, two checkouts and two
> shipping fees. ShopPilot is one agent that builds a single basket across merchants — and a human
> who approves the payment."

**On screen:** the home page, static. Do not scroll yet.

---

### 0:12–0:40 — The ask

Type into the chat, slowly enough to read:

> `noise cancelling headphones for flights under $350`

**Watch for:** the tool-activity line showing `search_products` running, then done (~2–3 s).

> "It searched the real catalogue — not its memory. Every price you see came back from a tool in
> that call."

**On screen:** the three product cards, the grounded prices, the stock badges.

**If the free tier makes it wait:** the answer will take ~10–20 s while the quota window clears.
Either cut the wait in the edit, or say "the model is on a free tier with a per-minute token cap,
so it queues — the fallback answers instantly if it runs out", which is a better story than a jump cut.

---

### 0:40–1:10 — The negotiation

> `actually I want over-ear, and battery matters more than weight`

**Watch for:** a new search that narrows rather than repeats.

> "It carries the requirement forward. I did not have to say 'headphones' again."

Then add one to the cart. Point at the fact that the price in the cart is the price the tool returned.

---

### 1:10–1:40 — Two merchants, one basket

Go to `/catalogue` → add a laptop from **Vertex Systems**.

> "Headphones from AudioPeak. A laptop from Vertex. Two merchants, one cart, one checkout."

Open the cart drawer so both lines are visible with their merchant names.

**This is the shot that wins Agentic Commerce.** Hold it for three full seconds.

---

### 1:40–2:20 — The money (the payoff)

Click **Review and pay** → the checkout page.

> "The agent priced this. It prepared the order. It cannot pay it — there is no payment tool in its
> toolset. This button is mine."

Click **Pay with PayPal**. The sandbox window opens. Sign in as the sandbox buyer. **Approve.**

**Let the return screen breathe.** The order confirmation with the capture is the single most
important frame in the video.

Then open the order detail:

> "Two settlement units — Vertex gets this much, AudioPeak gets this much, the platform fee is
> separate — and the capture is verified server-side against the amount that was stored before I
> ever left the page."

---

### 2:20–2:42 — The rails

Cut to `/how-it-works`, scroll to **The tools** table.

> "Fourteen tools. Read the list: search, compare, cart, quote, policy. No tool that can pay. That
> is the design, not a limitation."

Scroll to **The money path**.

> "And if PayPal refuses a split — no platform fees on this account — it rebuilds the same order
> without the fee and keeps the sale. The shopper pays the same total."

---

### 2:42–2:55 — Close

Back to the home page.

> "ShopPilot AI — one cart, many merchants, one approval. Built on PayPal's sandbox APIs and a live
> language model. Code and tests at github.com/uttamongithb1/paypal-hackathon."

**On screen:** the URL and the repo, held still for four seconds. Judges screenshot the last frame.

---

## Edit rules

- **Cut every loading state longer than two seconds.** The only wait worth keeping is the tool
  activity line, because it *is* the evidence the agent is real.
- **No music** unless licensed — the rules require permission for copyrighted audio.
- **Caption the two claims** as lower-third text: *"No tool can pay"* at 2:24 and *"Split settles to
  two merchants"* at 2:05. Judges skim muted.
- **Do not read the UI aloud.** "Now I'm clicking the button" wastes the three minutes.
- Upload to YouTube as **Public or Unlisted**, not Private — Devpost needs a resolvable link.

---

## If the capture fails on the day

The single real risk. If PayPal's sandbox refuses the approval:

1. Do not fake it and do not hide it.
2. Re-record that one beat. Sandbox approvals fail intermittently; a second attempt almost always works.
3. If it still fails, film the **order detail page of an already-captured order** and say plainly:
   "the capture is verified server-side — here is one from this morning." The claim stays true, and
   honesty about a flaky sandbox reads far better than a suspiciously perfect cut.

**This is the one beat that cannot be faked, which is exactly why it is worth the three minutes.**
