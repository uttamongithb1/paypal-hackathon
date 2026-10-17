/**
 * Entry point: validate env → build container → assemble app → listen → schedule maintenance jobs.
 * Docs: ../docs/architecture.md §5, ../docs/env_setup.md §5
 */
import env, { validateEnv } from './config/env.mjs';
import logger from './lib/logger.mjs';
import { buildContainer } from './container.mjs';
import { createApp } from './http/app.mjs';

const problems = validateEnv();
if (problems.length) {
  logger.error('env.invalid', { problems });
  process.stderr.write(`\nShopPilot AI cannot start:\n${problems.map((p) => `  • ${p}`).join('\n')}\n\nSee docs/env_setup.md §4.\n`);
  process.exit(1);
}

const container = await buildContainer();

// Self-seeding for hosted environments. Ephemeral disks (Render, Cloud Run, any free tier) start
// empty, and an empty store serves an empty shop. Seeding only when the catalogue is missing keeps
// restarts cheap and never overwrites a store that already has data.
if (env.seedOnBoot) {
  const products = container.store.collection('products').find({});
  if (products.length === 0) {
    const started = Date.now();
    const { seedAll } = await import('../scripts/seed-lib.mjs');
    // No demo orders on boot: generating them runs through the real payment path, which would make
    // live PayPal calls (and stall) on a host configured for sandbox mode. `history` writes the same
    // orders straight into the store instead — the shop opens with a past (revenue, sold counts and
    // the funnel all derived from the same orders) without a single network call.
    const result = await seedAll(container, { demoOrders: false, history: true, analytics: true });
    await container.store.flush();
    logger.info('store.seeded', {
      reason: 'empty store on boot', products: result.products.length,
      merchants: Object.keys(result.merchants).length, ms: Date.now() - started
    });
  }
}

const app = createApp(container);

// Maintenance jobs: expire holds/orders, reconcile stuck payments, sweep TTLs.
const JOB_INTERVAL_MS = 60_000;
const jobTimer = setInterval(() => {
  try {
    const expiredOrders = container.payment.expireStaleOrders();
    const swept = container.store.sweepExpired();
    if (expiredOrders || Object.keys(swept).length) logger.info('jobs.tick', { expiredOrders, swept });
  } catch (err) {
    logger.error('jobs.failed', { error: err.message });
  }
}, JOB_INTERVAL_MS);
jobTimer.unref?.();

const reconcileTimer = setInterval(async () => {
  try {
    const result = await container.payment.reconcile({});
    if (result.checked) logger.info('jobs.reconcile', result);
  } catch (err) {
    logger.error('jobs.reconcile.failed', { error: err.message });
  }
}, 5 * JOB_INTERVAL_MS);
reconcileTimer.unref?.();

const server = app.listen(env.port, env.host, () => {
  const mode = !env.featureLiveLlm ? 'deterministic planner (no LLM key needed)' : `live model ${env.llmModel}`;
  logger.info('server.listening', { url: `http://${env.host}:${env.port}`, env: env.nodeEnv, paypal: container.payment.gateway.mode, agent: mode });
  process.stdout.write(
    [
      '',
      '  ShopPilot AI',
      `  → shop      http://localhost:${env.port}/`,
      `  → api       http://localhost:${env.port}/api/v1`,
      `  → health    http://localhost:${env.port}/api/v1/readyz`,
      `  payments    ${container.payment.gateway.mode}${container.payment.gateway.mode === 'simulator' ? ' (no real PayPal calls — see docs/env_setup.md §5 to switch)' : ''}`,
      `  agent       ${mode}`,
      ''
    ].join('\n')
  );
});

const shutdown = async (signal) => {
  logger.info('server.shutdown', { signal });
  server.close();
  await container.store.flush();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app, container, server };
