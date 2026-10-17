/**
 * The LLM diagnostics endpoint.
 *
 * Why this exists: when a live turn degrades, the shopper sees "the model did not answer" and the
 * operator sees a log line. Neither tells you whether the key is wrong, the base URL is wrong, or
 * the model name is real but not available on this plan — all three produce a 404 from providers
 * like Groq that say only "does not exist or you do not have access to it".
 *
 * Asking the provider for its model list settles it. These tests pin that behaviour against a
 * stand-in provider so the endpoint cannot silently start lying.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from '../helpers/harness.mjs';

/** A stand-in provider carrying the model catalogue of a standard (non-Enterprise) key. */
function mockProvider(models) {
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const CATALOGUE = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant'];

test('a model the key cannot reach is reported as unavailable, with the list it can reach', async () => {
  const provider = await mockProvider(CATALOGUE);
  const base = `http://127.0.0.1:${provider.address().port}/openai/v1`;
  const app = await startServer({
    seed: 'catalogue',
    env: { FEATURE_LIVE_LLM: 'true', LLM_API_KEY: 'gsk_test', LLM_BASE_URL: base, LLM_MODEL: 'llama-3.3-70b-versatile' }
  });
  try {
    const body = await (await fetch(`${app.base}/api/v1/diagnostics/llm`)).json();
    assert.equal(body.configured, true);
    assert.equal(body.ok, false);
    assert.equal(body.modelAvailable, false);
    assert.match(body.note, /cannot call/i);
    assert.deepEqual(body.availableModels, [...CATALOGUE].sort());
    // The key must never be echoed back, in any form.
    assert.equal(JSON.stringify(body).includes('gsk_test'), false);
  } finally {
    await app.stop();
    provider.close();
  }
});

test('a model the key can reach is reported as available', async () => {
  const provider = await mockProvider(CATALOGUE);
  const base = `http://127.0.0.1:${provider.address().port}/openai/v1`;
  const app = await startServer({
    seed: 'catalogue',
    env: { FEATURE_LIVE_LLM: 'true', LLM_API_KEY: 'gsk_test', LLM_BASE_URL: base, LLM_MODEL: 'openai/gpt-oss-20b' }
  });
  try {
    const body = await (await fetch(`${app.base}/api/v1/diagnostics/llm`)).json();
    assert.equal(body.ok, true);
    assert.equal(body.modelAvailable, true);
  } finally {
    await app.stop();
    provider.close();
  }
});

test('with the live model switched off it says so instead of pretending', async () => {
  const app = await startServer({ seed: 'catalogue', env: { FEATURE_LIVE_LLM: 'false' } });
  try {
    const body = await (await fetch(`${app.base}/api/v1/diagnostics/llm`)).json();
    assert.equal(body.configured, false);
    assert.match(body.note, /deterministic planner/i);
  } finally {
    await app.stop();
  }
});

test('/version names the model the server will actually call', async () => {
  const provider = await mockProvider(CATALOGUE);
  const base = `http://127.0.0.1:${provider.address().port}/openai/v1`;
  const app = await startServer({
    seed: 'catalogue',
    env: { FEATURE_LIVE_LLM: 'true', LLM_API_KEY: 'gsk_test', LLM_BASE_URL: base, LLM_MODEL: 'openai/gpt-oss-20b' }
  });
  try {
    const body = await (await fetch(`${app.base}/api/v1/version`)).json();
    assert.equal(body.llm.live, true);
    assert.equal(body.llm.model, 'openai/gpt-oss-20b');
  } finally {
    await app.stop();
    provider.close();
  }
});
