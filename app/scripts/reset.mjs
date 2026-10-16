#!/usr/bin/env node
/**
 * Reset the demo database to a known-good state (drops everything, then seeds).
 *   pnpm reset -- --demo-orders
 */
import { buildContainer } from '../server/container.mjs';
import { seedAll, summary } from './seed-lib.mjs';

const args = process.argv.slice(2);
const demoOrders = args.includes('--demo-orders') || true; // reset always produces a demo-ready DB

const container = await buildContainer();
const result = await seedAll(container, { demoOrders, analytics: true });
await container.store.flush();

console.log('\n  ShopPilot AI — database reset\n');
console.log(`  products    ${result.products.length}`);
console.log(`  orders      ${result.demo ? 3 : 0} demo orders (paid, retried-to-paid, awaiting payment)`);
console.log(`  analytics   ${result.analyticsCount} events`);
console.log(`  collections ${summary(container.store)}\n`);
process.exit(0);
