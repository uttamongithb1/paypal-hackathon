#!/usr/bin/env node
/**
 * Prints the live demo script with the current environment's facts (paypal mode, sandbox buyers,
 * seeded state) so a presenter can rehearse. Companions: docs/demo_script.md, docs/runbooks.md.
 */
import { buildContainer } from '../server/container.mjs';
import env from '../server/config/env.mjs';
import { formatMoney } from '../server/lib/money.mjs';

const container = await buildContainer();
const { store, catalogue } = container;
const products = store.collection('products');
const orders = store.collection('orders');

const laptop = products.findOne({ slug: 'ascent-book-14-pro' });
const paidOrders = orders.find({ status: 'paid' });
const failedOrders = orders.find({ status: 'payment_failed' });

const line = (text = '') => console.log(text);
line('\n  ShopPilot AI — demo rehearsal script (≈10 minutes)\n');
line(`  Environment   ${env.nodeEnv} · paypal=${container.payment.gateway.mode}${container.payment.gateway.mode === 'simulator' ? ' (declines simulated via the Sandbox buyer selector on checkout)' : ''}`);
line(`  Agent         ${env.featureLiveLlm ? `live model ${env.llmModel}` : 'deterministic planner (no API key needed)'}`);
line(`  Catalogue     ${products.count({ status: 'active' })} active products · demo laptops from ${formatMoney(Math.min(...products.find({ categoryId: catalogue.category('laptops')?._id }).map((p) => p.priceMinor)))}`);
line(`  Orders        ${paidOrders.length} paid · ${failedOrders.length} failed (retryable)\n`);

line('  1. Open the shop and paste this request:');
line('       "I need a laptop for full-stack development under $900, with at least 16 GB RAM,');
line('        a 512 GB SSD, and good battery life"');
line('     Expect: requirement chips, then 4 real products (Ascent Book 14 Pro $879, Ascent Book 14 $729,');
line('     NovaBook Air 13 $649, NovaBook Studio 15 $899) with pros/cons and why-it-fits lines.\n');
line('  2. Ask for "a good laptop" in a fresh chat → exactly one budget question with quick replies.\n');
line('  3. Say "compare the top two" → comparison rows; then ask "does the cheaper one have a 2 TB SSD option?"');
line('     Expect a grounded answer or "not specified" — never an invented option.\n');
line('  4. Say "actually make it under $700 and lighter than 1.4 kg" → revision 2, old cards marked superseded.\n');
line('  5. Say "add 2 of the NovaBook Air 13 to my cart" → cart updates from the server; subtotal is real.\n');
line('  6. Say "just pay for it for me" → the agent refuses: it has no payment tool. Show contracts/agent_tools.json.\n');
line('  7. Press Checkout → summary (subtotal, shipping, tax 8.25%, total) + Approve & Pay.\n');
line('  8. Approve & Pay with "Sandbox buyer: approves" → order paid, capture id shown, merchant dashboard updated.');
line('  9. Repeat with "declines" → payment_failed + Retry payment; retry with approve → same order, two attempts, one charge.\n');
line(' 10. Merchant view → set a price/stock, then ask the agent about that product: it reports the new truth.\n');

if (paidOrders.length) {
  const order = paidOrders[0];
  line(`  Seeded paid order: ${order.orderNumber} · ${formatMoney(order.amounts.totalMinor)} · capture ${order.payment?.paypalCaptureId ?? 'n/a'}`);
}
line('\n  Runbooks for failures: ../docs/runbooks.md   ·   Full script: ../docs/demo_script.md\n');
process.exit(0);
