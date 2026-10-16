#!/usr/bin/env node
/**
 * Seed the demo database.
 *   pnpm seed                  → catalogue + demo users + synthetic analytics
 *   pnpm seed -- --demo-orders → also generates demo orders through the real payment flow
 *   pnpm seed -- --no-analytics
 */
import { buildContainer } from '../server/container.mjs';
import { seedAll, summary } from './seed-lib.mjs';

const args = process.argv.slice(2);
const demoOrders = args.includes('--demo-orders');
const withAnalytics = !args.includes('--no-analytics');

const container = await buildContainer();
const result = await seedAll(container, { demoOrders, analytics: withAnalytics });

console.log('\n  ShopPilot AI — seed complete\n');
console.log(`  merchants   ${Object.keys(result.merchants).length}`);
console.log(`  categories  ${Object.keys(result.categories).length}`);
console.log(`  products    ${result.products.length}`);
console.log(`  analytics   ${result.analyticsCount} synthetic events`);
if (result.demo) {
  console.log(`  orders      paid: ${result.demo.paid?.orderNumber} · retried: ${result.demo.failed?.orderNumber} · awaiting payment: ${result.demo.awaiting?.orderNumber}`);
}
console.log(`\n  collections ${summary(container.store)}\n`);
console.log('  Demo logins:');
console.log('    customer@demo.dev / Customer@12345');
console.log('    merchant@demo.dev / Merchant@12345   (merchant role)');
console.log('    admin@demo.dev    / Admin@12345\n');
await container.store.flush();
process.exit(0);
