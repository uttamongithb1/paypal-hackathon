/**
 * Liveness and readiness are different questions.
 *
 * `/api/v1/readyz` answers "is every dependency working?" and returns 503 when PayPal is
 * unreachable. `/api/v1/healthz` answers "is this process serving?" and always returns 200 while
 * it is. They used to be the same endpoint, and the host health-checked the deep one — so a
 * PayPal sandbox hiccup would have taken the whole storefront down and shown a judge a 503 page
 * instead of a shop.
 *
 * These tests pin the split, and pin the storefront being told the truth about it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from '../helpers/harness.mjs';

/** A stand-in for PayPal: refuses to authenticate, which is what an outage looks like. */
function fakePaypalServer() {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/v1/oauth2/token')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_client', error_description: 'Client Authentication failed' }));
      return;
    }
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name: 'INTERNAL_SERVER_ERROR' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

const fake = await fakePaypalServer();
const degraded = await startServer({
  seed: 'catalogue',
  env: {
    PAYPAL_MODE: 'sandbox',
    PAYPAL_CLIENT_ID: 'not-a-real-id',
    PAYPAL_CLIENT_SECRET: 'not-a-real-secret',
    PAYPAL_API_BASE_URL: fake.base
  }
});

test.after(async () => {
  await degraded.stop();
  fake.server.close();
});

test('healthz stays 200 while the process serves, even with PayPal down', async () => {
  const res = await fetch(`${degraded.base}/api/v1/healthz`);
  assert.equal(res.status, 200, 'the storefront must stay up when a dependency is down');
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.paypal, 'down', 'but it must say that PayPal is down');
});

test('readyz reports 503 when PayPal cannot authenticate', async () => {
  const res = await fetch(`${degraded.base}/api/v1/readyz`);
  assert.equal(res.status, 503, 'readiness is the deep check and must fail honestly');
  const body = await res.json();
  assert.equal(body.status, 'degraded');
  assert.equal(body.paypal, 'down');
});

test('the storefront is told PayPal is down, so it can say so before the shopper hits checkout', async () => {
  const res = await fetch(`${degraded.base}/api/v1/version`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.paypalHealth, 'down');
  assert.equal(body.paypalMode, 'sandbox');
});

test('the default test server never touches a provider', async () => {
  // The harness pins these, so a developer running the suite with a real app/.env still gets a
  // hermetic run — no PayPal call, no model call, no secret from the developer's machine.
  const plain = await startServer({ seed: 'catalogue' });
  try {
    const res = await fetch(`${plain.base}/api/v1/version`);
    const body = await res.json();
    assert.equal(body.paypalMode, 'simulator', 'the suite must not talk to a real PayPal account');
    assert.equal(body.llm.live, false, 'the suite must not call a real model');
    assert.equal(body.paypalClientId, null, 'no client id may leak in from the environment');
  } finally {
    await plain.stop();
  }
});
