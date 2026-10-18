#!/usr/bin/env node
/**
 * Reset the local store to the documented demo state.
 *   npm run reset                  → wipe and re-seed (catalogue, users, order history, analytics)
 *   npm run reset -- --demo-orders → also create three orders through the payment flow
 *                                   (simulator only — in sandbox mode it would create real
 *                                   PayPal sandbox orders, so the seed refuses to do it)
 *
 * The reset is a local operation. It never calls a payment provider: the order history is
 * written straight into the store, and the payment-routed demo orders are an explicit opt-in
 * that the seeder itself refuses when the instance is pointed at the real sandbox.
 */
import { buildContainer } from '../server/container.mjs';
import { seedAll, summary } from './seed-lib.mjs';

const args = process.argv.slice(2);
const demoOrders = args.includes('--demo-orders');

const container = await buildContainer();
const result = await seedAll(container, { demoOrders, history: true, analytics: true });
await container.store.flush();

console.log('\n  ShopPilot AI — store reset\n');
console.log(`  products    ${result.products.length}`);
console.log(`  orders      ${result.history?.orders ?? 0} in history${result.demo ? ' + 3 through the payment flow' : ''}`);
console.log(`  analytics   ${result.analyticsCount} events`);
console.log(`  collections ${summary(container.store)}\n`);
process.exit(0);
