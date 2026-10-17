/**
 * Test harness: boots a real server process with its own throwaway store, seeds the catalogue and
 * exposes a small HTTP client (cookies + CSRF handled) plus an SSE chat reader.
 *
 * Every test file gets its own port and DATA_DIR, so files can run concurrently and never touch
 * the developer's `.data/db.json`.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const appRoot = path.resolve(here, '..', '..');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForReady(base, timeoutMs = 20_000) {
  const started = Date.now();
  for (;;) {
    try {
      // Liveness, not readiness: a server that is up but degraded (PayPal unreachable) is still
      // a running server, and a test may be about exactly that.
      const res = await fetch(`${base}/api/v1/healthz`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > timeoutMs) throw new Error(`Server did not become ready at ${base}`);
    await wait(120);
  }
}

export function runScript(script, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(appRoot, 'scripts', script), ...args], {
      cwd: appRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${script} exited ${code}\n${stdout}\n${stderr}`))));
  });
}

/**
 * Ask the OS for a port that is actually free.
 *
 * Guessing a random port in a fixed range made the suite flaky: test files run concurrently and a
 * file that starts several servers (split-settlement.test.mjs does) could collide, which failed
 * every test on that instance with "did not become ready". Binding port 0 and reading back the
 * assignment removes the guesswork.
 */
async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Start a server on an ephemeral port with a fresh store, then seed it. */
export async function startServer({ seed = 'catalogue', env = {} } = {}) {
  // env.dataDir is resolved relative to the app root, so use a run-scoped relative folder and
  // clean it up afterwards (never touches the developer's .data/db.json).
  const runDir = `.data-test/${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  const dataDir = path.join(appRoot, runDir);
  fs.mkdirSync(dataDir, { recursive: true });
  const port = await freePort();
  const childEnv = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: runDir,
    PAYPAL_MODE: 'simulator',
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'error',
    ...env
  };

  // Seed BEFORE the server loads the store: the file store is read into memory at boot, so
  // seeding afterwards would need POST /api/v1/dev/store/reload.
  if (seed === 'catalogue') await runScript('seed.mjs', [], childEnv);
  if (seed === 'demo') await runScript('seed.mjs', ['--demo-orders'], childEnv);

  const child = spawn(process.execPath, [path.join(appRoot, 'server', 'index.mjs')], {
    cwd: appRoot,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', (chunk) => {
    log += chunk;
  });
  child.stderr.on('data', (chunk) => {
    log += chunk;
  });


  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForReady(base);
  } catch (error) {
    child.kill('SIGKILL');
    throw new Error(`${error.message}\n--- server output ---\n${log}`);
  }

  const client = createClient(base);
  return {
    base,
    env: childEnv,
    dataDir,
    child,
    log: () => log,
    client,
    async stop() {
      child.kill('SIGTERM');
      await wait(150);
      child.kill('SIGKILL');
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(path.join(appRoot, runDir), { recursive: true, force: true });
    }
  };
}

/** HTTP client with cookie jar + CSRF header, mirroring what the browser does. */
export function createClient(base) {
  const cookies = new Map();
  const header = () => [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
  const absorb = (res) => {
    for (const cookie of res.headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === '') cookies.delete(name);
      else cookies.set(name, value);
    }
  };

  async function call(path, { method = 'GET', body, headers = {}, csrf = true } = {}) {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        cookie: header(),
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
      json = { raw: text };
    }
    return { status: res.status, body: json, headers: res.headers };
  }

  /** POST /chat/stream and collect every frame. */
  async function chat(message) {
    const res = await fetch(`${base}/api/v1/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: header(), 'x-sp-csrf': cookies.get('csrf') ?? '' },
      body: JSON.stringify({ message, clientMessageId: `test-${Date.now()}-${Math.random().toString(16).slice(2)}` })
    });
    if (!res.ok) throw new Error(`chat failed ${res.status}: ${await res.text()}`);
    const frames = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';
      for (const chunk of chunks) {
        const event = /^event: (.+)$/m.exec(chunk);
        const data = /^data: (.*)$/m.exec(chunk);
        if (event && data) frames.push({ event: event[1], data: JSON.parse(data[1]) });
      }
    }
    return {
      frames,
      tools: frames.filter((f) => f.event === 'tool.activity' && f.data.status === 'done').map((f) => f.data.tool),
      components: frames.filter((f) => f.event === 'ui.component').map((f) => f.data.component),
      text: frames.filter((f) => f.event === 'message.delta').map((f) => f.data.text).join(''),
      end: frames.find((f) => f.event === 'message.end')?.data ?? null,
      error: frames.find((f) => f.event === 'error')?.data ?? null
    };
  }

  return {
    base,
    cookies,
    call,
    chat,
    guest: () => call('/session/guest', { method: 'POST', csrf: false }),
    login: (email, password) => call('/auth/login', { method: 'POST', body: { email, password } }),
    me: () => call('/session/me')
  };
}

/** Convenience: a seeded customer or merchant session. */
export async function asCustomer(base) {
  const client = createClient(base);
  await client.guest();
  await client.login('customer@demo.dev', 'Customer@12345');
  return client;
}

/** A brand-new registered customer: unique email, empty cart, isolated orders. */
export async function asNewCustomer(base, label = 'test') {
  const client = createClient(base);
  await client.guest();
  const email = `${label}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}@example.com`;
  const registered = await client.call('/auth/register', { method: 'POST', body: { email, password: 'TestPassw0rd!', displayName: 'Integration Tester' } });
  if (registered.status !== 201) throw new Error(`register failed: ${registered.status} ${JSON.stringify(registered.body)}`);
  return client;
}

export async function asMerchant(base) {
  const client = createClient(base);
  await client.guest();
  await client.login('merchant@demo.dev', 'Merchant@12345');
  return client;
}

export const DEMO = {
  customer: { email: 'customer@demo.dev', password: 'Customer@12345' },
  merchant: { email: 'merchant@demo.dev', password: 'Merchant@12345' },
  admin: { email: 'admin@demo.dev', password: 'Admin@12345' }
};
