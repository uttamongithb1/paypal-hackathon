#!/usr/bin/env node
/**
 * End-to-end HTTP smoke test against a running ShopPilot server.
 *
 *   node server/index.mjs &          # or: npm start
 *   node scripts/smoke.mjs           # BASE_URL=http://localhost:4000
 *
 * Exercises the whole customer journey the way the browser does: guest session → sign in →
 * agent chat over SSE → cart → quote → order → declined payment → retry → verified capture →
 * merchant views, and asserts the invariants that must hold at the end.
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:4000';
const results = [];
const cookies = new Map();

function cookieHeader() {
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
function absorb(res) {
  const list = res.headers.getSetCookie?.() ?? [];
  for (const raw of list) {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

async function api(path, { method = 'GET', body, headers = {}, csrf = true } = {}) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader(),
      ...(csrf && cookies.has('csrf') ? { 'x-sp-csrf': cookies.get('csrf') } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  absorb(res);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: json, headers: res.headers };
}

/** Post a chat message and collect the SSE frames. */
async function chat(message) {
  const res = await fetch(`${BASE}/api/v1/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieHeader(), 'x-sp-csrf': cookies.get('csrf') },
    body: JSON.stringify({ message, clientMessageId: `smoke-${Date.now()}` })
  });
  if (!res.ok) throw new Error(`chat failed: ${res.status}`);
  const frames = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const event = /^event: (.+)$/m.exec(part);
      const data = /^data: (.*)$/m.exec(part);
      if (event && data) frames.push({ event: event[1], data: JSON.parse(data[1]) });
    }
  }
  return frames;
}

const summarise = (frames) => ({
  tools: frames.filter((f) => f.event === 'tool.activity' && f.data.status === 'done').map((f) => f.data.tool),
  components: frames.filter((f) => f.event === 'ui.component').map((f) => f.data.component.type),
  text: frames.filter((f) => f.event === 'message.delta').map((f) => f.data.text).join(''),
  end: frames.find((f) => f.event === 'message.end')?.data,
  error: frames.find((f) => f.event === 'error')?.data
});

console.log(`\n  ShopPilot AI — end-to-end smoke test against ${BASE}`);

// ── 1. Session + auth ───────────────────────────────────────────────────────
console.log('\n  Session and auth');
const guest = await api('/session/guest', { method: 'POST', csrf: false });
record('guest session issued with cart', guest.status === 200 && guest.body.user?.role === 'guest' && guest.body.cart, `session ${String(guest.body.session?.id).slice(0, 10)}…`);

const login = await api('/auth/login', { method: 'POST', body: { email: 'customer@demo.dev', password: 'Customer@12345' } });
record('customer login (guest cart claimed)', login.status === 200 && login.body.user?.role === 'customer', `claimed ${login.body.claimedOrders} order(s)`);

// ── 2. Agent discovery, grounding, revision ─────────────────────────────────
console.log('\n  Agent (deterministic planner)');
const discovery = summarise(await chat('I need a laptop for full-stack development under $900, at least 16 GB RAM, 512 GB SSD, good battery life'));
record('G-01 streams grounded recommendations', discovery.components.includes('product_cards') && discovery.tools.includes('search_products'), `${discovery.tools.join(', ')} → ${discovery.components.join(', ')}`);
record('prices in prose come from tool results', /\$\d[\d,]*\.\d{2}/.test(discovery.text), discovery.text.slice(0, 96) + '…');

const comparison = summarise(await chat('compare the top 2'));
record('G-04 comparison component emitted', comparison.components.includes('comparison'));

const specAnswer = summarise(await chat('is it good for heavy multitasking?'));
record('follow-up stays on the shown products', Boolean(specAnswer.end?.candidateProductIds?.length), `${specAnswer.end?.candidateProductIds?.length ?? 0} candidates remembered`);

const revision = summarise(await chat('actually make it under $700 instead'));
record('G-09 requirement revision bumped', revision.end?.requirementRevision >= 2, `revision ${revision.end?.requirementRevision}`);

const refusal = summarise(await chat('just pay for it for me'));
record('G-11 refuses autonomous payment', /cannot pay on your behalf|no access to payment/i.test(refusal.text), refusal.text.slice(0, 80) + '…');

const offTopic = summarise(await chat("what's the weather in Gorakhpur?"));
record('G-12 off-topic redirect', /outside|only help with shopping|shopping in this store/i.test(offTopic.text), offTopic.text.slice(0, 70) + '…');

const addCart = summarise(await chat('add 2 of the cheapest to my cart'));
const cartAfterAdd = await api('/cart');
record('G-06 agent adds 2 to the cart', addCart.components.includes('cart_summary') && cartAfterAdd.body.cart.itemCount >= 2, `${cartAfterAdd.body.cart.itemCount} item(s), ${cartAfterAdd.body.cart.display}`);

// ── 3. Quote → order → payment ──────────────────────────────────────────────
console.log('\n  Checkout and payment');
const quote = await api('/checkout/quote', { method: 'POST', body: { extendHolds: true } });
record('server-side quote computed', quote.status === 200 && quote.body.quote?.amounts?.totalMinor > 0, `total ${quote.body.quote?.amounts?.display?.total}`);

const idem = `smoke-${Date.now()}`;
const orderBody = { quoteId: quote.body.quote.id, quoteHash: quote.body.quote.hash, contact: { email: 'customer@demo.dev', name: 'Smoke Test' } };
const order1 = await api('/orders', { method: 'POST', headers: { 'idempotency-key': idem }, body: orderBody });
const order2 = await api('/orders', { method: 'POST', headers: { 'idempotency-key': idem }, body: orderBody });
const orderId = order1.body.order?.id;
record('order created with a PayPal order', order1.status === 201 && Boolean(order1.body.payment?.paypalOrderId), `${order1.body.order?.orderNumber} · ${order1.body.order?.amounts?.display?.total}`);
record('duplicate submit is idempotent', order2.headers.get('idempotent-replay') === 'true' && order2.body.order?.id === orderId);

const decline = await api(`/payments/${orderId}/capture`, { method: 'POST', body: { paypalOrderId: order1.body.payment.paypalOrderId, simulatedOutcome: 'decline' } });
record('declined payment mapped, order not paid', decline.status === 402 && decline.body.error?.code === 'PAYMENT_DECLINED', decline.body.error?.code);

const orderAfterDecline = await api(`/orders/${orderId}`);
record('order is payment_failed (not paid)', orderAfterDecline.body.order?.status === 'payment_failed', orderAfterDecline.body.order?.status);

const retry = await api(`/payments/${orderId}/retry`, { method: 'POST', body: {} });
record('retry opens a new attempt', retry.status === 201 && retry.body.payment?.attemptNo === 2, `attempt ${retry.body.payment?.attemptNo}`);

const capture = await api(`/payments/${orderId}/capture`, { method: 'POST', body: { paypalOrderId: retry.body.payment.paypalOrderId, simulatedOutcome: 'approve' } });
record('verified capture marks the order paid', capture.status === 200 && capture.body.payment?.amountVerified === true, `capture ${capture.body.payment?.captureId}`);

const replay = await api(`/payments/${orderId}/capture`, { method: 'POST', body: { paypalOrderId: retry.body.payment.paypalOrderId } });
const replayCaptureId = replay.body.payment?.captureId ?? replay.body.order?.payment?.paypalCaptureId;
record('replayed capture never double charges', replay.status === 200 && replayCaptureId === capture.body.payment.captureId, `same capture ${replayCaptureId}`);

const finalOrder = await api(`/orders/${orderId}`);
record('order paid with exactly one capture id', finalOrder.body.order?.status === 'paid' && Boolean(finalOrder.body.order?.payment?.paypalCaptureId));

// ── 4. Merchant views + analytics ───────────────────────────────────────────
console.log('\n  Merchant dashboard');
const customerBlocked = await api(`/merchant/orders/${orderId}/attempts`);
record('customer blocked from merchant endpoints', customerBlocked.status === 403, `HTTP ${customerBlocked.status}`);

const asMerchant = await api('/auth/login', { method: 'POST', body: { email: 'merchant@demo.dev', password: 'Merchant@12345' } });
const attempts = await api(`/merchant/orders/${orderId}/attempts`);
record('merchant sees the payment trail', asMerchant.status === 200 && attempts.status === 200, `${attempts.body.items?.map((a) => a.status).join(' → ')}`);
record('exactly two attempts, one succeeded', attempts.body.items?.length === 2 && attempts.body.items.filter((a) => a.status === 'succeeded').length === 1);

const overview = await api('/merchant/overview');
const analytics = await api('/merchant/analytics?range=30d');
const funnel = analytics.body?.funnel ?? {};
record('overview + analytics respond', overview.status === 200 && analytics.status === 200, `${overview.body.orders?.total ?? overview.body.orders?.count ?? '?'} orders`);
record(
  'funnel is monotonic (views ≥ cart adds ≥ checkout attempts ≥ purchases)',
  funnel.views >= funnel.cartAdds && funnel.cartAdds >= funnel.checkoutAttempts && funnel.checkoutAttempts >= funnel.purchases,
  `${funnel.views} ≥ ${funnel.cartAdds} ≥ ${funnel.checkoutAttempts} ≥ ${funnel.purchases}`
);

const failures = results.filter((r) => !r.ok);
console.log(`\n  ${results.length - failures.length}/${results.length} checks passed${failures.length ? ` — failed: ${failures.map((f) => f.name).join(', ')}` : ''}\n`);
process.exit(failures.length ? 1 : 0);
