/**
 * Visual check of the platform console in a real browser.
 * Not part of the suite (it needs a Chromium download) — a dev tool for verifying the page.
 *
 *   npx playwright install --with-deps chromium   # once
 *   node scripts/admin-console-shot.mjs [outfile]
 */
import { startServer, createClient } from '../tests/helpers/harness.mjs';
import { chromium } from 'playwright';

const out = process.argv[2] ?? '/tmp/admin-console.png';
const server = await startServer({ seed: 'catalogue' });
const { base } = server;

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-popup-blocking'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

// Sign in as the admin through the API, then hand the session cookie to the browser.
const client = createClient(base);
await client.guest();
await client.login('admin@demo.dev', 'Admin@12345');
const cookies = [...client.cookies.entries()].map(([name, value]) => ({ name, value, domain: '127.0.0.1', path: '/' }));
await context.addCookies(cookies);

await page.goto(`${base}/admin`, { waitUntil: 'networkidle', timeout: 45000 });
await page.waitForTimeout(1200);

const summary = await page.evaluate(() => {
  const kpis = [...document.querySelectorAll('#admin-body .kpi')].map((k) => ({
    label: k.querySelector('.kpi__label')?.textContent,
    value: k.querySelector('.kpi__value')?.textContent
  }));
  const tables = [...document.querySelectorAll('#admin-body table')].map((t) => ({
    headers: [...t.querySelectorAll('thead th')].map((th) => th.textContent),
    rows: t.querySelectorAll('tbody tr').length
  }));
  return {
    heading: document.querySelector('#admin-body h1')?.textContent ?? null,
    kpis,
    tables,
    bodyText: (document.querySelector('#admin-body')?.textContent ?? '').slice(0, 400)
  };
});

await page.screenshot({ path: out, fullPage: true });
await browser.close();
await server.stop();

console.log(JSON.stringify({ ...summary, errors }, null, 2));
if (errors.length) process.exitCode = 1;
