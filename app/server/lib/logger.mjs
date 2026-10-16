/**
 * Structured JSON logger with redaction.
 * Docs: ../docs/architecture.md §7, ../docs/security_privacy.md §8
 */
import env from '../config/env.mjs';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const threshold = LEVELS[env.logLevel] ?? LEVELS.info;

const REDACT_KEYS = [
  'password', 'passwordhash', 'token', 'accesstoken', 'refreshtoken', 'authorization', 'cookie',
  'clientsecret', 'paypal_client_secret', 'apikey', 'secret', 'email', 'payeremail', 'cardnumber', 'cvv'
];

function redact(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') {
    if (typeof value === 'string' && /^\d{13,19}$/.test(value.replace(/[\s-]/g, ''))) return '[redacted:card-like]';
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACT_KEYS.includes(k.toLowerCase().replace(/[_-]/g, '')) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

function emit(level, msg, fields = {}) {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...redact(fields) });
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const logger = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
  child: (base) => ({
    debug: (m, f) => emit('debug', m, { ...base, ...f }),
    info: (m, f) => emit('info', m, { ...base, ...f }),
    warn: (m, f) => emit('warn', m, { ...base, ...f }),
    error: (m, f) => emit('error', m, { ...base, ...f })
  })
};

export default logger;
