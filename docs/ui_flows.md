# ShopPilot AI — UI Flows & Screen Specs

Screen-by-screen implementation spec. Component names reference `design_system.md` §5; routes are Next.js App Router paths under `apps/web/src/app`.

---

## 0. Route map

| Route | Auth | Purpose | Primary components |
|---|---|---|---|
| `/` | any | Landing + entry to chat | `HeroSearch`, `ExamplePrompts`, `TrustStrip` |
| `/chat` | any (guest auto) | Conversational shopping | `ChatPane`, `ContextRail`, `RequirementBar` |
| `/chat?c=...` | any | Resume a conversation | same |
| `/products` | public | Browse/filter fallback (non-chat path) | `ProductGrid`, filter sidebar |
| `/products/[slug]` | public | Product detail | `ProductGallery`, `SpecList`, `ProductCard` cross-sell |
| `/cart` | any | Full cart page | `CartLineItem[]`, `CartTotals` |
| `/checkout/[orderId]` | owner session | Review + approve + pay | `CheckoutSummary`, `ApprovalPanel`, `PayPalButtonsHost` |
| `/orders` | customer | Order history | `OrderHistoryList` |
| `/orders/[orderId]/confirmation` | owner session | Receipt | `OrderReceiptCard`, `PaymentStatusPanel` |
| `/orders/[orderId]` | owner session | Order detail (also merchant view) | `OrderDetailPanel` |
| `/auth/signin`, `/auth/signup` | public | Auth (also as `AuthDialog` modal) | forms |
| `/merchant` | merchant | Overview | `StatTile[]`, `LowStockList` |
| `/merchant/products` | merchant | Product CRUD | `ProductTable`, `ProductForm` |
| `/merchant/orders` | merchant | Orders + payment status | `OrdersTable`, `PaymentAttemptTimeline` |
| `/merchant/categories` | merchant | Category CRUD | `CategoryTree` |
| `/merchant/analytics` | merchant | Funnel + trends | `AnalyticsFunnel`, `MetricTimeseries`, `TopProductsTable` |
| `/not-found`, `/error` | any | 404 / error boundary | `NotFoundPanel`, `ErrorBoundary` |

---

## 1. `/` — Landing

```
┌──────────────────────────────────────────────────────────────┐
│ ShopPilot            Shop  Orders  Merchant   [🌙] [Cart 2]  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│        Shop by describing what you need.                     │
│        Compare real products, check out with PayPal.         │
│   ┌────────────────────────────────────────────────────────┐ │
│   │ Describe what you're looking for…                  [→] │ │
│   └────────────────────────────────────────────────────────┘ │
│   Try: · Laptop for full-stack dev under $900                │
│        · Phone with the best camera under $600               │
│        · Noise-cancelling headphones for flights             │
│                                                              │
│  ┌──── grounded prices ────┬── real stock ──┬─ pay with PayPal ┐
│  └─────────────────────────┴────────────────┴────────────────┘
└──────────────────────────────────────────────────────────────┘
```
Behaviour: submitting the hero input pushes `/chat` with the message pre-filled and **auto-sends it** (state carried by `sessionStorage.sp_pending_message` so a hard navigation still works). Example prompts fill the composer (do not auto-send — the user should be able to edit first). Landing must render with zero client JS other than the composer.

States: no auth wall; if a cart exists, badge shows count; if a conversation exists, show a "Continue your last search" row (session-scoped).

---

## 2. `/chat` — the main experience

Two panes (`lg+`), single pane with a bottom-sheet cart below `lg`.

```
┌────────────────────────────────────┬───────────────────────────┐
│ [Category: Laptop] [≤ $900] [RAM ≥16│  Your cart                │
│  GB] [SSD ≥ 512 GB] [+ add]        │  ───────────────────────  │
├────────────────────────────────────┤  2 items                  │
│ 👤 I need a laptop for full-stack  │  Ascent Book 14 Pro   $879│
│    development under $900…         │   ×2  [− 2 +]             │
│                                    │  Vertex Systems            │
│ 🤖 Got it — a dev laptop under     │  ───────────────────────  │
│    $900 with ≥16 GB RAM, 512 GB    │  Subtotal        $1,758.00│
│    SSD and good battery.           │  Shipping            $0.00│
│    ● Searched 42 products · 0.9 s  │  Tax (8.25%)       $145.04│
│    ┌──────────┐ ┌──────────┐      │  Total          $1,903.04│
│    │ card 1   │ │ card 2   │      │  ───────────────────────  │
│    └──────────┘ └──────────┘      │  [ Checkout ]              │
│    ┌──────────┐                    │  Hold expires in 14:12    │
│    │ card 3   │                    │                           │
│    └──────────┘                    │                           │
│    Want me to compare the top 2?   │                           │
│    [Compare top 2] [Only ≤ $700]   │                           │
├────────────────────────────────────┤                           │
│ [Describe what you're looking for…]│                           │
│                                  ↑ │                           │
└────────────────────────────────────┴───────────────────────────┘
```

**Streaming behaviour**
1. User presses Enter → optimistic user bubble + `ToolActivity` placeholder appears.
2. SSE frames drive: `tool.activity` (label + status), `message.delta` (text), `ui.component` (cards/table/checkout card), `message.end` (final message object with `requirementRevision`, `candidateIds`).
3. If the agent calls a tool that mutates the cart, `CartPanel` refreshes from the `cart.updated` SSE frame — never from prose.
4. `Stop` (Esc) aborts the SSE stream; the partial message is kept and marked `stopped: true` with a "Continue" chip.

**RequirementBar**: chips for category, budget, each hard constraint and each soft preference; chips are inline-editable (`Chip` with popover editor) and removable. Editing a chip sends `PATCH /chat/sessions/{id}/requirement` and automatically posts a system-generated user message ("Change: budget ≤ $700") so the transcript stays honest. "Assumptions" chips render in `warning-subtle` when the agent proceeded without info.

**QuickReplies** (server-suggested, rendered under the latest agent message): e.g. `Compare top 2` · `Show cheaper` · `Add cheapest to cart` · `Explain the CPU`. Max 4, each maps to a preset user message.

**Error states in chat**: LLM provider error → assistant bubble "I lost the thread for a second. Ask me again?" + retry chip; tool error → "I couldn't reach the catalogue just now. Retry?" ; rate limit → `Alert tone="warning"` "You've sent a lot of messages — try again in 30 s."

---

## 3. `/products` and `/products/[slug]`

`/products` is the non-conversational fallback and the merchant link target. Filters: category, price slider (uses `Slider`), typed attribute facets (RAM, storage, brand, stock), sort (relevance, price ↑↓, rating). URL is the state (`?category=laptops&ramGb_gte=16`), server-rendered.

`/products/[slug]`:

```
┌──────────────┬─────────────────────────────────────────────┐
│ Gallery      │ Ascent Book 14 Pro        [In stock · 7]    │
│ (4:3, thumbs)│ Vertex Systems                              │
│              │ $879.00  ★4.6 (128)   Warranty 24 months    │
│              │ 16 GB RAM · 512 GB SSD · 14" · 1.29 kg      │
│              │ ───────────────────────────────────────────  │
│              │ [ Qty − 2 + ]  [ Add to cart ]  [Compare]   │
│              │ ───────────────────────────────────────────  │
│              │ Full specs (definition list, grouped)       │
│              │ Pros / Cons (from seeds, agent-independent)  │
│              │ Shipping & returns (platform policy)         │
│              │ ───────────────────────────────────────────  │
│              │ "Ask the agent about this laptop →"          │
└──────────────┴─────────────────────────────────────────────┘
```
"Ask the agent" opens `/chat` with a prefilled question about this product (adds to `chatSession.attachedProductIds` so the agent has context without the user re-typing the name).

---

## 4. `/cart`

Full-page mirror of `CartDrawer`, plus: per-line merchant grouping, editable quantity, remove with confirm, `FreeShippingMeter`, `PriceChangeDiff` per changed line, `CouponInput` (disabled, "Coming soon" — no fake discounts), and the primary CTA `Checkout`. Empty state uses `EmptyState` with "Tell the agent what you need" → `/chat`.

---

## 5. `/checkout/[orderId]` — the money screen

```
┌───────────────────────────────────────────┬──────────────────────────┐
│ Order review                              │  Payment                 │
│ Order SP-2026-000123 · created 14:32      │  ──────────────────────  │
│                                           │  Total  $1,903.04        │
│ Vertex Systems                            │  [Approve & Pay …]       │
│  Ascent Book 14 Pro        ×2   $1,758.00 │  You'll review and       │
│ ─────────────────────────────────────────  │  authorise the payment   │
│ ⚠ Bluetooth Speaker Mini is no longer     │  in PayPal. No charge     │
│   available and was removed.              │  happens before you       │
│ Subtotal                         $1,758.00│  approve.                 │
│ Shipping                             $0.00│                          │
│ Tax (8.25 %)                       $145.04│  Hold expires in 14:12   │
│ Total                            $1,903.04│                          │
│                                           │                          │
│ Shipping to: (collected by PayPal)        │                          │
│ Contact email: [you@example.com        ]  │                          │
└───────────────────────────────────────────┴──────────────────────────┘
```

State machine of the right-hand `PaymentPanel` (drives copy from `design_system.md` §8):

```
idle ──(click Approve & Pay)──► creating ──► awaiting_paypal ──► capturing ──► paid
                                   │               │                  │
                                   │               ├─(cancel)────────► cancelled ──┐
                                   │               └─(sdk error)─────► failed ─────┤
                                   └─(quote stale / unavailable)─────► needs_review ┤
                                                                                   ▼
                                                              failed/cancelled: [Try again] [Back to cart]
```

Rules:
* The user's email is required before payment; validated client + server. Address is **not** collected here in v1 (PayPal returns the payer's shipping address; we store it from the capture response if provided).
* `Approve & Pay` is disabled while `quoteExpiresAt` has passed with a visible "Refresh quote" action instead.
* Reload-safe: reopening `/checkout/{orderId}` re-queries the order + a fresh quote; if the order already `paid`, redirect to the confirmation page.
* Back button from PayPal must not create a second PayPal order — the page reuses `order.paypalOrderId` when its PayPal status is `CREATED` and it is not expired.
* A visible "Cancel order" link (ghost, danger text) is available while `draft`/`awaiting_payment`.

---

## 6. `/orders/[orderId]/confirmation`

Blocks in order: success header (`PaymentStatusPanel` with `success` tone) → order number + capture id (copyable) → items table with quantities and per-line totals → totals block → payment method block ("Paid with PayPal · sandbox · {payerEmail}") → merchant block(s) → "What happens next" copy → CTAs: `Continue shopping`, `View all orders` (if signed in), `Download receipt` (print-friendly HTML → `window.print()`).

If status is not `paid`, this route renders the same layout with the appropriate tone (`warning` for pending, `danger` for failed/cancelled) and the retry CTAs. The route is **never** shown with a success tone unless `order.status === "paid"` **and** `order.payment.captureId` exists — enforced in the loader, not just the UI.

---

## 7. `/orders`

Table (md+): Order · Date · Items (n) · Total · Status badge · Payment · Action (`View`). Filters by status; empty state offers `/chat`. Guest variant: session-scoped list with the `GuestSessionNotice` and "Sign in to keep these orders".

---

## 8. Merchant screens

**`/merchant` overview** — 4 `StatTile`s (Revenue 30d, Paid orders 30d, Avg order value, Conversion rate) + `LowStockList` (stock ≤ 3) + `TopProductsTable` (by purchased qty) + last 5 orders.

**`/merchant/products`** — search + status filter + category filter; table columns: Product (thumb+title), Category, Merchant SKU, Price (inline editable), Stock (inline editable), Status, Updated, actions (Edit, Archive). Inline price/stock edits PATCH and roll back with a toast on failure. `ProductForm` dialog: tabs *Basics* / *Pricing & stock* / *Attributes* / *Content*. Attributes come from a per-category schema (`packages/shared/src/categorySchemas.ts`) so the agent can rely on typed fields; unknown attributes are rejected with a field-level error.

**`/merchant/orders`** — filters (status, date range, payment status, search by order number/customer email); row expand shows items + `PaymentAttemptTimeline` (attempt #, status, PayPal order id, capture id, amount verified ✓/✗, created/updated times). Actions: `Mark as shipped` (paid → shipped), `Cancel` (draft/awaiting_payment only), `View in PayPal sandbox` (external link).

**`/merchant/categories`** — tree with drag-free reorder (up/down buttons), add child, rename, slug auto-suggest, archive (blocked if products attached — offer reassignment).

**`/merchant/analytics`** — date range `7d / 30d / custom`; `AnalyticsFunnel` (views → cart adds → checkout attempts → purchases); `MetricTimeseries` for the 4 event counts; `TopProductsTable` with views / cart adds / purchases / view→purchase rate; and a "Payment health" panel (attempts, failures, reasons). A footnote states the metric definitions from `docs/analytics_spec.md` §4 so the numbers are auditable.

---

## 9. Auth screens

`AuthDialog` / `/auth/signin` / `/auth/signup`: email + password, inline validation, "Continue as guest" escape hatch always visible, "Signing in merges your guest cart" reassurance copy. On success: if a checkout is in flight, return to `/checkout/{orderId}`; else return to `?next=` or `/chat`. Errors: `INVALID_CREDENTIALS` → "Email or password is incorrect." (never reveal which), `EMAIL_TAKEN` → "That email already has an account. Sign in instead?", `RATE_LIMITED` → "Too many attempts. Try again in 10 minutes."

---

## 10. Global states & edge cases checklist

| Situation | Where handled | Required UI |
|---|---|---|
| Deep-link to a paid order | checkout loader | redirect to confirmation, no double payment |
| Deep-link to another session's order | API 404 | `NotFoundPanel` "We couldn't find that order." |
| Session cookie missing/expired mid-flow | api client | silently `POST /session/guest`; cart re-fetch; no data loss |
| Offline / network error mid-chat | `ChatPane` | inline retry on the last turn, composer preserved |
| SSE unsupported (old browser) | `useChatStream` fallback | non-streaming POST, identical final UI |
| LLM unavailable | API | assistant bubble with apology + `Retry`; catalogue browsing still works |
| PayPal SDK blocked | `PayPalButtonsHost` | secondary "Retry payment" + "Back to cart"; order unchanged |
| Cart empty at checkout | loader | redirect to `/cart` with a toast |
| Hold expired while paying | capture path | `409 HOLD_EXPIRED` → re-checkout prompt with a new quote |
| Product archived while in cart | cart fetch | line marked unavailable, excluded from total, "Remove" CTA |
| Mobile keyboard over composer | CSS `dvh` units | composer stays visible, transcript scrolls |
| Very long product title | CSS | 2-line clamp in cards, full title on detail |
| 100+ message session | server | older messages summarised, "Show earlier messages" loads history |
| `prefers-reduced-motion` | global | opacity-only transitions, no card stagger |

---

## 11. Screen-level acceptance checklist (per screen PR)

- [ ] Renders correctly with: empty data, loading (skeletons), error, and populated states
- [ ] All money from API values, formatted with `formatMoney` (never client-computed sums)
- [ ] Keyboard-only journey works; focus order logical; focus visible
- [ ] `jest-axe` clean; no console errors/warnings
- [ ] Mobile 375 px layout verified (no horizontal scroll, tap targets ≥ 44 px)
- [ ] Light + dark verified
- [ ] Copy matches `design_system.md` §8 for money/failure states
- [ ] Analytics events fired exactly once per user action (`docs/analytics_spec.md`)
- [ ] No client-side trust of price/stock/total
