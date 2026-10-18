# Storefront-first + optional login update

## Delivered
- `/`, `/shop`, `/catalogue`: browseable storefront with search, category filter and AI entry points.
- Bottom-right assistant, desktop expansion, full-screen mobile layout, Escape/close and focus return.
- `/assistant`: opens the expanded companion over the store.
- Existing SSE agent and shared cart reused; no new payment permissions.
- Product “Ask AI” sends attached product IDs.
- Conversation restored from the current authorized session's server history (up to 100 messages); no browser HTML serialization. Closing does not clear it.
- “Clear view” clears the rendered view only, not server history or shopping preferences; label and toast make that explicit.
- Optional sign-in/register with blank credentials, labels, Enter-to-login, duplicate-submit protection, account menu and explicit sign-out.
- Guest order listing uses the existing session-scoped backend authorization. Merchants/admins still require their existing backend roles.
- Fixed a pre-existing cart render loop: rendering fetched the cart, emitted a cart event and recursively rendered the drawer. Render-time fetch now suppresses that notification.
- Cross-platform Node 20 test discovery and Playwright regression script.

## Run
```sh
cd app
npm ci
npm start
```
In another terminal:
```sh
cd app
npx playwright install --with-deps chromium
npm run test:ui  # local simulator only; creates a guest order and captures simulated payment
npm test
```
Browser test defaults to http://127.0.0.1:4000; override UI_BASE_URL only for an isolated simulator instance.

## Verification
97 existing backend tests passed. 16 browser checks passed: guest catalogue, panel lifecycle, chat results, navigation/reload history, product context entry, Escape, guest checkout/order listing, blank login fields, actual demo login, explicit account menu, mobile sizing/overflow, dark theme and no uncaught JavaScript errors. Storefront import graph check passed.

## Deployment
Commit the updated source and deploy via your existing Render workflow. Local preview uses the deterministic planner and PayPal simulator; live deployment environment settings are unchanged. No secrets are included.

## Boundaries
This is a storefront/auth UX update, not a payment-hardening release. The refund, webhook, storage and shared public demo-account risks identified in the earlier audit remain. Removing demo credentials from the sign-in UI does not revoke the seeded accounts. Rotate/restrict administrative credentials before public judging.
