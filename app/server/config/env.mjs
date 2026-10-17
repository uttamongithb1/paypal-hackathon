/**
 * Environment loading + validation (fail fast with a readable list).
 * Docs: ../docs/env_setup.md §4
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Minimal .env loader (no dependency). Existing process.env wins. */
function loadDotEnv() {
  const file = path.join(appRoot, '.env');
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

const int = (key, fallback) => {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env ${key} must be an integer, got "${v}"`);
  return n;
};
const bool = (key, fallback) => {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};
const str = (key, fallback = '') => (process.env[key] ?? fallback);

/** "20/5m" → { limit: 20, windowMs: 300000 } */
export function parseRate(spec) {
  const m = /^(\d+)\/(\d+)(s|m|h)$/.exec(String(spec).trim());
  if (!m) throw new Error(`Invalid rate spec "${spec}" (expected e.g. 20/5m)`);
  const mult = { s: 1000, m: 60_000, h: 3_600_000 }[m[3]];
  return { limit: Number(m[1]), windowMs: Number(m[2]) * mult };
}

export const env = {
  nodeEnv: str('NODE_ENV', 'development'),
  isProd: str('NODE_ENV', 'development') === 'production',
  port: int('PORT', 4000),
  host: str('HOST', '0.0.0.0'),
  webOrigin: str('WEB_ORIGIN', 'http://localhost:4000'),
  logLevel: str('LOG_LEVEL', 'info'),
  appRoot,

  dataDir: path.resolve(appRoot, str('DATA_DIR', '.data')),
  mongoUri: str('MONGO_URI'),

  jwtSecret: str('JWT_SECRET', 'dev-only-change-me-32-bytes-minimum-secret'),
  accessTokenTtl: str('ACCESS_TOKEN_TTL', '15m'),
  refreshTokenTtl: str('REFRESH_TOKEN_TTL', '30d'),
  guestSessionTtl: str('GUEST_SESSION_TTL', '30d'),
  cookieName: str('SESSION_COOKIE_NAME', 'sid'),
  cookieSecure: bool('COOKIE_SECURE', false),
  piiHashPepper: str('PII_HASH_PEPPER', 'dev-only-pepper-change-me-before-production'),

  paypalMode: str('PAYPAL_MODE', 'simulator'),
  paypalClientId: str('PAYPAL_CLIENT_ID'),
  paypalClientSecret: str('PAYPAL_CLIENT_SECRET'),
  paypalEnv: str('PAYPAL_ENV', 'sandbox'),
  paypalWebhookId: str('PAYPAL_WEBHOOK_ID'),
  // Multi-merchant settlement (docs/payments_paypal.md · WIN_PLAN F1).
  //   single → one purchase unit, platform is the recipient (the historical behaviour)
  //   split  → one purchase unit per seller with `payee` (+ platform_fees when enabled)
  //   auto   → try split, fall back to single if PayPal refuses the capability, and say so
  paypalSettlement: str('PAYPAL_SETTLEMENT', 'auto'),
  platformFeeBps: int('PLATFORM_FEE_BPS', 500),
  paypalDisbursementMode: str('PAYPAL_DISBURSEMENT_MODE', 'INSTANT'),
  // Test/demo switch: make the simulator behave like a sandbox account that is NOT enabled for
  // multi-seller payments, so the `auto` fallback path is exercisable without real credentials.
  paypalSimSplitUnsupported: bool('PAYPAL_SIM_SPLIT_UNSUPPORTED', false),
  // Simulator only: the account can pay several sellers but cannot charge platform_fees — the state
  // a real self-serve sandbox account is usually in (PLATFORM_FEES_NOT_SUPPORTED).
  paypalSimFeesUnsupported: bool('PAYPAL_SIM_FEES_UNSUPPORTED', false),
  paypalTimeoutMs: int('PAYPAL_TIMEOUT_MS', 10_000),
  paymentMaxAttempts: int('PAYMENT_MAX_ATTEMPTS', 3),
  quoteTtlMinutes: int('QUOTE_TTL_MINUTES', 15),

  featureLiveLlm: bool('FEATURE_LIVE_LLM', false),
  llmBaseUrl: str('LLM_BASE_URL', 'https://api.openai.com/v1'),
  llmApiKey: str('LLM_API_KEY'),
  llmModel: str('LLM_MODEL', 'gpt-4.1-mini'),
  llmTemperature: Number(str('LLM_TEMPERATURE', '0.2')),
  // Declared so the submission can name the AI tool used (rules requirement) without reading code.
  llmProvider: str('LLM_PROVIDER', 'openai-compatible'),
  // Budgets from contracts/agent_tools.json `limits` — the loop is bounded on all three axes.
  llmMaxIterations: int('LLM_MAX_ITERATIONS', 6),
  llmPerCallTimeoutMs: int('LLM_PER_CALL_TIMEOUT_MS', 8000),
  llmTurnTimeoutMs: int('LLM_TURN_TIMEOUT_MS', 45000),
  llmMaxRetries: int('LLM_MAX_RETRIES', 1),
  budgetGraceBps: int('BUDGET_GRACE_BPS', 300),
  clarifyMaxQuestions: int('CLARIFY_MAX_QUESTIONS', 2),

  taxRateBps: int('TAX_RATE_BPS', 825),
  shippingFreeThresholdMinor: int('SHIPPING_FREE_THRESHOLD_MINOR', 50_000),
  shippingStandardMinor: int('SHIPPING_STANDARD_MINOR', 999),
  shippingSmallOrderMinor: int('SHIPPING_SMALL_ORDER_MINOR', 1499),
  maxCartLines: int('MAX_CART_LINES', 20),
  maxLineQty: int('MAX_LINE_QTY', 10),

  featureAnalytics: bool('FEATURE_ANALYTICS', true),
  featureGuestOrders: bool('FEATURE_GUEST_ORDERS', true),

  // Origins allowed to frame the app (CSP `frame-ancestors`). Empty in production → the app can
  // only be framed by itself; development defaults to the workspace preview proxy so the live
  // preview iframe can render it. Override with PREVIEW_EMBED_ORIGINS="https://a,https://b".
  previewEmbedOrigins: str(
    'PREVIEW_EMBED_ORIGINS',
    str('NODE_ENV', 'development') === 'production' ? '' : 'https://*.e2b.app'
  ).split(',').map((origin) => origin.trim()).filter(Boolean),

  rates: {
    chat: parseRate(str('RATE_CHAT', '60/5m')),
    auth: parseRate(str('RATE_AUTH', '20/15m')),
    checkout: parseRate(str('RATE_CHECKOUT', '30/5m')),
    payment: parseRate(str('RATE_PAYMENT', '30/5m')),
    global: parseRate(str('RATE_GLOBAL', '600/1m'))
  }
};

export const paypalBaseUrl = env.paypalEnv === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

/** Problems that must stop the process, with actionable messages. */
export function validateEnv() {
  const problems = [];
  if (env.jwtSecret.length < 32) problems.push('JWT_SECRET must be at least 32 characters.');
  if (env.piiHashPepper.length < 16) problems.push('PII_HASH_PEPPER must be at least 16 characters.');
  if (env.paypalMode === 'sandbox' && (!env.paypalClientId || !env.paypalClientSecret)) {
    problems.push('PAYPAL_MODE=sandbox requires PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (or use PAYPAL_MODE=simulator).');
  }
  if (env.featureLiveLlm && !env.llmApiKey) {
    problems.push('FEATURE_LIVE_LLM=true requires LLM_API_KEY (or leave it false to use the deterministic planner).');
  }
  if (env.paypalEnv === 'live' && env.nodeEnv !== 'production') {
    problems.push('PAYPAL_ENV=live is refused outside NODE_ENV=production (demo safety).');
  }
  if (env.isProd && !env.cookieSecure) problems.push('COOKIE_SECURE must be true in production.');
  return problems;
}

export default env;
