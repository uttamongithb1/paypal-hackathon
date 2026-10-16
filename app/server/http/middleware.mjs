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
    if (origin && origin !== env.webOrigin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return next(new ApiError('FORBIDDEN', 'Origin not allowed.', { status: 403 }));
    }
    return next();
  };
}

/** Fixed-window rate limiter keyed by session (falling back to IP). */
export function rateLimit(classSpec) {
  const buckets = new Map();
  return (req, res, next) => {
    const now = Date.now();
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
