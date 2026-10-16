# ShopPilot AI — Design System v1.0

A single source of truth for every visual and interaction decision in the product. Implementation target: **Tailwind CSS v4** + **CSS custom properties** + **Radix primitives** (headless) + **shadcn/ui-style local components** (copied into `apps/web/src/components/ui`, not imported from a registry at runtime).

Rules for the coding agent:
1. Never hard-code a hex value, px radius, or font size in a component. Use a token (`var(--color-*)`, Tailwind class from §3).
2. Every component in §5 exists in `apps/web/src/components/` with the exact name given here.
3. Every interactive element must define `default / hover / active / focus-visible / disabled` and, where relevant, `loading / error / empty`.
4. All copy comes from `messages/en.json`; no string literals in JSX except test ids.

---

## 1. Brand & principles

**Personality:** a knowledgeable, calm shop assistant. Not a hype bot, not a search engine.

| Principle | What it means in pixels |
|---|---|
| **Grounded** | Prices, stock and specs are rendered from data with a visible source of truth (merchant name, "in stock: 7", "as of 2 min ago"). Numbers never come from prose. |
| **Explanatory** | Every recommendation has a *why*. Design provides a fixed slot for `whyItFits`, pros, cons and `tradeOff`. |
| **In control** | The user always sees what the agent is doing (`Thinking…`, `Searching catalogue…`, `Reading 4 products…`), can stop it, and must explicitly approve spending money. |
| **Forgiving** | Failure states keep the cart intact, allow retry, and never blame the user. Money-related errors always state what *did not* happen. |
| **Honest** | Out of stock, over budget, unknown spec → said plainly, in the same visual language (a neutral `warning` chip, not a hidden footnote). |

**Voice & tone:** short sentences, second person, no exclamation marks, no emoji in system copy (emoji allowed only in assistant *conversational* text). Money always with currency symbol and 2 decimals. Never say "Oops!".

---

## 2. Design tokens

Tokens are defined once in `apps/web/src/styles/tokens.css` as CSS custom properties and mirrored in `@theme` (Tailwind v4) so both `var(--color-surface-1)` and `bg-surface-1` work.

### 2.1 Colour — primitives

```css
:root {
  /* Ink (neutral, cool-gray ramp) */
  --gray-0:  #ffffff;  --gray-50: #f8fafc;  --gray-100:#f1f5f9;
  --gray-200:#e2e8f0;  --gray-300:#cbd5e1;  --gray-400:#94a3b8;
  --gray-500:#64748b;  --gray-600:#475569;  --gray-700:#334155;
  --gray-800:#1e293b;  --gray-900:#0f172a;  --gray-950:#060b16;

  /* Brand — "Pilot Blue" */
  --brand-50:#eef4ff; --brand-100:#dbe7ff; --brand-200:#bcd2ff;
  --brand-300:#8fb4ff; --brand-400:#5b8dff; --brand-500:#2f6bf3;
  --brand-600:#1d51db; --brand-700:#1a41ae; --brand-800:#1b3a8a;
  --brand-900:#1b356e;

  /* Accent — "Signal Mint" (agent presence, success, live states) */
  --mint-50:#e9fbf4; --mint-100:#cdf5e6; --mint-300:#7fe3c1;
  --mint-500:#17b981; --mint-600:#0e9c6b; --mint-700:#0b7b55;

  /* Semantic extra */
  --amber-50:#fff8eb; --amber-100:#feefc7; --amber-300:#fcd34d;
  --amber-500:#f59e0b; --amber-600:#d97706; --amber-700:#b45309;
  --red-50:#fef2f2;   --red-100:#fee2e2;   --red-300:#fca5a5;
  --red-500:#ef4444;  --red-600:#dc2626;   --red-700:#b91c1c;
  --violet-500:#7c5cff; --violet-100:#ece8ff;
}
```

### 2.2 Colour — semantic aliases (light)

| Token | Value | Use |
|---|---|---|
`--color-bg` | `--gray-50` | app background
`--color-surface-1` | `--gray-0` | cards, drawers, popovers
`--color-surface-2` | `--gray-100` | inset panels, code blocks, chat page bg
`--color-surface-3` | `--gray-200` | hovered rows, skeleton base
`--color-border` | `--gray-200` | default 1px separators
`--color-border-strong` | `--gray-300` | inputs, focusable outlines
`--color-text` | `--gray-900` | body copy
`--color-text-muted` | `--gray-500` | metadata, timestamps
`--color-text-subtle` | `--gray-400` | placeholder
`--color-primary` | `--brand-600` | primary CTA, links
`--color-primary-hover` | `--brand-700` |
`--color-primary-soft` | `--brand-50` | selected chips, agent bubble accent
`--color-agent` | `--violet-500` | agent avatar ring / "thinking" pulse
`--color-success` | `--mint-600` | paid, in stock, verified
`--color-warning` | `--amber-600` | low stock, price changed, pending
`--color-danger` | `--red-600` | failed payment, out of stock, destructive
`--color-focus` | `--brand-400` | focus-visible ring (2px, offset 2px)
`--color-overlay` | `rgba(6,11,22,.55)` | modal/drawer scrim

**Product-state mapping (never invent new colours for these):**

| State | Chip/tone |
|---|---|
| In stock | `success-subtle` — mint-50 bg / mint-700 text / mint-300 border |
| Low stock (≤ 3) | `warning-subtle` — amber-50 / amber-700 / amber-300 |
| Out of stock | `neutral-muted` — gray-100 / gray-600 / gray-200, plus `--color-text-subtle` strikethrough price |
| Payment paid | `success-subtle` + check icon |
| Payment pending/processing | `info-subtle` — brand-50 / brand-700 / brand-200 + spinner |
| Payment failed/cancelled | `danger-subtle` — red-50 / red-700 / red-300 |
| Superseded recommendation | card at 70 % opacity, dashed border `--color-border`, "Superseded" badge |

### 2.3 Dark theme

Dark mode via `class="dark"` on `<html>` (default: follow system; toggle in the header persists to `localStorage.sp_theme`).

```css
.dark {
  --color-bg: var(--gray-950);
  --color-surface-1: #0d1526;
  --color-surface-2: #131d33;
  --color-surface-3: #1b2742;
  --color-border: #22304d;
  --color-border-strong: #2e3f61;
  --color-text: #eef2f9;
  --color-text-muted: #9fb0cc;
  --color-text-subtle: #6d80a1;
  --color-primary: var(--brand-400);
  --color-primary-hover: var(--brand-300);
  --color-primary-soft: #17264a;
  --color-agent: #9c86ff;
  --color-success: var(--mint-300);
  --color-warning: var(--amber-300);
  --color-danger: var(--red-300);
  --color-overlay: rgba(0,0,0,.65);
}
```

### 2.4 Typography

Fonts (self-hosted via `next/font/local` so the preview works offline):
`--font-sans: "Inter Variable"` · `--font-mono: "JetBrains Mono"` · fallbacks `system-ui, -apple-system, "Segoe UI", sans-serif`.

| Token | Size / line-height / weight / tracking | Use |
|---|---|---|
`text-display` | 36px / 40px / 700 / -0.02em | Landing hero (desktop only)
`text-h1` | 30px / 36px / 700 / -0.02em | Page titles
`text-h2` | 24px / 32px / 650 / -0.01em | Section titles
`text-h3` | 18px / 26px / 600 / 0 | Card titles, drawer titles
`text-body` | 15px / 24px / 400 / 0 | Default copy, chat text
`text-body-sm` | 14px / 20px / 400 / 0 | Secondary copy, tables
`text-label` | 13px / 18px / 550 / 0.01em | Form labels, chips
`text-caption` | 12px / 16px / 500 / 0.02em | Metadata, badges, table headers (uppercase allowed)
`text-price` | 20px / 26px / 700 / -0.01em, `font-variant-numeric: tabular-nums` | Prices
`text-price-lg` | 28px / 34px / 700, tabular-nums | Checkout total

Rules: max prose width `68ch`; chat bubbles `62ch`; prices and all money use `tabular-nums`; never use more than 3 weights on one screen.

### 2.5 Spacing, radius, elevation, motion, z-index

Spacing scale (px, 4-pt base): `0,2,4,6,8,12,16,20,24,32,40,48,64` → Tailwind `p-1 = 4px` mapping is standard; use only these steps.

Radius: `--radius-xs:6px` (chips, inputs) · `--radius-sm:8px` · `--radius-md:12px` (cards, buttons) · `--radius-lg:16px` (drawers, modals) · `--radius-xl:24px` (hero panels) · `--radius-full:9999px` (avatars, pills).

Elevation (dark theme swaps to border-first, shadow-lite):
`--shadow-xs: 0 1px 2px rgba(6,11,22,.06)` · `--shadow-sm: 0 1px 3px rgba(6,11,22,.08), 0 1px 2px rgba(6,11,22,.04)` · `--shadow-md: 0 4px 12px rgba(6,11,22,.10)` · `--shadow-lg: 0 12px 32px rgba(6,11,22,.14)` (drawer/modal) · `--shadow-focus: 0 0 0 2px var(--color-bg), 0 0 0 4px var(--color-focus)`.

Motion: `--dur-instant 80ms` · `--dur-fast 140ms` · `--dur-base 200ms` · `--dur-slow 320ms`. Easing `--ease-standard cubic-bezier(.2,.8,.2,1)` · `--ease-emphasis cubic-bezier(.3,1.4,.4,1)` (use sparingly, never on money). All animation must be wrapped so `@media (prefers-reduced-motion: reduce)` collapses to opacity-only ≤ 80 ms; streaming text must not animate character-by-character under reduced motion.

Z-index ladder (use tokens, never raw numbers): `--z-base 0`, `--z-sticky 10`, `--z-drawer 40`, `--z-modal 50`, `--z-toast 60`, `--z-tooltip 70`.

Breakpoints (Tailwind defaults): `sm 640 · md 768 · lg 1024 · xl 1280 · 2xl 1536`. Layout container: `max-w-[1200px] px-4 md:px-6`, chat/checkout columns `max-w-[720px]`.

### 2.6 Tailwind `@theme` bridge (copy verbatim)

```css
@import "tailwindcss";
@theme {
  --color-bg: var(--color-bg);
  --color-surface-1: var(--color-surface-1);
  --color-surface-2: var(--color-surface-2);
  --color-border: var(--color-border);
  --color-text: var(--color-text);
  --color-muted: var(--color-text-muted);
  --color-primary: var(--color-primary);
  --color-primary-soft: var(--color-primary-soft);
  --color-success: var(--color-success);
  --color-warning: var(--color-warning);
  --color-danger: var(--color-danger);
  --radius-card: var(--radius-md);
  --font-sans: var(--font-sans);
  --shadow-card: var(--shadow-sm);
}
```

---

## 3. Layout system

```
AppShell
├── TopBar (sticky, z-sticky, h-64px): wordmark · nav (Shop / Orders / Merchant*) · theme toggle · CartButton · AccountMenu
├── Main
│   ├── Landing /            → HeroSearch + ExamplePrompts + TrustStrip
│   ├── /chat                → two-pane on lg: [ChatPane 1fr | ContextRail 400px]
│   ├── /products, /products/[slug]
│   ├── /cart                → CartPage (table on md+, stacked cards below)
│   ├── /checkout            → CheckoutSummary + PaymentPanel (sticky on lg)
│   ├── /orders, /orders/[id]/confirmation
│   └── /merchant/*          → DashboardShell (sidebar 240px + content)
└── Toaster (z-toast)
```

**Chat page layout (the product's centre of gravity):**

```
┌───────────────────────────────────────────────┬──────────────────────────┐
│ ChatPane                                      │ ContextRail             │
│ ┌─ RequirementBar (chips, editable) ────────┐ │ ┌─ CartPanel ─────────┐ │
│ ├─ Transcript (scroll, aria-live=polite) ───┤ │ │ items, qty, subtotal│ │
│ │  user bubble (right, primary-soft)        │ │ ├─ QuoteSummary ──────┤ │
│ │  agent bubble (left, surface-1, avatar)   │ │ │ shipping/tax/total  │ │
│ │  └─ ToolActivity ("Searched 42 products") │ │ └─ CTA: Checkout ─────┘ │
│ │  └─ ProductCardGrid (1–5 cards)           │ │  (rail collapses to    │
│ │  └─ ComparisonTable / CheckoutCard        │ │   bottom sheet < lg)   │
│ ├─ Composer (textarea + send + chips) ──────┤ │                        │
│ └───────────────────────────────────────────┴─┴────────────────────────┘
```

Agent working states in the transcript: `listed → running tool → composing`. Show a `ToolActivity` row (icon + verb phrase + result count + duration). Never show raw JSON, tool names, or model names to customers; the merchant/admin dashboard may show a debug drawer behind `NEXT_PUBLIC_DEBUG_AGENT=1`.

---

## 4. Component inventory (required)

Naming and file paths are contractual.

**Primitives — `components/ui/`**
`Button` (`variant: primary|secondary|ghost|danger|link`, `size: sm|md|lg`, `loading`, `leftIcon`) · `IconButton` · `Input` · `Textarea` (auto-grow) · `Select` · `Combobox` · `Checkbox` · `Radio` · `Switch` · `Slider` (budget range) · `Badge` · `Chip` (removable, editable) · `Card` · `Sheet` (bottom sheet/drawer) · `Dialog` · `Tooltip` · `Popover` · `Tabs` · `Accordion` · `Table` · `Pagination` · `Skeleton` · `Spinner` · `Progress` · `Avatar` · `Toaster`/`useToast` · `Alert` (`tone: info|success|warning|danger`) · `EmptyState` · `StatTile` · `CopyButton` · `Stepper` · `SegmentedControl` · `Breadcrumb`

**Domain — `components/chat/`**
`ChatPane` · `Transcript` · `MessageBubble` (`role: user|agent|system`) · `ToolActivity` · `TypingIndicator` · `StreamingText` (cursor block, `aria-live=polite`, throttled 60 ms) · `Composer` (Enter=send, Shift+Enter=newline, IME-safe, disabled while streaming, "Stop" button) · `QuickReplies` · `RequirementBar` + `RequirementChip` · `AssumptionsRow` · `SupersededBadge`

**Domain — `components/product/`**
`ProductCard` (`variant: grid|compact|rail`) · `ProductCardSkeleton` · `RecommendationCard` (extends ProductCard with `whyItFits`, `ProsCons`, `tradeOff`, actions) · `ProductGrid` · `StockBadge` · `PriceTag` (`strikeThrough?`, `perUnit`) · `SpecList` (definition list) · `ProsCons` · `ComparisonTable` (sticky first column, winner cells highlighted with a mint dot + `aria-label="best in this row"`) · `ProductGallery` · `MerchantBadge` · `AlternativeSuggestion`

**Domain — `components/cart/`**
`CartButton` (badge count, opens `CartDrawer`) · `CartDrawer` · `CartLineItem` (thumb, title, merchant, qty stepper, unit/total, remove, stock warning) · `QtyStepper` · `CartTotals` (subtotal/shipping/tax/total rows, tabular-nums) · `FreeShippingMeter` ("$62.10 to free shipping")

**Domain — `components/checkout/`**
`CheckoutSummary` (grouped by merchant, snapshot prices, warnings) · `OrderReviewList` · `ApprovalPanel` (the "Approve & Pay" area; states: idle → approved → processing) · `PayPalButtonsHost` (client-only, dynamic import, sandbox `client-id` from env) · `PaymentStatusPanel` (states: processing, succeeded, failed, cancelled, pending, unavailable) · `RetryPaymentPanel` · `PriceChangeDiff` · `UnavailableItemNotice` · `OrderReceiptCard` · `TaxShippingNote` ("Demo tax rate 8.25 %")

**Domain — `components/merchant/`**
`MerchantSidebar` · `ProductForm` (typed attributes, dynamic spec rows, validation) · `ProductTable` (inline price/stock edit with optimistic update + rollback) · `StockEditor` · `CategoryTree` · `OrdersTable` · `OrderDetailPanel` (with `PaymentAttemptTimeline`) · `PaymentStatusBadge` · `AnalyticsFunnel` · `MetricTimeseries` (inline SVG sparkline/bar, no chart lib required) · `TopProductsTable` · `LowStockList`

**Domain — `components/account/`**
`AuthDialog` (`mode: signin|signup`, uses `Dialog`) · `AccountMenu` · `OrderHistoryList` · `OrderStatusBadge` · `GuestSessionNotice`

**Layout — `components/layout/`**
`AppShell` · `TopBar` · `Footer` (must include the sandbox disclosure) · `PageHeader` · `ThemeToggle` · `SkipToContent` · `ErrorBoundary` · `NotFoundPanel`

---

## 5. Component specifications (the ones with non-obvious behaviour)

### 5.1 Button
| Variant | bg | text | border | hover |
|---|---|---|---|---|
| primary | `--color-primary` | white | none | `--color-primary-hover`, translateY(-1px) |
| secondary | `--color-surface-1` | `--color-text` | `--color-border-strong` | bg `--color-surface-2` |
| ghost | transparent | `--color-text` | none | bg `--color-surface-2` |
| danger | `--color-danger` | white | none | darken 8 % |
| link | transparent | `--color-primary` | none | underline |

Sizes: `sm h-8 px-3 text-label radius-xs` · `md h-10 px-4 text-body-sm radius-md` · `lg h-12 px-6 text-body radius-md`.
States: `focus-visible: var(--shadow-focus)`; `disabled: opacity .5 + cursor-not-allowed`; `loading: spinner replaces leftIcon and label stays` (never swap label to "Loading…", it breaks layout and screen-reader context); minimum touch target 44×44 px on mobile via padding.
**Money buttons** (Approve & Pay, Retry payment) always render the amount: `Approve & Pay $1,903.04`.

### 5.2 ProductCard / RecommendationCard

```
┌────────────────────────────────────────────┐
│ [image 4:3, radius-sm, object-cover]  [♡]  │
│ Ascent Book 14 Pro            [In stock]   │
│ Vertex Systems                [MerchantBadge]│
│ $879.00  ~~$949.00~~   ★ 4.6 (128)         │
│ 16 GB RAM · 512 GB SSD · 14" · 1.29 kg     │
│ ────────────────────────────────────────── │
│ Why it fits: meets every constraint and    │
│ still has 11 h battery for long sessions.  │
│ + 16 GB soldered but fast for IDEs         │
│ + 11 h measured battery (Wh spec: 60)      │
│ − No discrete GPU for heavy containers     │
│ [ Add to cart ▾ ]  [ Compare ]  [ Details ]│
└────────────────────────────────────────────┘
```
* Card is a single `article` with `aria-labelledby` on the title; the whole card is **not** a link (nested interactive controls); title is the link to `/products/{slug}`.
* `Add to cart` opens an inline `QtyStepper` when `stock > 1`, else adds 1 directly; on success the button morphs to a check + "Added 2" for 1.6 s then to "In cart · 2".
* If `stock === 0`: price struck through only if the product is genuinely discontinued; otherwise show price with a neutral "Out of stock" badge, disable Add, show `AlternativeSuggestion`.
* Widths: grid `minmax(260px,1fr)`, rail `100 %`, compact row for cart/compare.

### 5.3 ComparisonTable
Rows = union of compared attributes, ordered: Price → key category attributes (category-specific order map in `lib/compareOrder.ts`) → Warranty → Rating → Stock. Columns = compared products (2–4). Winner cell: mint dot + label text (not colour-only). Sticky header row and first column; horizontal scroll with a visible scroll-shadow affordance. On mobile, switch to a per-attribute stacked "swipe" layout. Provide a "Add all to cart"? **No** — one product per decision.

### 5.4 QtyStepper
`− 2 +` with direct input; clamps `1..min(stock,10)`; on `Insufficient` response shows an inline `Alert tone="warning"` "Only 1 left — quantity set to 1." Debounce API writes 400 ms; optimistic UI with rollback to server value on error.

### 5.5 CartDrawer
Right sheet, `w-[420px]` desktop, full-width bottom sheet mobile. Contains `CartLineItem[]`, `FreeShippingMeter`, `CartTotals`, `Button primary lg "Checkout"` (disabled when empty), secondary "Keep shopping". Warns when a line's price changed since it was added: `PriceChangeDiff` inline, chip `warning-subtle`.

### 5.6 CheckoutSummary + ApprovalPanel
Order of rows is fixed: **Items → Subtotal → Shipping → Tax (8.25 %) → Total**, each with live values from `POST /checkout/quote`. Then a `warning` alert listing any of: price changed, item unavailable, quantity reduced, hold expiring in `mm:ss`.
`ApprovalPanel` states:
1. `idle` — checkbox-free, single primary button `Approve & Pay $1,903.04`, with the caption "You'll review and authorise the payment in PayPal. No charge happens before you approve."
2. `creating` — button loading, transcript note.
3. `awaiting_paypal` — PayPal Buttons rendered; copy "Complete the payment in the PayPal window."
4. `capturing` — spinner + "Confirming your payment with PayPal. Do not close this page."
5. `paid` — success block with capture id, order number, "View order".
6. `failed` — danger alert, plain-language reason, `Try again` + `Back to cart`, and the reassurance "No money has left your account. Your cart is unchanged."
Money-critical buttons are never optimistic; they reflect server state only.

### 5.7 PayPalButtonsHost
Client component, `next/dynamic` with `ssr: false`, loaded only on the checkout route after approval. Reads `NEXT_PUBLIC_PAYPAL_CLIENT_ID` + `NEXT_PUBLIC_PAYPAL_CURRENCY=USD`. Handles `createOrder` (our API), `onApprove` (our capture endpoint), `onCancel` (`payment_cancelled` UI state, order stays `awaiting_payment`), `onError` (`payment_failed` UI state), and `INSTRUMENT_DECLINED` → `actions.restart()` per PayPal's funding-failure guidance. Buttons render in `layout: vertical`, `shape: pill`, `color: gold`, `label: paypal`, `height: 48`. Show a `Button variant="secondary"` fallback with "Retry payment" if the SDK fails to load (ad-blockers).

### 5.8 ToolActivity / StreamingText
`ToolActivity`: 14 px muted row, leading pulsing dot in `--color-agent`, text from a static verb map (`search_products → "Searching the catalogue"`, `compare_products → "Building a comparison"`, `prepare_checkout → "Preparing your order"`, `add_to_cart → "Updating your cart"`). Collapses into a compact "3 steps · 1.2 s" summary after the answer starts. `StreamingText`: append throttled tokens, show a 2 px blinking caret in `--color-agent`; when complete, replace caret with a copy button; `aria-live="polite"` on a wrapper that announces ~every 2 s (never per token, never mid-word for screen readers).

### 5.9 AnalyticsFunnel (merchant)
Four bars: Product views → Cart adds → Checkout attempts → Purchases, each with count, % of previous, and % of views (conversion). Bars are inline SVG or CSS-width divs; no chart dependency required. Include the numeric values as text so the chart is readable without colour.

---

## 6. Interaction & motion rules

| Interaction | Behaviour |
|---|---|
| Send message | message appears instantly (optimistic user bubble), streaming starts < 300 ms or a `TypingIndicator` shows |
| Agent streams a card set | cards fade+rise 8 px, staggered 40 ms, max 5; respect reduced motion |
| Add to cart | cart badge pops (scale 1 → 1.15 → 1, 200 ms) + toast "Added 2 × Ascent Book 14 Pro" with "View cart" |
| Quantity change | optimistic; rollback with a warning toast on error |
| Checkout → payment | page transitions never lose the order; URL always contains `orderId` so refresh is safe |
| Destructive (remove item, clear cart, cancel order) | requires explicit confirm; cancellation dialog names the item/order |
| Error toast | includes `Reference: {requestId}` and a copy button |
| Long operations (search > 1.5 s) | skeleton cards, never a blocking spinner over the transcript |

Focus management: opening `CartDrawer`/`Dialog` moves focus to the first heading; `Esc` closes; focus returns to the trigger. After an assistant turn ends, keep focus in the composer.

---

## 7. Accessibility (WCAG 2.1 AA — built in, not bolted on)

* Chat transcript is a `role="log"` with `aria-live="polite"`; the composer has a labelled `textarea` (`aria-describedby` = hint text). A `Stop generating` control is keyboard reachable (`Esc` also stops).
* Never communicate state with colour alone: stock, payment status, comparison winners all carry text/icon.
* All interactive controls ≥ 44×44 px on touch; visible `:focus-visible` ring at all times.
* Contrast: body text ≥ 4.5:1, large text ≥ 3:1, focus ring ≥ 3:1 against adjacent colours. Verified in `docs/testing_strategy.md` (axe + manual audit tickets).
* Images: meaningful `alt` from product title + category; decorative images `alt=""`. Price-only changes announce via `aria-live="polite"` region in `CartTotals`.
* Reduced motion respected globally; no autoplay media; no time-limited reading except the 15-min inventory hold, which shows a live countdown and an "extend hold" action.
* Forms: labels always visible (no placeholder-as-label), errors announced and linked via `aria-describedby`, error summary at the top of the checkout form.
* Keyboard path for the whole money journey: browse → add → cart → checkout → approve → PayPal (PayPal's own a11y) → confirmation.

---

## 8. Content & microcopy standards

| Situation | Copy (exact) |
|---|---|
Composer placeholder | "Describe what you're looking for…"
Agent thinking | "Looking through the catalogue…"
Clarify budget | "What's your budget? I'll keep everything inside it." Quick replies: `< $500` · `$500–$900` · `$900–$1,500` · `No limit`
Assumptions row | "Working with: budget — any, use — general. Tap to change."
Budget grace | "This one is $27 over your budget. Want to see it anyway?" (button: `Show it`)
Out of stock | "Out of stock right now. Here are two close alternatives."
Price changed | "The price of Ascent Book 14 Pro changed from $879.00 to $899.00. Your total was updated — review and approve again."
Unavailable at checkout | "Bluetooth Speaker Mini is no longer available. It's been removed from your total. Approve the new total to continue."
Approve CTA | "Approve & Pay $1,903.04"
Approval caption | "You'll review and authorise the payment in PayPal. No charge happens before you approve."
Capture in flight | "Confirming your payment with PayPal. Do not close this page."
Paid | "Payment confirmed. Order SP-2026-000123 is on its way to processing."
Payment failed | "Your payment didn't go through. No money has left your account and your cart is unchanged."
Payment pending | "PayPal is still processing this payment (e-cheque or bank review can take a few days). We'll confirm as soon as it clears."
Cancelled | "Payment cancelled. Your order is still reserved for 12:41 — approve when you're ready."
Guest notice | "You're shopping as a guest. Sign in to keep your orders and cart on any device."
Sandbox disclosure (footer) | "Demo environment — payments run through the PayPal sandbox. No real charges."
Empty cart | "Your cart is empty. Tell the agent what you need and it'll find options."
No results | "Nothing matched those constraints exactly. Here's the closest: (showing 3 with 1 relaxed filter — RAM ≥ 8 GB)."
Error boundary | "Something went wrong on our side. Reference: {requestId}. Your cart and orders are safe."

---

## 9. Asset & iconography rules

* Icons: **Lucide** (`lucide-react`), 16/20/24 px, `stroke-width: 1.75`, `currentColor`. Domain icon map: search, git-compare (compare), shopping-cart, credit-card, shield-check, package, truck, receipt, sparkles (agent), alert-triangle, clock, refresh-cw, chevron-*, x, plus, minus, check, external-link, info.
* Product images: 4:3, ≥ 800 px wide, `next/image` with `sizes="(max-width:768px) 100vw, 320px"`, `placeholder="blur"` where a blur hash exists. Seed data uses static paths under `/public/products/*.svg` so the demo works offline; no external CDNs in the default path.
* Logos: wordmark = "ShopPilot" in 600 weight + `sparkles` glyph in `--color-agent` inside a `--radius-sm` tile. Merchant logos render as initials avatars when no logo URL exists.
* Illustration: only in empty/error states; simple 1.5 px line art in `--color-border-strong` with a single `--color-primary-soft` fill.

---

## 10. Implementation checklist (per component PR)

- [ ] Uses tokens only (grep the diff for `#`, `px` literals in style props, and Tailwind arbitrary values)
- [ ] All 6 states implemented: default, hover, active, focus-visible, disabled, loading (where applicable) + empty & error for containers
- [ ] Keyboard operable, focus visible, correct roles/labels, live regions for async text
- [ ] Reduced-motion branch implemented
- [ ] Light + dark verified (screenshot in PR description)
- [ ] Mobile (375 px), tablet (768 px), desktop (1440 px) verified
- [ ] Strings from `messages/en.json`
- [ ] Storybook-style demo route or `__tests__` snapshot + a11y assertion (`jest-axe`)
- [ ] No new dependency added without a note in the PR body explaining why the platform/lib can't do it
