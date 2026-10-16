/**
 * PayPal sandbox preflight — proves the REAL integration works, not the simulator.
 *
 *   npm run paypal:check              → OAuth + create a real sandbox order, print the approve URL
 *   npm run paypal:check -- --capture <paypalOrderId>
 *                                     → capture that (buyer-approved) order and print the capture id
 *   npm run paypal:check -- --status <paypalOrderId>   → re-read an order and show its status
 *
 * Why two steps: PayPal will not let a server capture an order a human has not approved
 * (`ORDER_NOT_APPROVED`). Step 1 gives you an approve URL; open it, log in as a sandbox *buyer*,
 * approve, then run step 2. Step 2 is the same call the app makes in `POST /payments/:id/capture`.
 *
 * Docs: ../docs/payments_paypal.md · ../docs/env_setup.md §5
 */
import { createPaypalGateway } from '../server/payments/paypal.gateway.mjs';
import env, { paypalBaseUrl } from '../server/config/env.mjs';
import { taxFor, shippingFor, formatMoney, toPayPalAmount } from '../server/lib/money.mjs';

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1] ?? null;
};

const line = (label, value) => console.log(`  ${label.padEnd(22)} ${value}`);
const ok = (msg) => console.log(`  \u2713 ${msg}`);
const bad = (msg) => console.log(`  \u2717 ${msg}`);

function fail(message, hint) {
  console.error(`\n${message}`);
  if (hint) console.error(hint);
  process.exit(1);
}

console.log('\nPayPal sandbox preflight\n');

if (env.paypalMode !== 'sandbox') {
  console.log(`  mode: ${env.paypalMode} (simulator — zero calls leave this machine)`);
  console.log('\n  Nothing to check. To exercise the real API:');
  console.log('    1. developer.paypal.com → Apps & Credentials → Sandbox → create an app');
  console.log('    2. Put PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in app/.env and set PAYPAL_MODE=sandbox');
  console.log('    3. npm run paypal:check\n');
  console.log('  The simulator is a first-class mode: it drives the same HTTP contract and all the');
  console.log('  failure paths (decline / pending / amount mismatch / duplicate webhook) with no credentials.');
  process.exit(0);
}

if (!env.paypalClientId || !env.paypalClientSecret) {
  fail('PAYPAL_MODE=sandbox needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.',
    '  Sandbox creds: developer.paypal.com → Apps & Credentials → Sandbox → Default Application\n');
}

const gateway = createPaypalGateway();
console.log('  endpoint              ', paypalBaseUrl);
line('client id', `${env.paypalClientId.slice(0, 12)}…`);
line('webhook id', env.paypalWebhookId ? `${env.paypalWebhookId.slice(0, 12)}… (signature verification on)` : 'not set → webhooks will be rejected (set PAYPAL_WEBHOOK_ID)');

// ── Step 1: credentials ──────────────────────────────────────────────────────
try {
  const token = await gateway.accessToken();
  ok(`OAuth2 client_credentials → token ${token.slice(0, 8)}… (${Math.round((gateway.tokenExpiresAt - Date.now()) / 1000)}s)`);
} catch (error) {
  fail(`  \u2717 OAuth failed: ${error.issue ?? error.message}`,
    '\n  Check that the credentials are the sandbox app\'s and not the live app\'s.\n');
}

// ── Re-read an existing order (step 2 helper) ────────────────────────────────
const statusId = flagValue('status');
if (statusId) {
  const order = await gateway.getOrder(statusId);
  console.log('\nOrder status\n');
  line('id', order.id);
  line('status', order.status);
  line('payer', order.payer?.email_address ?? '(no payer yet)');
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  if (capture) {
    line('capture id', capture.id);
    line('captured', `${capture.amount.value} ${capture.amount.currency_code} (${capture.status})`);
  }
  console.log('');
  process.exit(0);
}

// ── Capture a buyer-approved order ───────────────────────────────────────────
const captureId = flagValue('capture');
if (captureId) {
  console.log('\nCapturing (the app does exactly this in POST /payments/:orderId/capture)\n');
  let response;
  try {
    response = await gateway.captureOrder(captureId, { requestId: `preflight-capture-${captureId}` });
  } catch (error) {
    if (error.issue === 'ORDER_NOT_APPROVED' || String(error.message).includes('ORDER_NOT_APPROVED')) {
      fail('  \u2717 PayPal says ORDER_NOT_APPROVED — the buyer has not approved this order yet.',
        '  Open the approve URL printed by `npm run paypal:check`, sign in as a SANDBOX BUYER, approve, then retry.\n');
    }
    fail(`  \u2717 Capture failed: ${error.issue ?? error.message}${error.debugId ? ` (debug ${error.debugId})` : ''}`);
  }
  const unit = response.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  console.log(`  order status           ${response.status}`);
  line('capture id', capture?.id);
  line('captured amount', capture ? `${capture.amount.value} ${capture.amount.currency_code} (${capture.status})` : 'n/a');
  line('custom_id', unit?.custom_id ?? '(missing — the backend would fail check V2)');
  line('payer email', response.payer?.email_address ?? '(none)');
  console.log('\n  This is the payload the backend verifies with checks V1–V7 before an order may be `paid`.');
  console.log('  Put the id in the app and re-run the journey, or paste the capture id into the demo.\n');
  process.exit(0);
}

// ── Default: create a real sandbox order ─────────────────────────────────────
const subtotalMinor = 87_900;
const shippingMinor = shippingFor(subtotalMinor, { env }).feeMinor;
const taxMinor = taxFor(subtotalMinor);
const syntheticOrder = {
  orderNumber: `SP-PREFLIGHT-${Date.now().toString(36).toUpperCase()}`,
  amounts: { currency: 'USD', subtotalMinor, shippingMinor, taxMinor, totalMinor: subtotalMinor + shippingMinor + taxMinor },
  lines: [{ title: 'Ascent Book 14 Pro', quantity: 1, unitPriceMinor: subtotalMinor, productId: 'preflight-product' }]
};

let created;
try {
  created = await gateway.createOrder({ order: syntheticOrder, requestId: `preflight-create-${syntheticOrder.orderNumber}` });
  ok(`created PayPal order ${created.id} (status ${created.status})`);
} catch (error) {
  fail(`  \u2717 createOrder failed: ${error.issue ?? error.message}${error.debugId ? ` (debug ${error.debugId})` : ''}`);
}

const fetched = await gateway.getOrder(created.id);
const approve = (fetched.links ?? []).find((l) => l.rel === 'approve' || l.rel === 'payer-action');
const unit = fetched.purchase_units?.[0];

console.log('\nOrder contents (what PayPal received)\n');
line('amount', `${unit?.amount?.value} ${unit?.amount?.currency_code}`);
line('expected total', `${toPayPalAmount(syntheticOrder.amounts.totalMinor)} USD (${formatMoney(syntheticOrder.amounts.totalMinor)})`);
line('custom_id', unit?.custom_id ?? '(missing — check V2 would fail)');
line('invoice_id', unit?.invoice_id ?? '(missing)');
line('items', `${unit?.items?.length ?? 0}`);

const amountMatches = unit?.amount?.value === toPayPalAmount(syntheticOrder.amounts.totalMinor);
const refMatches = unit?.custom_id === syntheticOrder.orderNumber;
console.log('');
amountMatches ? ok('amount matches to the cent (verification V4 would pass)') : bad('amount mismatch — V4 would fail');
refMatches ? ok('custom_id round-trips (verification V2 would pass)') : bad('custom_id missing — V2 would fail');

console.log('\nNext step — approve as a sandbox buyer:\n');
console.log(`  ${approve?.href ?? '(no approve link returned)'}\n`);
console.log('  Then:  npm run paypal:check -- --capture ' + created.id + '\n');
console.log('  Sandbox buyer accounts live at developer.paypal.com → Testing Tools → Sandbox Accounts');
console.log('  (create a Personal/Buyer account — a merchant account cannot pay itself).\n');
