/**
 * Visual check of the platform console in a real browser.
 * Not part of the suite (it needs a Chromium download) — a dev tool for verifying the page.
 *
 *   node scripts/admin-console-shot.mjs [outfile]
 */
import { startServer, createClient } from '../tests/helpers/harness.mjs';

// Puppeteer is not a dependency of this project — it is a heavy, developer-only tool. Install it
// on demand: npm i puppeteer --no-save
let puppeteer;
try {
  ({ default: puppeteer } = await import('puppeteer'));
} catch {
  console.error('This script needs Puppeteer, which is not installed:\n  npm i puppeteer --no-save');
  process.exit(2);
}

const out = process.argv[2] ?? '/tmp/admin-console.png';
const server = await startServer({ seed: 'catalogue' });
const { base } = server;

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-popup-blocking']
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

// Sign in as the admin through the API, then hand the session cookie to the browser.
const client = createClient(base);
await client.guest();
await client.login('admin@demo.dev', 'Admin@12345');
for (const [name, value] of client.cookies.entries()) {
  await page.setCookie({ name, value, domain: '127.0.0.1', path: '/' });
}

await page.goto(`${base}/admin`, { waitUntil: 'networkidle2', timeout: 45000 });
await new Promise((r) => setTimeout(r, 1200));

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
