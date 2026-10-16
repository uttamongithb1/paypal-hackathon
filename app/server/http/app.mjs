/**
 * Express app assembly: security headers, static shop, API v1, error handling.
 */
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { authenticate, errorHandler, notFoundHandler, requestContext, csrfGuard } from './middleware.mjs';
import { registerRoutes } from './routes.mjs';
import env from '../config/env.mjs';
import logger from '../lib/logger.mjs';

export function createApp(container) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // Security headers (CSP allows the PayPal SDK in sandbox mode).
  // Framing: production stays un-embeddable. The workspace preview shows this app inside an iframe
  // on the proxy origin, so when embed origins are configured we omit X-Frame-Options (which the
  // browser would otherwise enforce even alongside frame-ancestors) and allow them in the CSP.
  const embedders = env.previewEmbedOrigins;
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (!embedders.length) res.set('X-Frame-Options', 'SAMEORIGIN');
    res.set(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self' https://www.paypal.com https://www.sandbox.paypal.com",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "connect-src 'self' https://api-m.sandbox.paypal.com https://api-m.paypal.com",
        "frame-src https://www.paypal.com https://www.sandbox.paypal.com",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self' https://www.paypal.com",
        `frame-ancestors 'self'${embedders.length ? ` ${embedders.join(' ')}` : ''}`
      ].join('; ')
    );
    next();
  });

  app.use(requestContext(container.store));
  app.use(express.json({ limit: '256kb' }));
  app.use(authenticate(container.session));
  app.use(csrfGuard());

  // JSON body parsing must not swallow the PayPal webhook's raw body.
  app.use((req, _res, next) => {
    if (req.path === '/api/v1/webhooks/paypal') req.body = req.rawBody ?? req.body;
    next();
  });

  registerRoutes(app, container);

  // Static shop (single-page app). Deep links fall back to index.html.
  const shopDir = path.join(env.appRoot, 'shop');
  if (fs.existsSync(shopDir)) {
    app.use(express.static(shopDir, { extensions: ['html'], maxAge: env.isProd ? '1h' : 0 }));
    app.get(/^\/(?!api\/).*/, (req, res, next) => {
      if (req.method !== 'GET') return next();
      if (req.path.includes('.')) return next();
      return res.sendFile(path.join(shopDir, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => res.type('text/plain').send('ShopPilot AI API is running. Build the shop UI in app/shop/.'));
  }

  app.use(notFoundHandler());
  app.use(errorHandler());
  logger.debug('app.created', { shopDir });
  return app;
}

export default createApp;
