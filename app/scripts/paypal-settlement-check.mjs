/**
 * Multi-seller settlement capability probe — the honest answer to "can this PayPal account
 * actually pay several sellers in one order?"
 *
 *   npm run paypal:settlement                  → try a real 2-seller sandbox order, report the truth
 *   npm run paypal:settlement -- --capture <id> → after a buyer approves, show the per-seller captures
 *
 * WHY THIS EXISTS
 * `payee` and `payment_instruction.platform_fees` are gated behind the "PayPal Complete Payments
 * Platform for Marketplaces and Platforms" capability (PARTNER_FEE). A standard self-serve sandbox
 * app — especially one made from a *personal/individual* account — often cannot use them, and
 * PayPal answers with MSP_NOT_SUPPORTED / an unsupported-payment-instruction error. Reporting a
 * split that never happened would be dishonest, so the app falls back to a single unit and says so
 * (see payment.service.mjs `createWithSettlement`). This script tells you which case you are in,
 * for YOUR account, before you record a demo.
 *
 * The documented multi-seller flow also requires a **business** account: create the sandbox app
 * while logged in as a Business sandbox account, not an Individual one.
 *
 * Docs: ../docs/payments_paypal.md · WIN_PLAN.md §4 F1
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPaypalGateway } from '../server/payments/paypal.gateway.mjs';
import env, { paypalBaseUrl } from '../server/config/env.mjs';
import { settlementPlan } from '../server/payments/settlement.mjs';
import { taxFor, shippingFor, formatMoney, toPayPalAmount } from '../server/lib/money.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1] ?? null;
};

const line = (label, value) => console.log(`  ${String(label).padEnd(22)} ${value}`);
const ok = (msg) => console.log(`  \u2713 ${msg}`);
const bad = (msg) => console.log(`  \u2717 ${msg}`);
const warn = (msg) => console.log(`  ! ${msg}`);

console.log('\nPayPal multi-seller settlement probe\n');
line('endpoint', paypalBaseUrl);
line('mode', env.paypalMode);
line('configured', `PAYPAL_SETTLEMENT=${env.paypalSettlement} PLATFORM_FEE_BPS=${env.platformFeeBps} PAYPAL_DISBURSEMENT_MODE=${env.paypalDisbursementMode}`);

// The simulator is a first-class mode, so the probe still runs end to end against it — the analysis
// below is exercised on every dev machine. It simply cannot say anything about a real account, and
// says so. Only PAYPAL_MODE=sandbox with real credentials produces evidence about the capability.
const simulated = env.paypalMode !== 'sandbox';
if (simulated) {
  console.log('  SIMULATED — this result describes the local simulator, not your PayPal account.');
  console.log('  Run with PAYPAL_MODE=sandbox + credentials for evidence about the real capability.\n');
}

if (!simulated && (!env.paypalClientId || !env.paypalClientSecret)) {
  console.error('\n  PAYPAL_MODE=sandbox needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.');
  console.error("  developer.paypal.com → Apps & Credentials → Sandbox → your app\n");
  console.error('  Use a BUSINESS sandbox account to create the app: the multi-seller flow is not');
  console.error('  available to individual accounts.\n');
  process.exit(1);
}

const gateway = createPaypalGateway();
line('client id', `${env.paypalClientId.slice(0, 12)}…`);

// ── 1. OAUTH ────────────────────────────────────────────────────────────────
console.log('\nStep 1 — credentials\n');
if (simulated) {
  ok('skipped: simulator, no credentials needed (and no request leaves this machine)');
} else {
  try {
    const token = await gateway.accessToken();
    ok(`OAuth2 client_credentials → token ${token.slice(0, 8)}… (${Math.round((gateway.tokenExpiresAt - Date.now()) / 1000)}s)`);
  } catch (error) {
    bad(`OAuth failed: ${error.issue ?? error.message}`);
    console.error('\n  Check the credentials belong to the SANDBOX app, and that the account is a business one.\n');
    process.exit(1);
  }
}

// ── 2. LOAD THE PAYEES THE APP WOULD USE ────────────────────────────────────
const catalogue = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'data', 'seed.catalog.json'), 'utf8'));
const payable = (catalogue.merchants ?? []).filter((m) => m.payeeEmail && m.paypalMerchantId);
if (payable.length < 2) {
  console.error('\n  Need at least two merchants with payeeEmail + paypalMerchantId in data/seed.catalog.json.\n');
  process.exit(1);
}

const merchants = Object.fromEntries(payable.slice(0, 2).map((m, i) => [`m${i + 1}`, { name: m.name, payeeEmail: m.payeeEmail, paypalMerchantId: m.paypalMerchantId }]));

// A synthetic two-seller order — the same shape settlementPlan() receives in production.
const lines = [
  { merchantId: 'm1', title: 'Ascent Book 14 Pro', unitPriceMinor: 87_900, quantity: 1, productId: 'probe-1' },
  { merchantId: 'm2', title: 'Pulse 5 Pro', unitPriceMinor: 62_800, quantity: 1, productId: 'probe-2' }
];
const subtotalMinor = lines.reduce((sum, l) => sum + l.unitPriceMinor * l.quantity, 0);
const shippingMinor = shippingFor(subtotalMinor, { env }).feeMinor;
// taxFor needs the configured rate — passing it alone returned NaN, which made this script
// report a mismatch against a perfectly good account.
const taxMinor = taxFor(subtotalMinor, env.taxRateBps);
const order = {
  orderNumber: `SP-PROBE-${Date.now().toString(36).toUpperCase()}`,
  amounts: { currency: 'USD', subtotalMinor, shippingMinor, taxMinor, totalMinor: subtotalMinor + shippingMinor + taxMinor },
  lines
};

const plan = settlementPlan(order, { merchants, mode: 'split', platformFeeBps: env.platformFeeBps });
console.log('\nStep 2 — local plan (what we would send)\n');
line('mode', plan.mode);
for (const unit of plan.units) {
  line(`unit ${unit.referenceId}`, `${formatMoney(unit.amountMinor)} → ${unit.payee.emailAddress} (fee ${formatMoney(unit.platformFeeMinor)})`);
}
line('sum check', `${plan.units.reduce((s, u) => s + u.amountMinor, 0)} === ${order.amounts.totalMinor} total`);

// ── 3. ASK PAYPAL TO CREATE IT ──────────────────────────────────────────────
console.log('\nStep 3 — PayPal Orders v2 create with `payee` + `platform_fees`\n');
let created = null;
let rejection = null;
try {
  created = await gateway.createOrder({ order, plan, requestId: `probe-create-${order.orderNumber}` });
  ok(`accepted — PayPal order ${created.id} (status ${created.status})`);
} catch (error) {
  rejection = error;
  bad(`rejected — ${error.issue ?? error.message}${error.debugId ? ` (debug ${error.debugId})` : ''}`);
}

// ── 4. READ IT BACK: DID THE MONEY GO WHERE WE SAID? ────────────────────────
let verdict = 'unknown';
if (created) {
  const fetched = await gateway.getOrder(created.id);
  const units = fetched.purchase_units ?? [];
  console.log('\nStep 4 — read back what PayPal actually stored\n');
  line('purchase units', units.length);
  let payeesSeen = 0;
  let feesSeen = 0;
  for (const unit of units) {
    const payee = unit.payee?.email_address ?? '(none — PayPal assumes the API CALLER’s account)';
    const fee = unit.payment_instruction?.platform_fees?.[0]?.amount?.value;
    const disbursement = unit.payment_instruction?.disbursement_mode;
    line(`unit ${unit.reference_id ?? '-'}`, `${unit.amount?.value} ${unit.amount?.currency_code} → ${payee}`);
    if (unit.payee?.email_address) payeesSeen += 1;
    if (fee) feesSeen += 1;
    if (payee !== '(none — PayPal assumes the API CALLER’s account)') {
      line('  disbursement', disbursement ?? '(default)');
      line('  platform fee', fee ? `${fee} ${unit.amount?.currency_code}` : '(none returned)');
    }
  }

  if (units.length >= 2 && payeesSeen === units.length && feesSeen === units.length) {
    verdict = 'split';
    console.log('');
    ok('this account supports multi-seller settlement: one order, one unit per seller,');
    ok('each with a payee and a platform fee.');
    console.log('\n  Next: approve as a sandbox BUYER, then read back the per-seller captures:');
    const approve = (fetched.links ?? []).find((l) => l.rel === 'approve' || l.rel === 'payer-action');
    console.log(`    ${approve?.href ?? '(no approve link returned)'}`);
    console.log(`    npm run paypal:settlement -- --capture ${created.id}\n`);
  } else if (units.length >= 2 && payeesSeen === 0) {
    verdict = 'no-payee';
    console.log('');
    warn('PayPal accepted the order but did not echo any `payee` back.');
    warn('That means this account is NOT paying the sellers — the platform account would receive');
    warn('the money. Treat `PAYPAL_SETTLEMENT=split` as unsupported here and ship the honest single-unit');
    warn('path instead (PAYPAL_SETTLEMENT=auto falls back automatically).');
  } else {
    verdict = 'partial';
    console.log('');
    warn(`partial support: ${units.length} units, ${payeesSeen} payees, ${feesSeen} platform fees.`);
    warn('Do not claim a split settlement in the demo unless every unit shows a payee.');
  }
} else {
  const reason = rejection?.issue ?? rejection?.message ?? 'unknown';
  const isCapability = ['SPLIT_SETTLEMENT_UNSUPPORTED', 'PAYMENT_INSTRUCTION_NOT_SUPPORTED', 'MSP_NOT_SUPPORTED', 'NOT_ENABLED_FOR_PAYPAL_COMPLETE_PAYMENTS', 'PERMISSION_DENIED'].includes(reason);
  console.log('\nStep 4 — verdict\n');
  if (isCapability) {
    verdict = 'unsupported';
    warn(`this account is not enabled for multi-seller payments (${reason}).`);
    console.log('');
    console.log('  That is a capability limit, not a bug in the app. What to do:');
    console.log('    • keep PAYPAL_SETTLEMENT=auto — the app falls back to a single unit, records the');
    console.log('      reason on the order timeline, and completes the payment normally;');
    console.log('    • to try again for the capability, make sure the sandbox app belongs to a BUSINESS');
    console.log('      account (developer.paypal.com → Sandbox Accounts → create Business), then request');
    console.log('      the Marketplaces/Complete Payments capability on that app;');
    console.log('    • in the demo, show the fallback being stated out loud. An honest fallback that names');
    console.log('      the limitation is stronger than a faked multi-seller screenshot.');
  } else {
    verdict = 'error';
    bad(`create failed for a different reason: ${reason}`);
    console.log('\n  That is not (demonstrably) a capability limit — fix the error before drawing conclusions.');
  }
}

// ── Optional: per-seller captures after buyer approval ──────────────────────
async function reportCaptures(paypalOrderId) {
  const response = await gateway.captureOrder(paypalOrderId, { requestId: `probe-capture-${paypalOrderId}` });
  const units = response.purchase_units ?? [];
  const captures = units.flatMap((u) => u.payments?.captures ?? []);
  console.log(`\n  order status           ${response.status}`);
  line('purchase units', units.length);
  line('captures', captures.length);
  for (const [i, capture] of captures.entries()) {
    line(`capture ${i + 1}`, `${capture.amount.value} ${capture.amount.currency_code} (${capture.status}) → ${units[i]?.payee?.email_address ?? 'caller account'}`);
  }
  const sum = captures.reduce((s, c) => s + Math.round(Number(c.amount.value) * 100), 0);
  line('sum', `${sum} =? ${order.amounts.totalMinor} expected`);
  console.log(sum === order.amounts.totalMinor
    ? '\n  \u2713 every seller was captured and the parts still add up to the order total.\n'
    : '\n  \u2717 captured total does not match the order — do not mark an order paid on this.\n');
}
const captureId = flagValue('capture');
if (captureId) {
  console.log('Step 5 — capturing (the app does exactly this in POST /payments/:orderId/capture)\n');
  if (simulated) {
    warn('the simulator keeps its orders in memory for one process only, so an id from a previous');
    warn('run cannot be found here (RESOURCE_NOT_FOUND). The simulator flow is exercised in one go');
    warn('below instead — re-run without --capture.');
  } else {
    try {
      await reportCaptures(captureId);
    } catch (error) {
      if (String(error.issue ?? error.message).includes('ORDER_NOT_APPROVED')) {
        console.error('  ORDER_NOT_APPROVED — open the approve URL as a sandbox buyer first.\n');
      } else {
        console.error(`  capture failed: ${error.issue ?? error.message}\n`);
      }
      process.exit(1);
    }
  }
}

// In simulator mode, walk the whole flow in this one process so the per-seller capture output is
// exercised on every dev machine (and so nobody mistakes a stale id for a capability problem).
if (simulated && created) {
  console.log('Step 5 — simulated capture, per seller\n');
  try {
    await reportCaptures(created.id);
  } catch (error) {
    console.error(`  simulated capture failed: ${error.issue ?? error.message}\n`);
  }
}

console.log(`verdict: ${verdict}`);
if (simulated) console.log('(simulated — run in sandbox mode for a verdict about your real account)');
console.log('');
process.exit(0);
