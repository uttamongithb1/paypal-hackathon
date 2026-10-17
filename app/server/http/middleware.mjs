/**
 * HTTP middleware: request context, cookies, auth resolution, CSRF, rate limiting, error mapping.
 * Docs: ../docs/security_privacy.md §4–7
 */
import { ApiError, errorBody } from '../lib/errors.mjs';
import { requestId as newRequestId, signCookie, unsignCookie } from '../lib/crypto.mjs';
import env from '../config/env.mjs';
import logger from '../lib/logger.mjs';

const parseCookies = (header = '') =>
  Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const idx = part.indexOf('=');
        return [decodeURIComponent(part.slice(0, idx)), decodeURIComponent(part.slice(idx + 1))];
      })
  );

export function requestContext(store) {
  return (req, res, next) => {
    req.requestId = req.get('x-request-id') || newRequestId();
    req.cookies = parseCookies(req.headers.cookie);
    res.set('x-request-id', req.requestId);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      if (req.path.startsWith('/api')) {
        logger.debug('http', {
          requestId: req.requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Number(durationMs.toFixed(1)),
          sessionId: req.auth?.session?._id
        });
      }
    });
    next();
  };
}

export function setSessionCookie(res, sessionId) {
  const value = signCookie(sessionId);
  res.cookie(env.cookieName, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.cookieSecure,
    maxAge: 30 * 24 * 3600 * 1000,
    path: '/'
  });
  return value;
}

export function clearSessionCookie(res) {
  res.clearCookie(env.cookieName, { path: '/' });
}

/** Resolve auth from cookie + bearer token; creates nothing (guest creation is explicit). */
export function authenticate(sessionService) {
  return (req, _res, next) => {
    try {
      const bearer = (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '') || undefined;
      const sid = unsignCookie(req.cookies[env.cookieName]);
      req.auth = { ...sessionService.authenticate({ sessionCookieValue: sid, bearerToken: bearer }), bearer };
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function csrfGuard() {
  return (req, res, next) => {
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return next();
    if (req.path.startsWith('/api/v1/webhooks')) return next();
    const cookieToken = req.cookies['csrf'];
    const headerToken = req.get('x-sp-csrf');
    if (!cookieToken) {
      // No established session yet (first call) — the guest bootstrap sets the token.
      if (req.path === '/api/v1/session/guest') return next();
      return next(new ApiError('FORBIDDEN', 'Missing CSRF cookie. Reload the page and try again.', { status: 403 }));
    }
    if (!headerToken || headerToken !== cookieToken) {
      return next(new ApiError('FORBIDDEN', 'CSRF token mismatch.', { status: 403 }));
    }
    const origin = req.get('origin');
    if (origin && !isAllowedOrigin(origin, req)) {
      return next(new ApiError('FORBIDDEN', 'Origin not allowed.', { status: 403 }));
    }
    return next();
  };
}

/**
 * Is this Origin allowed to make a state-changing request?
 *
 * The CSRF defence proper is the double-submit token above; this is defence in depth, so it should
 * reject *cross-site* requests without needing to be told every URL the app will ever be served
 * from. Pinning it to a single WEB_ORIGIN meant a deployment failed until someone remembered to set
 * one more variable — and it failed with "Cannot reach the ShopPilot API", which reads like an
 * outage rather than a config mistake.
 *
 * Allowed: same-origin (Origin matches the Host this request arrived on), any origin listed in
 * WEB_ORIGIN (comma-separated), the platform-injected RENDER_EXTERNAL_URL, and localhost for dev.
 * Everything else — a genuinely different site — is still refused.
 */
export function isAllowedOrigin(origin, req) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  // Same-origin: the browser said where the page came from, and it is the host we were reached on.
  // Behind a load balancer the public hostname arrives in X-Forwarded-Host (Render, Fly, Cloud Run)
  // as well as Host, so consider every host the request plausibly names.
  const hosts = new Set(
    [req.get('host'), req.get('x-forwarded-host')?.split(',')[0]?.trim(), req.hostname]
      .filter(Boolean)
      .map((h) => String(h).replace(/:\d+$/, ''))   // X-Forwarded-Host has no port; Host may
  );
  const originHost = parsed.host.replace(/:\d+$/, '');
  if (hosts.has(originHost)) return true;

  const configured = [env.webOrigin, process.env.RENDER_EXTERNAL_URL]
    .filter(Boolean)
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter(Boolean);
  if (configured.some((value) => value === origin.replace(/\/$/, ''))) return true;

  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/** Fixed-window rate limiter keyed by session (falling back to IP). */
export function rateLimit(classSpec) {
  const buckets = new Map();
  // One bucket per session-or-IP, kept forever: the map only reset counters in place, so a shop
  // open for judging week accumulated an entry for every visitor and never released one. Sweep
  // expired buckets opportunistically instead of every request — O(n) but rare, and it bounds the
  // map to the sessions active inside one window.
  let lastSweep = Date.now();
  const sweep = (now) => {
    if (now - lastSweep < 60_000) return;
    lastSweep = now;
    for (const [key, bucket] of buckets) if (now > bucket.resetAt) buckets.delete(key);
  };
  return (req, res, next) => {
    const now = Date.now();
    sweep(now);
    const key = `${classSpec}-${req.auth?.session?._id ?? req.ip}`;
    const bucket = buckets.get(key) ?? { count: 0, resetAt: now + classSpec.windowMs };
    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + classSpec.windowMs;
    }
    bucket.count += 1;
    buckets.set(key, bucket);
    res.set('RateLimit-Limit', String(classSpec.limit));
    res.set('RateLimit-Remaining', String(Math.max(0, classSpec.limit - bucket.count)));
    res.set('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > classSpec.limit) {
      res.set('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return next(new ApiError('RATE_LIMITED', 'Too many requests — please slow down for a moment.', { status: 429 }));
    }
    return next();
  };
}

export function notFoundHandler() {
  return (req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).json(errorBody(new ApiError('NOT_FOUND', 'Unknown endpoint.'), req.requestId));
    return res.status(404).send('Not found');
  };
}

export function errorHandler() {
  return (err, req, res, _next) => {
    const body = errorBody(err, req.requestId);
    if (body.error.code === 'INTERNAL') {
      logger.error('http.unhandled', { requestId: req.requestId, path: req.path, error: err.message, stack: env.nodeEnv === 'development' ? err.stack : undefined });
    }
    res.status(err.status ?? 500).json(body);
  };
}

export const cookieHelpers = { parseCookies };
