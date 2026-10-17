/**
 * Origin allow-list.
 *
 * This guard is defence in depth behind the CSRF token, so it must reject genuinely cross-site
 * requests without being told every URL the app will ever be served from. It previously only
 * accepted a single WEB_ORIGIN, which meant a fresh deployment answered every browser request with
 * "Origin not allowed" — surfacing in the UI as "Cannot reach the ShopPilot API", i.e. it looked
 * like an outage rather than a config mistake.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedOrigin } from '../../server/http/middleware.mjs';

const req = (headers = {}) => ({ get: (name) => headers[name.toLowerCase()], hostname: headers.host });
const DEPLOYED = 'https://paypal-hackathon.onrender.com';

describe('isAllowedOrigin', () => {
  test("allows the deployment's own origin", () => {
    assert.equal(isAllowedOrigin(DEPLOYED, req({ host: 'paypal-hackathon.onrender.com' })), true);
  });

  test('allows it when only X-Forwarded-Host names the public host', () => {
    const headers = { host: '10.0.0.5:8080', 'x-forwarded-host': 'paypal-hackathon.onrender.com' };
    assert.equal(isAllowedOrigin(DEPLOYED, req(headers)), true);
  });

  test('ignores a port on either side', () => {
    assert.equal(isAllowedOrigin('https://shop.example', req({ host: 'shop.example:443' })), true);
  });

  test('refuses a different site', () => {
    assert.equal(isAllowedOrigin('https://evil.example', req({ host: 'paypal-hackathon.onrender.com' })), false);
  });

  test('refuses a lookalike subdomain — the classic phishing shape', () => {
    assert.equal(isAllowedOrigin('https://paypal-hackathon.evil.example', req({ host: 'paypal-hackathon.onrender.com' })), false);
  });

  test('still allows localhost for development', () => {
    assert.equal(isAllowedOrigin('http://localhost:5173', req({ host: 'localhost:4000' })), true);
  });

  test('refuses a malformed Origin rather than throwing', () => {
    assert.equal(isAllowedOrigin('not-a-url', req({ host: 'x' })), false);
  });
});
