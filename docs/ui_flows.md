# UI flows

The storefront is a vanilla-ESM single-page app served by Express from `app/shop/`. There is no
Next.js/React build step. `app/shop/js/app.js` owns routing, auth state, cart drawer and the assistant
panel; feature modules render into the panes declared in `index.html`.

## Route map

| Path | Auth | Purpose |
|---|---|---|
| `/`, `/shop`, `/catalogue` | any | Catalogue + shopping surface |
| `/assistant` | any | Catalogue with the assistant expanded |
| `/orders` | signed-in customer/merchant/admin | Order history |
| `/orders/:orderId` | owner / scoped merchant / admin | Order detail, timeline, payment proof |
| `/checkout/:orderId` | owner session | Review, address/contact, PayPal approval, capture status |
| `/merchant` | merchant (admin may inspect) | Merchant dashboard tabs |
| `/admin` | admin | Platform Console with AG Grid |
| `/how-it-works` | public | Static architecture/invariant explainer |

Unknown paths fall back to the catalogue. Role landing after sign-in:

- customer/guest → storefront
- merchant → `/merchant`
- admin → `/admin`

## Global chrome

- Top bar: brand, Shop, AI assistant, Orders, Merchant (role-gated), Platform Console (admin),
  How It Works, theme toggle, sign-in/account, cart button with count.
- Cart drawer: line items grouped by seller, quantity controls, remove, totals, checkout CTA.
- Assistant launcher: opens the chat panel; `/assistant` opens it expanded.
- Toasts for success/error; payment mode pill shows simulator/sandbox/degraded state.
- Footer links and build info from `/api/v1/version`.

## Catalogue

`catalogue.js` renders product cards with vendored WebP photos, price, stock, rating, merchant,
attribute chips and add-to-cart. Filters/search/sort are server-backed where possible. Product detail
opens in a modal/panel with specs, policies and an “ask the assistant” path. Missing images degrade
without a broken-image icon; there is no runtime SVG fallback.

## Assistant

`assistant.js` / `chat.js` stream `POST /api/v1/chat/stream` over SSE:

1. Optimistic user message.
2. `tool.activity` rows show tool name/status/duration.
3. `ui.component` renders server-authored cards/comparison/cart/checkout components.
4. `message.delta` appends text; `message.end` finalises usage/profile and quick replies.
5. Cart mutations refresh the cart from server state, never from model prose.

The composer supports text, quick replies, clear view and voice input where the browser supports it.
The mode line labels live model vs deterministic fallback. Stop/abort keeps partial text honest.

## Cart and checkout

Cart mutations call `/api/v1/cart/*` with CSRF. Checkout:

1. `POST /checkout/quote` recomputes totals and holds.
2. `POST /orders` creates the draft order and PayPal order.
3. Checkout page shows order review, seller lines, totals, contact email and delivery address.
4. PayPal Buttons render only after `payment.paypalOrderId` exists and the order is not paid.
5. Human approval in PayPal returns to `/checkout/:orderId?from=paypal`.
6. `POST /payments/:orderId/capture` runs server verification; UI polls/statuses until paid, pending,
   failed or needs-reconcile.

Payment panel states: idle → creating → awaiting PayPal → capturing → paid; cancel/decline/pending/
verification-failure branches show actionable copy. Duplicate/already-captured states say “confirming”
and never invite a second payment.

## Orders

`orders.js` lists orders with status, total, date and payment state. Detail shows timeline, items,
shipping, payment attempts, capture id(s), settlement mode and verification checks. Merchant/admin
views are scoped; cross-tenant reads return not-found.

## Merchant dashboard

`merchant.js` tabs:

- **Overview & KPIs:** revenue, orders, low stock, recent activity.
- **Products:** search/filter, inline price/stock edits, create/edit/archive, category attributes.
- **Orders:** scoped order list, fulfilment actions, payment attempts, merchant-scoped refund.
- **Discovery Funnel:** analytics funnel, rates, timeseries, top products, payment health.
- **Settlement:** seller settlement/disbursement view for split orders and fallback reasons.

Admins may inspect a merchant by passing `?merchantId=` to merchant APIs; the UI gates admin access.

## Platform Console

`admin.js` requires admin. It shows marketplace GMV, platform commission, seller disbursements and
orders needing attention. AG Grid Community tables provide multi-column sort/filter and CSV export for
orders and seller settlements. Admins can reconcile an order from the grid. If AG Grid fails to load,
the console degrades to a plain table rather than blocking access.

## Accessibility and theme

- Skip link, labelled controls, `aria-live` chat/toasts, focus-visible rings.
- Light/dark theme via `prefers-color-scheme` and manual toggle (`data-theme`).
- Semantic colour tokens only; every state has text, not colour alone.
- Reduced-motion preference disables nonessential animation.
