/**
 * Ids, tokens, hashing and cookie signing — all on node:crypto (no dependencies).
 * Password hashing: scrypt here; production target is argon2id (../docs/security_privacy.md §2).
 */
import crypto from 'node:crypto';
import env from '../config/env.mjs';

/** 24-hex id, same shape as a Mongo ObjectId so the shapes in docs/data_model.md line up. */
export const objectId = () => crypto.randomBytes(12).toString('hex');

export const uuid = () => crypto.randomUUID();
export const requestId = () => `r_${crypto.randomBytes(8).toString('hex')}`;
export const sessionId = () => `s_${crypto.randomBytes(16).toString('base64url')}`;
export const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export const sha256 = (input) => crypto.createHash('sha256').update(input).digest('hex');
export const hmac = (key, input) => crypto.createHmac('sha256', key).update(input).digest('hex');

/** Stable hash of an object (sorted keys) — used for quote hashes and request fingerprints. */
export function stableHash(value) {
  const seen = new WeakSet();
  const normalise = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return '[circular]';
    seen.add(v);
    if (Array.isArray(v)) return v.map(normalise);
    return Object.keys(v)
      .sort()
      .reduce((acc, k) => {
        acc[k] = normalise(v[k]);
        return acc;
      }, {});
  };
  return sha256(JSON.stringify(normalise(value)));
}

/** Salted, truncated hash for PII we must correlate but not store (payer email). */
export const hashPii = (value) => hmac(env.piiHashPepper, String(value || '')).slice(0, 32);

export const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

// ── Passwords (scrypt) ──────────────────────────────────────────────────────
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const N = 16384;
  const hash = crypto.scryptSync(password, salt, 32, { N, r: 8, p: 1 });
  return `scrypt$${N}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(hashB64, 'base64url');
    const actual = crypto.scryptSync(password, salt, expected.length, { N: Number(N), r: 8, p: 1 });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/** Weak-password gate (zxcvbn would be the production check). */
export function passwordProblems(password) {
  const problems = [];
  if (typeof password !== 'string' || password.length < 10) problems.push('Use at least 10 characters.');
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) problems.push('Mix upper and lower case letters.');
  if (!/\d/.test(password)) problems.push('Include at least one number.');
  if (/^(password|123456|qwerty|letmein)/i.test(password)) problems.push('Avoid common passwords.');
  return problems;
}

// ── JWT (HS256) ─────────────────────────────────────────────────────────────
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const ttlMs = (spec) => {
  const m = /^(\d+)(s|m|h|d)$/.exec(spec);
  if (!m) throw new Error(`Bad TTL "${spec}"`);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
};

export function signJwt(payload, ttl = env.accessTokenTtl) {
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ ...payload, iss: 'shoppilot-api', aud: 'shoppilot-web', exp: Math.floor((Date.now() + ttlMs(ttl)) / 1000) });
  return `${header}.${body}.${hmac(env.jwtSecret, `${header}.${body}`)}`;
}

export function verifyJwt(tokenString) {
  const parts = String(tokenString || '').split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  if (!safeEqual(hmac(env.jwtSecret, `${header}.${body}`), sig)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp * 1000 < Date.now()) return { ...payload, expired: true };
    return payload;
  } catch {
    return null;
  }
}

// ── Signed cookie (for the session id) ──────────────────────────────────────
export const signCookie = (value) => `${value}.${hmac(env.jwtSecret, value).slice(0, 24)}`;
export function unsignCookie(signed) {
  const raw = String(signed || '');
  const idx = raw.lastIndexOf('.');
  if (idx === -1) return null;
  const value = raw.slice(0, idx);
  return safeEqual(signCookie(value), raw) ? value : null;
}
