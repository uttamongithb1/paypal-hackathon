#!/usr/bin/env node
/**
 * Seed the demo store.
 *   npm run seed                  → catalogue + demo users + order history + synthetic analytics
 *   npm run seed -- --no-history  → catalogue + demo users + analytics, but no past orders
 *   npm run seed -- --demo-orders → also create three orders through the payment flow
 *                                   (simulator only — it would make real PayPal calls in sandbox mode)
 *   npm run seed -- --no-analytics
 *
 * The default is the same state a hosted instance boots into: a shop with a past. Without the
 * history the merchant dashboard shows $0.00 revenue beside products marked as sold, which is
 * exactly the contradiction the history exists to remove.
 */
import { buildContainer } from '../server/container.mjs';
import { seedAll, summary } from './seed-lib.mjs';

const args = process.argv.slice(2);
const demoOrders = args.includes('--demo-orders');
const withAnalytics = !args.includes('--no-analytics');
const withHistory = !args.includes('--no-history');

const container = await buildContainer();
const result = await seedAll(container, { demoOrders, history: withHistory, analytics: withAnalytics });

console.log('\n  ShopPilot AI — seed complete\n');
console.log(`  merchants   ${Object.keys(result.merchants).length}`);
console.log(`  categories  ${Object.keys(result.categories).length}`);
console.log(`  products    ${result.products.length}`);
console.log(`  orders      ${result.history?.orders ?? 0} in history${result.demo ? ` + ${result.demo.paid ? 3 : 0} through the payment flow` : ''}`);
console.log(`  analytics   ${result.analyticsCount} synthetic events`);
if (result.demo) {
  console.log(`              paid: ${result.demo.paid?.orderNumber} · retried: ${result.demo.failed?.orderNumber} · awaiting payment: ${result.demo.awaiting?.orderNumber}`);
}
console.log(`\n  collections ${summary(container.store)}\n`);
console.log('  Demo logins:');
console.log('    customer@demo.dev / Customer@12345');
console.log('    merchant@demo.dev / Merchant@12345   (merchant role)');
console.log('    admin@demo.dev    / Admin@12345\n');
await container.store.flush();
process.exit(0);
