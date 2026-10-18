/**
 * Dev-only: drive the real checkout in a browser — fill the delivery address, place the order,
 * and check the checkout page shows where the parcel is going.
 *
 *   npx playwright install --with-deps chromium   # once
 *   node scripts/checkout-address-shot.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const PORT = process.env.PORT || '4123';
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.resolve('/home/user/audit');
mkdirSync(OUT, { recursive: true });

const child = spawn(process.execPath, ['server/index.mjs'], {
  env: { ...process.env, PORT, HOST: '127.0.0.1', PAYPAL_MODE: 'simulator', FEATURE_LIVE_LLM: 'false', LLM_API_KEY: '', NODE_ENV: 'development' },
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

for (let i = 0; i < 60; i++) {
  try {
    const res = await fetch(`${BASE}/api/v1/healthz`);
    if (res.ok) break;
  } catch { /* not up yet */ }
  await sleep(500);
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

const posted = [];
page.on('request', (r) => { if (r.url().endsWith('/api/v1/orders') && r.method() === 'POST') posted.push(r.postData()); });

const ADDRESS = {
  'addr-name': 'Aarav Sharma',
  'addr-line1': '12 Brigade Road',
  'addr-line2': 'Flat 402',
  'addr-city': 'Gorakhpur',
  'addr-state': 'Uttar Pradesh',
  'addr-postalCode': '273001',
  'addr-countryCode': 'IN'
};

await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForSelector('.card-grid--catalogue .card');

await page.evaluate(async () => {
  const res = await fetch('/api/v1/products?limit=24', { credentials: 'include' });
  const data = await res.json();
  // The cheapest product with stock: the point of this run is the checkout, not the basket value.
  const product = data.items.filter((p) => p.stock > 3).sort((a, b) => a.priceMinor - b.priceMinor)[0];
  const csrf = document.cookie.split('; ').find((c) => c.startsWith('csrf='))?.split('=')[1];
  await fetch('/api/v1/cart/items', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', 'x-sp-csrf': decodeURIComponent(csrf ?? '') },
    body: JSON.stringify({ productId: product.id, quantity: 1 })
  });
});
await page.click('#cart-button');
await page.waitForSelector('.address-field');

for (const [id, value] of Object.entries(ADDRESS)) {
  await page.fill(`#${id}`, value);
}
await page.screenshot({ path: path.join(OUT, 'cart-address.png') });

const fieldsAtClick = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.address-field input')].map((i) => [i.id, i.value])));
await page.click('#cart-foot .btn--primary');
await page.waitForURL('**/checkout/**', { timeout: 20000 });
await page.waitForTimeout(1200);

const delivery = await page.evaluate(() => {
  const text = document.querySelector('#checkout-body')?.textContent ?? '';
  const match = text.match(/Delivering to\s*(.+?)(?:What happens|$)/s);
  return match ? match[1].replace(/\s+/g, ' ').trim() : null;
});
const orderPath = await page.evaluate(() => location.pathname);
await page.screenshot({ path: path.join(OUT, 'checkout-delivery.png') });

// Coming back from PayPal without a completed approval has to say so in plain language.
await page.goto(`${BASE}${orderPath}?from=paypal&cancelled=1`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
const returnNote = await page.evaluate(() => {
  const callout = [...document.querySelectorAll('#checkout-body .callout--warning')][0];
  return callout?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
});
await page.screenshot({ path: path.join(OUT, 'checkout-paypal-return.png') });

await browser.close();
child.kill('SIGTERM');

console.log('fields at click  :', JSON.stringify(fieldsAtClick));
console.log('posted body      :', posted[0] ?? 'none');
console.log('delivery line    :', delivery);
console.log('paypal return note:', returnNote);
console.log('console errors   :', errors.length ? errors : 'none');

const ok = Boolean(delivery) && delivery.includes('Brigade Road') && Boolean(returnNote) && errors.length === 0;
console.log(ok ? '✓ the delivery address reaches the checkout page, and a cancelled PayPal return explains itself' : '✗ something did not reach the checkout page');
process.exit(ok ? 0 : 1);
