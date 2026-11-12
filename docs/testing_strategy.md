# Testing strategy

The money path and agent safety boundary get the most coverage. UI chrome is checked with a browser
smoke script and CI import-graph validation.

## Commands

```bash
cd app
npm ci
npm test                 # all unit + integration + eval tests
npm run test:unit
npm run test:integration
npm run test:evals
npm run verify           # tests + ledger invariants + recorded test-count gate
npm run ledger           # invariant report against the current store
npm run smoke            # simulator-only HTTP journey against a running local server
npm run test:ui          # simulator-only Playwright regression against a local server
node scripts/check-ui-imports.mjs
```

Current recorded totals: **162 tests / 13 suites**. `app/test-count.json` is checked by `verify`; update
it with `npm run test:count:write` after adding/removing tests.

## Test harness

`app/tests/helpers/harness.mjs` boots a real server process per test file with:

- an ephemeral port and throwaway `DATA_DIR`;
- `PAYPAL_MODE=simulator` and empty real credentials;
- `FEATURE_LIVE_LLM=false` by default;
- a seeded catalogue;
- an HTTP client with cookie jar + CSRF handling and an SSE chat reader.

Tests never touch the developer's `app/.data/db.json` and never call real PayPal or a real LLM unless a
test explicitly opts into a local fake provider.

## Layers

| Layer | Location | Focus |
|---|---|---|
| Unit | `app/tests/unit/` | Money math, order state, settlement apportionment, requirement parsing, origin/return URLs, PayPal payload shape, invoice-id uniqueness |
| Integration | `app/tests/integration/` | Real HTTP: session/auth, catalogue, cart, checkout, capture/retry, webhooks, refunds, merchant/admin scoping, seed history, guest agent cart ownership, capture-failure mapping |
| Evals | `app/tests/evals/` | Live-style tool-calling loop against a scripted OpenAI-compatible provider; grounding, injection resistance, payment refusal |
| Browser | `app/scripts/ui-smoke.mjs` | Storefront/assistant/cart/checkout/role navigation in Chromium against a local simulator |
| Static | `app/scripts/check-ui-imports.mjs` | Resolves every storefront ES-module import and named export |
| Invariants | `app/scripts/ledger-check.mjs` | I1–I10 + available-to-sell against the current store |

## PayPal testing

- The in-process simulator exercises approve/decline/pending/amount-mismatch/duplicate paths without
  network calls.
- Webhook and capture-failure tests use the real sandbox gateway against a local fake PayPal
  (`PAYPAL_API_BASE_URL`), so OAuth, create/get/capture and signature verification code paths run.
- The fake PayPal mimics real 400 behaviour for missing webhook signature fields, proving the endpoint
  answers 200 instead of 500.
- `npm run paypal:check` and `npm run paypal:settlement` are **manual sandbox probes**, not CI tests;
  they create real sandbox orders and require buyer approval for capture.

## Key regressions

- Unique invoice ids across store reseeds (`DUPLICATE_INVOICE_ID` outage).
- `DUPLICATE_INVOICE_ID` routes to reconciliation, not a false `payment_failed`.
- `ORDER_NOT_APPROVED` maps to an actionable approval message.
- Split webhook settlement verifies every seller unit before paid.
- Guest agent add-to-cart appears in `GET /cart`; signed-in customer control.
- Role-based landing: merchant → `/merchant`, admin → `/admin`.
- Unsigned/malformed webhook returns 200 and is never applied.
- Refunds are merchant-scoped; cross-tenant reads do not leak.

## CI

`.github/workflows/ci.yml` runs on pushes to `main` and pull requests:

1. `npm ci`
2. `npm run verify`
3. `node scripts/check-ui-imports.mjs`

Browser smoke tests are manual/local because they need Chromium and a running simulator server. Do not
run simulator-only smoke/UI scripts against the public deployment.

## Definition of done

- A behaviour change has a test that would fail without the fix.
- `npm run verify` is green and the recorded test count matches.
- Money/permission changes update the relevant doc in the same commit.
- No real credentials, buyer passwords, logs, screenshots or local store files are committed.
