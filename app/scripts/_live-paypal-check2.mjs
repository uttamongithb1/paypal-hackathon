import { chromium } from 'playwright';
const BASE = 'https://paypal-hackathon.onrender.com';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-popup-blocking'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForSelector('.card-grid--catalogue .card', { timeout: 60000 });
await page.evaluate(async () => {
  const res = await fetch('/api/v1/products?limit=24', { credentials: 'include' });
  const data = await res.json();
  const p = data.items.filter(x => x.stock > 3).sort((a,b)=>a.priceMinor-b.priceMinor)[0];
  const csrf = document.cookie.split('; ').find(c => c.startsWith('csrf='))?.split('=')[1];
  await fetch('/api/v1/cart/items', { method:'POST', credentials:'include',
    headers: { 'content-type':'application/json', 'x-sp-csrf': decodeURIComponent(csrf ?? '') },
    body: JSON.stringify({ productId: p.id, quantity: 1 }) });
});
await page.click('#cart-button');
await page.waitForSelector('.address-field', { timeout: 20000 });
for (const [id, v] of Object.entries({
  'addr-name':'Aarav Sharma','addr-line1':'12 Brigade Road','addr-line2':'','addr-city':'San Jose',
  'addr-state':'California','addr-postalCode':'95131','addr-countryCode':'US' })) await page.fill(`#${id}`, v);
await page.click('#cart-foot .btn--primary');
await page.waitForURL('**/checkout/**', { timeout: 40000 });
await page.waitForSelector('iframe[title="PayPal"]', { timeout: 30000 });
await page.waitForTimeout(4000);
const box = await (await page.$('iframe[title="PayPal"]'))?.boundingBox();
const popupPromise = ctx.waitForEvent('page', { timeout: 45000 }).catch(() => null);
if (box) await page.mouse.click(box.x + box.width / 2, box.y + 40);
const popup = await popupPromise;
if (!popup) { console.log('NO POPUP'); await browser.close(); process.exit(0); }
await popup.waitForLoadState('domcontentloaded', { timeout: 45000 }).catch(()=>{});
await popup.waitForTimeout(5000);

// Type the buyer email and ask PayPal for the next step.
const emailBox = popup.locator('input[name="email"], input[type="email"], #email');
await emailBox.first().fill('sb-dgnhf53364000@personal.example.com');
await popup.waitForTimeout(800);
const nextBtn = popup.getByRole('button', { name: /next|continue/i }).first();
await nextBtn.click({ timeout: 20000 }).catch(e => console.log('next click failed:', e.message.slice(0,80)));
await popup.waitForTimeout(8000);
console.log('URL after email :', popup.url().slice(0, 160));
const t = await popup.evaluate(() => document.body?.innerText ?? '').catch(()=> '');
console.log('TEXT            :', t.replace(/\s+/g,' ').slice(0, 600));
await popup.screenshot({ path: '/home/user/audit/live-paypal-after-email.png' }).catch(()=>{});
await browser.close();
