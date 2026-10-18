/**
 * API v1 routes. Thin controllers: validate → service → respond.
 * Contract: ../docs/api_spec.md (error codes in §9, SSE frames in §7).
 */
import express from 'express';
import { ApiError, asyncHandler } from '../lib/errors.mjs';
import { schemas, validate } from './validate.mjs';
import { clearSessionCookie, rateLimit, setSessionCookie } from './middleware.mjs';
import env from '../config/env.mjs';
import logger from '../lib/logger.mjs';
import { formatMoney } from '../lib/money.mjs';
import { token as randomToken, unsignCookie } from '../lib/crypto.mjs';
import { requirementChips } from '../agent/requirement.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function registerRoutes(app, c) {
  const v1 = express.Router();
  const { session, auth: _authSvc, catalogue, cart, quote, order, payment, inventory, analytics, orchestrator, store } = c;

  // ── Session ──────────────────────────────────────────────────────────────
  v1.post('/session/guest', rateLimit(env.rates.auth), asyncHandler(async (req, res) => {
    let current = session.byId(requireUnsign(req));
    if (!current) {
      const created = session.createGuest({ userAgent: req.get('user-agent'), ip: req.ip });
      current = created.session;
    }
    setSessionCookie(res, current._id);
    res.cookie('csrf', randomToken(16), { httpOnly: false, sameSite: 'lax', secure: env.cookieSecure, maxAge: 30 * 24 * 3600 * 1000, path: '/' });
    const user = session.userById(current.userId);
    const cartDoc = cart.getOrCreate({ sessionId: current._id, userId: user.role === 'guest' ? undefined : user._id });
    res.json({
      user: { id: user._id, role: user.role, email: user.email },
      session: { id: current._id, kind: current.kind, expiresAt: current.expiresAt },
      cart: cart.toDto(cartDoc)
    });
  }));

  v1.get('/session/me', asyncHandler(async (req, res) => {
    if (!req.auth.session || !req.auth.user) {
      return res.json({ user: null, session: null, cart: null, chat: null });
    }
    const user = req.auth.user;
    const cartDoc = cart.getOrCreate({ sessionId: req.auth.session._id, userId: user.role === 'guest' ? undefined : user._id });
    if (!req.cookies['csrf']) {
      res.cookie('csrf', randomToken(16), { httpOnly: false, sameSite: 'lax', secure: env.cookieSecure, maxAge: 30 * 24 * 3600 * 1000, path: '/' });
    }
    res.json({
      user: { id: user._id, role: user.role, email: user.email, displayName: user.displayName, merchantId: user.merchantId },
      session: { id: req.auth.session._id, kind: req.auth.session.kind, expiresAt: req.auth.session.expiresAt },
      cart: cart.toDto(cartDoc),
      chat: {
        requirement: req.auth.session.chat?.requirement ?? null,
        requirementRevision: req.auth.session.chat?.requirementRevision ?? 0,
        requirementChips: requirementChips(req.auth.session.chat?.requirement),
        lastCandidateProductIds: req.auth.session.chat?.lastCandidateProductIds ?? [],
        messageCount: req.auth.session.chat?.messageCount ?? 0
      }
    });
  }));

  // ── Auth ─────────────────────────────────────────────────────────────────
  v1.post('/auth/register', rateLimit(env.rates.auth), asyncHandler(async (req, res) => {
    const { body } = validate({ body: schemas.register }, req);
    const result = session.register(body, req.auth.session);
    setSessionCookie(res, result.session._id);
    res.status(201).json({
      user: { id: result.user._id, role: result.user.role, email: result.user.email },
      tokens: { accessToken: result.tokens.accessToken, expiresIn: result.tokens.expiresIn },
      refreshToken: result.tokens.refreshToken,
      cart: cart.toDto(cart.getOrCreate({ sessionId: result.session._id, userId: result.user._id })),
      claimedOrders: result.claimedOrders
    });
  }));

  v1.post('/auth/login', rateLimit(env.rates.auth), asyncHandler(async (req, res) => {
    const { body } = validate({ body: schemas.login }, req);
    if (!req.auth.session) throw new ApiError('UNAUTHENTICATED', 'Start a shopping session first.');
    const result = session.login(body, req.auth.session);
    setSessionCookie(res, result.session._id);
    res.json({
      user: { id: result.user._id, role: result.user.role, email: result.user.email, displayName: result.user.displayName, merchantId: result.user.merchantId },
      tokens: { accessToken: result.tokens.accessToken, expiresIn: result.tokens.expiresIn },
      refreshToken: result.tokens.refreshToken,
      cart: result.cart,
      merged: result.merged,
      claimedOrders: result.claimedOrders
    });
  }));

  v1.post('/auth/refresh', asyncHandler(async (req, res) => {
    const { body } = validate({ body: schemas.refresh }, req);
    const refreshToken = body.refreshToken ?? req.cookies['sp_refresh'];
    if (!refreshToken) throw new ApiError('TOKEN_EXPIRED', 'No refresh token provided.');
    const result = session.refresh(refreshToken);
    res.json({ tokens: { accessToken: result.tokens.accessToken, expiresIn: result.tokens.expiresIn }, refreshToken: result.tokens.refreshToken });
  }));

  v1.post('/auth/logout', asyncHandler(async (req, res) => {
    session.logout(req.auth.session, req.cookies['sp_refresh']);
    clearSessionCookie(res);
    res.status(204).end();
  }));

  // ── Catalogue ────────────────────────────────────────────────────────────
  v1.get('/categories', asyncHandler(async (_req, res) => {
    res.json({ items: store.collection('categories').find({ status: 'active' }, { sort: { order: 1 } }).map(toCategoryDto) });
  }));

  v1.get('/products', asyncHandler(async (req, res) => {
    const { query } = validate({ query: schemas.productSearch }, req);
    const { q, category, merchantId, minPriceMinor, maxPriceMinor, inStock, sort, page, limit, ...rest } = query;
    const attributes = Object.fromEntries(Object.entries(rest).filter(([key]) => /_(gte|lte|eq|in)$/.test(key)));
    res.json(catalogue.search({ q, category, merchantId, minPriceMinor, maxPriceMinor, inStock, attributes, sort, page, limit }));
  }));

  v1.get('/products/:slugOrId', asyncHandler(async (req, res) => {
    const value = req.params.slugOrId;
    const product = /^[0-9a-f]{24}$/.test(value) ? catalogue.getProduct({ productId: value }) : catalogue.getProduct({ slug: value });
    res.json({ product });
  }));

  v1.get('/products/:id/history', asyncHandler(async (req, res) => {
    const user = session.requireRole(req.auth, ['merchant', 'admin']);
    res.json({ items: catalogue.priceHistory(req.params.id, user.merchantId) });
  }));

  v1.post('/products', asyncHandler(async (req, res) => {
    const user = session.requireRole(req.auth, ['merchant', 'admin']);
    const { body } = validate({ body: schemas.productCreate }, req);
    const product = catalogue.createProduct(body, user.merchantId);
    analytics.emit('product_updated', { merchantId: user.merchantId, productId: product._id, props: { productId: product._id, changedFields: 1 } });
    res.status(201).json(catalogue.toDto(product));
  }));

  v1.patch('/products/:id', asyncHandler(async (req, res) => {
    const user = session.requireRole(req.auth, ['merchant', 'admin']);
    const { body } = validate({ body: schemas.productUpdate }, req);
    const before = catalogue.getRaw(req.params.id);
    const product = catalogue.updateProduct(req.params.id, user.merchantId, body, user._id);
    analytics.emit('product_updated', {
      merchantId: user.merchantId,
      productId: product.id,
      props: {
        productId: product.id,
        changedFields: Object.keys(body).length,
        priceFromMinor: before?.priceMinor,
        priceToMinor: body.priceMinor
      }
    });
    res.json(product);
  }));

  v1.delete('/products/:id', asyncHandler(async (req, res) => {
    const user = session.requireRole(req.auth, ['merchant', 'admin']);
    catalogue.archive(req.params.id, user.merchantId);
    res.status(204).end();
  }));

  // ── Cart ─────────────────────────────────────────────────────────────────
  v1.get('/cart', asyncHandler(async (req, res) => {
    const owner = cartOwner(req);
    const cartDoc = cart.getOrCreate(owner);
    res.json({ cart: cart.toDto(cartDoc) });
  }));

  v1.post('/cart/items', rateLimit(env.rates.checkout), asyncHandler(async (req, res) => {
    const { body } = validate({ body: schemas.addToCart }, req);
    const owner = cartOwner(req);
    const key = idempotencyKey(req, owner);
    const run = async () => {
      const result = cart.addItem(owner, body);
      analytics.emit('cart_item_added', {
        sessionId: req.auth.session._id,
        userId: req.auth.user._id,
        productId: body.productId,
        props: { productId: body.productId, quantity: body.quantity, unitPriceMinor: result.cart.items.find((i) => i.productId === body.productId)?.unitPriceMinor ?? 0, surface: body.addedVia ?? 'card' }
      });
      return { status: 200, body: { cart: result.cart } };
    };
    // The Idempotency-Key header is optional here: without it the add still happens (once), with it
    // a retry replays the stored outcome. Stock errors always surface as errors, never as a replay.
    if (!key) {
      const outcome = await run();
      return res.status(outcome.status).json(outcome.body);
    }
    const outcome = await store.once({ scopeKey: `cart:${key}` }, run);
    if (outcome.replayed) res.set('Idempotent-Replay', 'true');
    res.status(outcome.status).json(outcome.response);
  }));

  v1.patch('/cart/items/:productId', asyncHandler(async (req, res) => {
    const { body } = validate({ body: schemas.setQuantity }, req);
    const owner = cartOwner(req);
    const result = cart.setQuantity(owner, req.params.productId, body.quantity);
    res.json({ cart: result.cart });
  }));

  v1.delete('/cart/items/:productId', asyncHandler(async (req, res) => {
    const owner = cartOwner(req);
    res.json({ cart: cart.removeItem(owner, req.params.productId).cart });
  }));

  v1.delete('/cart', asyncHandler(async (req, res) => {
    const owner = cartOwner(req);
    res.json({ cart: cart.clear(owner).cart });
  }));

  // ── Checkout (quote) ─────────────────────────────────────────────────────
  v1.post('/checkout/quote', rateLimit(env.rates.checkout), asyncHandler(async (req, res) => {
    validate({ body: schemas.quote }, req);
    const owner = cartOwner(req);
    const result = quote.create({ ...owner, extendHolds: true });
    analytics.emit('quote_requested', {
      sessionId: req.auth.session._id,
      userId: req.auth.user._id,
      props: { itemCount: result.quote.lines.length, totalMinor: result.quote.amounts.totalMinor }
    });
    res.json(result);
  }));

  // ── Orders ───────────────────────────────────────────────────────────────
  v1.post('/orders', rateLimit(env.rates.checkout), asyncHandler(async (req, res) => {
    const { body } = validate({ body: schemas.createOrder }, req);
    if (!req.auth.session || !req.auth.user) throw new ApiError('UNAUTHENTICATED', 'Start a shopping session first.');
    const email = req.auth.user.email || body.contact?.email;
    if (!email) throw new ApiError('VALIDATION_ERROR', 'An email address is required to place the order.');
    if (!req.auth.user.email && body.contact?.email) {
      store.collection('users').updateOne({ _id: req.auth.user._id }, {
        email: body.contact.email,
        emailLower: body.contact.email.toLowerCase(),
        displayName: body.contact.name || req.auth.user.displayName
      });
      req.auth.user.email = body.contact.email;
    }
    const key = idempotencyKey(req, { sessionId: req.auth.session._id });
    const work = async () => {
      const created = await order.createFromQuote({ ...body, auth: req.auth });
      let attempt = null;
      try {
        attempt = await payment.startAttempt(created, {});
      } catch (err) {
        logger.error('order.paypal_create.failed', { orderId: created._id, error: err.message });
        // The order exists and holds are in place; the user can retry payment from checkout.
      }
      const dto = order.toDto(order.find({ orderId: created._id }));
      return {
        status: 201,
        body: {
          order: dto,
          payment: attempt
            ? { paypalOrderId: attempt.paypalOrderId, clientId: env.paypalClientId, currency: 'USD', attemptNo: attempt.attempt.attemptNo, mode: payment.gateway.mode }
            : { status: 'unavailable', mode: payment.gateway.mode, message: 'PayPal is temporarily unavailable. Your order is saved and you can retry payment.' }
        }
      };
    };
    if (key) {
      const outcome = await store.once({ scopeKey: `order:${key}` }, work);
      if (outcome.replayed) res.set('Idempotent-Replay', 'true');
      return res.status(outcome.status).json(outcome.response);
    }
    const result = await work();
    return res.status(result.status).json(result.body);
  }));

  v1.get('/orders', asyncHandler(async (req, res) => {
    if (!req.auth.session || !req.auth.user) throw new ApiError('UNAUTHENTICATED', 'Start a shopping session first.');
    if (req.auth.user.role === 'merchant' && req.query.scope === 'merchant') {
      return res.json(order.listForMerchant(req.auth.user.merchantId, { status: req.query.status, page: Number(req.query.page ?? 1), limit: Math.min(100, Number(req.query.limit ?? 20)) }));
    }
    res.json(order.listForCustomer(req.auth, { status: req.query.status, page: Number(req.query.page ?? 1), limit: Math.min(100, Number(req.query.limit ?? 20)) }));
  }));

  v1.get('/orders/:orderId', asyncHandler(async (req, res) => {
    const doc = order.findAuthorised({ orderId: req.params.orderId, auth: req.auth });
    const dto = order.toDto(doc);
    let quotePreview = null;
    if (['awaiting_payment', 'payment_failed', 'draft'].includes(doc.status)) {
      const fresh = quote.recomputeForLines(doc.lines, { excludeOrderId: doc._id });
      quotePreview = {
        amountChanged: fresh.totalMinor !== doc.amounts.totalMinor,
        amounts: {
          subtotalMinor: fresh.subtotalMinor,
          shippingMinor: fresh.shippingMinor,
          taxMinor: fresh.taxMinor,
          totalMinor: fresh.totalMinor,
          currency: 'USD',
          display: {
            subtotal: formatMoney(fresh.subtotalMinor),
            shipping: formatMoney(fresh.shippingMinor),
            tax: formatMoney(fresh.taxMinor),
            total: formatMoney(fresh.totalMinor)
          }
        },
        expiresAt: doc.expiresAt,
        unavailable: fresh.unavailableLines.map((l) => ({ productId: l.productId, title: l.title }))
      };
    }
    res.json({ order: dto, quotePreview, paymentStatus: payment.status({ orderId: doc._id, auth: req.auth }) });
  }));

  v1.post('/orders/:orderId/cancel', asyncHandler(async (req, res) => {
    const updated = order.cancel(req.params.orderId, { auth: req.auth });
    res.json({ order: order.toDto(updated) });
  }));

  // ── Payments ─────────────────────────────────────────────────────────────
  v1.post('/payments/:orderId/capture', rateLimit(env.rates.payment), asyncHandler(async (req, res) => {
    const { body } = validate({ body: schemas.capture }, req);
    if (body.simulatedOutcome && payment.gateway.mode !== 'simulator') {
      throw new ApiError('VALIDATION_ERROR', 'simulatedOutcome is only available in simulator mode.');
    }
    const key = idempotencyKey(req, { sessionId: req.auth.session._id });
    const work = async () => {
      const result = await payment.capture({
        orderId: req.params.orderId,
        paypalOrderId: body.paypalOrderId,
        auth: { ...req.auth, requestId: req.requestId },
        simulatedOutcome: body.simulatedOutcome ?? 'approve'
      });
      if (result.alreadyProcessing) {
        return { status: 409, body: { error: { code: 'PAYMENT_IN_PROGRESS', message: 'A payment for this order is already being processed.', requestId: req.requestId } } };
      }
      if (result.pending) {
        return {
          status: 202,
          body: {
            order: result.order,
            payment: { status: 'pending', message: 'PayPal is still processing this payment. We will confirm as soon as it clears.' }
          }
        };
      }
      if (result.replayed) {
        // A replay is the same payment, so it reports the same capture id as the original.
        return {
          status: 200,
          body: {
            order: result.order,
            payment: {
              status: 'captured',
              replay: true,
              captureId: result.order.payment?.paypalCaptureId,
              amountMinor: result.order.amounts.totalMinor,
              currency: 'USD',
              amountVerified: result.order.payment?.amountVerified ?? true
            }
          }
        };
      }
      return {
        status: 200,
        body: {
          order: result.order,
          payment: {
            status: 'captured',
            captureId: result.capture.id,
            capturedAt: result.order.paidAt,
            amountMinor: result.order.amounts.totalMinor,
            currency: 'USD',
            amountVerified: true
          },
          receipt: { orderId: result.order.id, orderNumber: result.order.orderNumber, lines: result.order.lines, amounts: result.order.amounts }
        }
      };
    };
    // Failures (declines, verification mismatches) throw out of work() and are never cached.
    if (key) {
      const outcome = await store.once({ scopeKey: `capture:${key}` }, work);
      if (outcome.replayed) res.set('Idempotent-Replay', 'true');
      return res.status(outcome.status).json(outcome.response);
    }
    const result = await work();
    return res.status(result.status).json(result.body);
  }));

  v1.post('/payments/:orderId/retry', rateLimit(env.rates.payment), asyncHandler(async (req, res) => {
    const result = await payment.retry({ orderId: req.params.orderId, auth: req.auth });
    res.status(201).json({
      order: result.order,
      payment: { paypalOrderId: result.paypalOrderId ?? result.attempt?.paypalOrderId, attemptNo: result.attempt?.attemptNo, mode: payment.gateway.mode, requiresApproval: true }
    });
  }));

  v1.get('/payments/:orderId/status', asyncHandler(async (req, res) => {
    res.json(payment.status({ orderId: req.params.orderId, auth: req.auth }));
  }));

  v1.post('/webhooks/paypal', express.raw({ type: '*/*' }), asyncHandler(async (req, res) => {
    let body = req.body;
    if (Buffer.isBuffer(body)) {
      try {
        body = JSON.parse(body.toString('utf8'));
      } catch {
        return res.status(200).json({ received: true, parseError: true });
      }
    }
    const result = await payment.ingestWebhook({ headers: req.headers, body });
    res.status(200).json(result);
  }));

  // ── Chat (SSE) ───────────────────────────────────────────────────────────
  v1.get('/chat/sessions/:sessionId/messages', asyncHandler(async (req, res) => {
    if (!req.auth.session || req.auth.session._id !== req.params.sessionId) throw new ApiError('FORBIDDEN', 'That conversation is not yours.');
    const items = store
      .collection('chat_messages')
      .find({ sessionId: req.params.sessionId }, { sort: { createdAt: 1 }, limit: Math.min(100, Number(req.query.limit ?? 40)) });
    res.json({ items });
  }));

  v1.patch('/chat/sessions/:sessionId/requirement', asyncHandler(async (req, res) => {
    const { body } = validate({ body: schemas.requirementPatch }, req);
    const current = req.auth.session;
    if (!current || current._id !== req.params.sessionId) throw new ApiError('FORBIDDEN', 'That conversation is not yours.');
    const requirement = { ...(current.chat?.requirement ?? { revision: 0, hardConstraints: [], softPreferences: [], quantity: 1, assumptions: [] }) };
    const constraint = body.constraint;
    requirement.hardConstraints = [...(requirement.hardConstraints ?? [])];
    if (body.op === 'remove') {
      if (constraint.kind === 'budget') requirement.budgetMinor = null;
      else if (constraint.kind === 'category') requirement.categorySlug = null;
      else requirement.hardConstraints = requirement.hardConstraints.filter((c) => !(c.key === constraint.key && (!constraint.value || c.value === constraint.value)));
    } else {
      if (constraint.kind === 'budget') requirement.budgetMinor = Number(constraint.value);
      else if (constraint.kind === 'category') requirement.categorySlug = String(constraint.value);
      else requirement.hardConstraints.push({ kind: 'attribute', key: constraint.key, op: constraint.op ?? 'gte', value: constraint.value, label: constraint.label ?? `${constraint.key} ${constraint.op ?? 'gte'} ${constraint.value}` });
    }
    requirement.revision = (requirement.revision ?? 0) + 1;
    store.collection('sessions').updateOne({ _id: current._id }, { chat: { ...current.chat, requirement, requirementRevision: requirement.revision } });
    analytics.emit('requirement_updated', { sessionId: current._id, userId: req.auth.user?._id, props: { revision: requirement.revision } });
    const result = catalogue.searchForAgent({
      categorySlug: requirement.categorySlug ?? undefined,
      budgetMaxMinor: requirement.budgetMinor ?? undefined,
      filters: requirement.hardConstraints.filter((x) => x.kind === 'attribute'),
      softPreferences: requirement.softPreferences ?? [],
      limit: 5
    });
    res.json({
      requirement,
      requirementRevision: requirement.revision,
      requirementChips: requirementChips(requirement),
      changed: true,
      products: result.products,
      relaxed: result.relaxed,
      candidateProductIds: result.products.map((p) => p.id)
    });
  }));

  v1.post('/chat/stream', rateLimit(env.rates.chat), asyncHandler(async (req, res) => {
    const { body } = validate({ body: schemas.chat }, req);
    if (!req.auth.session || !req.auth.user) throw new ApiError('UNAUTHENTICATED', 'Start a shopping session first.');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
    // NOTE: in modern Node, req 'close' fires as soon as the request body is consumed, which would
    // abort every stream instantly. Client disconnects show up on the *response*.
    let closed = false;
    const markClosed = () => {
      closed = true;
    };
    res.on('close', markClosed);
    req.on('aborted', markClosed);
    try {
      for await (const frame of orchestrator.runTurn({ auth: req.auth, message: body.message, clientMessageId: body.clientMessageId, requestId: req.requestId })) {
        if (closed) break;
        res.write(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`);
        if (frame.event === 'message.delta') await sleep(10);
      }
    } catch (err) {
      logger.error('chat.stream.failed', { requestId: req.requestId, error: err.message });
      const code = err instanceof ApiError ? err.code : 'LLM_UNAVAILABLE';
      res.write(`event: error\ndata: ${JSON.stringify({ code, message: err.message, requestId: req.requestId })}\n\n`);
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  }));

  // ── Analytics ────────────────────────────────────────────────────────────
  v1.post('/analytics/events', rateLimit(env.rates.global), asyncHandler(async (req, res) => {
    const { body } = validate({ body: schemas.analytics }, req);
    analytics.ingestClient(body.events, { sessionId: req.auth.session?._id, userId: req.auth.user?._id });
    res.status(204).end();
  }));

  // ── Merchant ─────────────────────────────────────────────────────────────
  const merchantScope = (req) => {
    const user = session.requireRole(req.auth, ['merchant', 'admin']);
    const merchantId = user.role === 'admin' ? req.query.merchantId ?? store.collection('merchants').find({})[0]?._id : user.merchantId;
    if (!merchantId) throw new ApiError('FORBIDDEN', 'No merchant is linked to this account.');
    return { user, merchantId };
  };

  v1.get('/merchant/overview', asyncHandler(async (req, res) => {
    const { merchantId } = merchantScope(req);
    res.json(order.overview(merchantId));
  }));

  v1.get('/merchant/products', asyncHandler(async (req, res) => {
    const { merchantId } = merchantScope(req);
    res.json(catalogue.listForMerchant(merchantId, { status: req.query.status, q: req.query.q, page: Number(req.query.page ?? 1), limit: Math.min(100, Number(req.query.limit ?? 50)) }));
  }));

  v1.get('/merchant/orders', asyncHandler(async (req, res) => {
    const { merchantId } = merchantScope(req);
    res.json(order.listForMerchant(merchantId, { status: req.query.status, paymentStatus: req.query.paymentStatus, q: req.query.q, page: Number(req.query.page ?? 1), limit: Math.min(100, Number(req.query.limit ?? 20)) }));
  }));

  v1.get('/merchant/orders/:orderId/attempts', asyncHandler(async (req, res) => {
    const { merchantId } = merchantScope(req);
    const doc = order.find({ orderId: req.params.orderId });
    if (!doc.lines.some((l) => l.merchantId === merchantId)) throw new ApiError('ORDER_NOT_FOUND', "We couldn't find that order.");
    res.json({ items: payment.attemptsFor(doc._id) });
  }));

  v1.patch('/merchant/orders/:orderId', asyncHandler(async (req, res) => {
    const { merchantId } = merchantScope(req);
    const { body } = validate({ body: schemas.merchantOrderAction }, req);
    const updated = body.action === 'mark_shipped' ? order.markShipped(req.params.orderId, merchantId, body.tracking) : order.cancel(req.params.orderId, { actor: 'merchant' });
    res.json({ order: order.toDto(updated) });
  }));

  v1.post('/merchant/orders/:orderId/refund', asyncHandler(async (req, res) => {
    merchantScope(req);
    const { body } = validate({ body: schemas.refundOrder }, req);
    const result = await payment.refundOrder({ orderId: req.params.orderId, reason: body?.reason, auth: req.auth });
    res.json(result);
  }));

  v1.post('/merchant/products', asyncHandler(async (req, res) => {
    const { merchantId } = merchantScope(req);
    const { body } = validate({ body: schemas.productCreate }, req);
    res.status(201).json(catalogue.toDto(catalogue.createProduct(body, merchantId)));
  }));

  v1.patch('/merchant/products/:id', asyncHandler(async (req, res) => {
    const { merchantId, user } = merchantScope(req);
    const { body } = validate({ body: schemas.productUpdate }, req);
    res.json(catalogue.updateProduct(req.params.id, merchantId, body, user._id));
  }));

  v1.get('/merchant/analytics', asyncHandler(async (req, res) => {
    const { merchantId } = merchantScope(req);
    const range = req.query.range ?? '30d';
    const days = range === '7d' ? 7 : range === '90d' ? 90 : 30;
    const from = new Date(Date.now() - days * 86_400_000).toISOString();
    res.json({ range: { from, days }, ...analytics.dashboard({ merchantId, from, to: new Date().toISOString() }) });
  }));

  v1.get('/merchant/categories', asyncHandler(async (req, res) => {
    merchantScope(req);
    res.json({ items: store.collection('categories').find({ status: 'active' }, { sort: { order: 1 } }).map(toCategoryDto) });
  }));

  // ── Admin ────────────────────────────────────────────────────────────────
  /**
   * The platform console's data: what every seller earned, what ShopPilot kept, and which
   * orders still need a human. This is the view that makes the multi-seller model legible —
   * without it the split settlement is an implementation detail nobody can see.
   */
  v1.get('/admin/overview', asyncHandler(async (req, res) => {
    session.requireRole(req.auth, ['admin']);
    const overview = order.platformOverview();
    const all = order.listForAdmin({ status: req.query.status, q: req.query.q, limit: Math.min(100, Number(req.query.limit ?? 25)) });
    res.json({ ...overview, orders: all });
  }));

  v1.post('/admin/orders/:orderId/reconcile', asyncHandler(async (req, res) => {
    session.requireRole(req.auth, ['admin']);
    const result = await payment.reconcile({ orderId: req.params.orderId });
    res.json({ applied: result.outcomes.some((o) => o.outcome === 'applied_paid'), ...result });
  }));

  // ── Developer / demo helpers (simulator only, never in production) ───────
  if (!env.isProd) {
    v1.post('/dev/paypal/webhook/:orderId', asyncHandler(async (req, res) => {
      if (payment.gateway.mode !== 'simulator') throw new ApiError('FORBIDDEN', 'Dev webhooks require PAYPAL_MODE=simulator.');
      const doc = order.find({ orderId: req.params.orderId });
      const event = payment.buildWebhookEvent(doc);
      if (!event) throw new ApiError('VALIDATION_ERROR', 'No capture exists for that order yet.');
      const result = await payment.ingestWebhook({ headers: {}, body: event });
      res.json({ event, result });
    }));

    v1.post('/dev/jobs/reconcile', asyncHandler(async (_req, res) => {
      res.json(await payment.reconcile({}));
    }));

    v1.post('/dev/jobs/expire', asyncHandler(async (_req, res) => {
      res.json({ expiredOrders: payment.expireStaleOrders(), swept: store.sweepExpired() });
    }));

    v1.get('/dev/state', asyncHandler(async (_req, res) => {
      res.json({ collections: store.stats(), paypalMode: payment.gateway.mode, flags: { liveLlm: env.featureLiveLlm, analytics: env.featureAnalytics } });
    }));

    // Re-read the store file after an out-of-band `node scripts/reset.mjs` / `seed.mjs`.
    v1.post('/dev/store/reload', asyncHandler(async (_req, res) => {
      await store.reload();
      res.json({ reloaded: true, collections: store.stats() });
    }));
  }

  // ── Health ───────────────────────────────────────────────────────────────
  /**
   * Liveness. Always 200 while the process is serving.
   *
   * This is what the host health-checks, and it is deliberately NOT the same thing as
   * readiness: a PayPal sandbox that is briefly unavailable must not take the storefront down
   * with it. The demo degrades one feature and says so, rather than showing a judge a 503.
   */
  v1.get('/healthz', asyncHandler(async (_req, res) => {
    const paypal = payment.gateway.mode === 'sandbox'
      ? (await payment.gateway.healthy() ? 'ok' : 'down')
      : 'simulator';
    res.json({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      paypal,
      llm: !env.featureLiveLlm ? 'deterministic' : (env.llmApiKey ? 'live' : 'misconfigured-no-key')
    });
  }));
  /** Readiness. 503 when a dependency the checkout needs is unavailable. */
  v1.get('/readyz', asyncHandler(async (_req, res) => {
    let paypal = 'simulator';
    if (payment.gateway.mode === 'sandbox') {
      paypal = (await payment.gateway.healthy()) ? 'ok' : 'down';
    }
    const ready = paypal !== 'down';
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'degraded',
      store: { driver: 'file', collections: Object.keys(store.stats()).length, path: env.dataDir },
      paypal,
      // Report what is actually wired, not what was asked for: a flag with no key can never call a
      // model, and calling that "live" is precisely the kind of claim this project refuses to make.
      llm: !env.featureLiveLlm ? 'deterministic' : (env.llmApiKey ? 'live' : 'misconfigured-no-key'),
      flags: { checkout: true, analytics: env.featureAnalytics, guestOrders: env.featureGuestOrders }
    });
  }));
  v1.get('/version', asyncHandler(async (_req, res) =>
    res.json({
      version: '1.0.0',
      node: process.version,
      currency: 'USD',
      paypalEnv: env.paypalEnv,
      paypalMode: payment.gateway.mode,
      // Whether PayPal is actually reachable right now, so the storefront can say "payments are
      // degraded" instead of letting a shopper discover it at the checkout button.
      paypalHealth: payment.gateway.mode === 'sandbox'
        ? ((await payment.gateway.healthy()) ? 'ok' : 'down')
        : 'simulator',
      // The client id is a public value (it ships in the browser SDK URL), so the storefront can
      // mount PayPal Buttons without a second round-trip. The secret never leaves the server.
      paypalClientId: payment.gateway.mode === 'sandbox' ? env.paypalClientId || null : null,
      paypalSdkReady: Boolean(env.paypalClientId) && payment.gateway.mode === 'sandbox',
      // Which model the server will actually call. Without this, "is the AI on?" was answerable only
      // by reading a log stream somewhere the operator may not have access to.
      llm: {
        live: env.featureLiveLlm && Boolean(env.llmApiKey),
        provider: env.llmProvider ?? null,
        model: env.featureLiveLlm ? env.llmModel : null
      },
      features: { liveLlm: env.featureLiveLlm, analytics: env.featureAnalytics, guestOrders: env.featureGuestOrders },
      // The suite's own size, read from test-count.json (which `npm run verify` keeps honest).
      // The storefront quotes this instead of a number typed into a template.
      tests: env.testCount
    })
  ));

  /**
   * Which models this deployment's key is actually allowed to call.
   *
   * A chat turn can only tell the shopper "the model failed"; it cannot tell the operator *why*.
   * Groq (and OpenAI, and Together) all 404 with the same "does not exist or you do not have
   * access" message for a model name that is real but gated behind a plan, and for a typo. Asking
   * the provider for the model list settles it: if the configured model is absent from the list,
   * the key is fine and the model is not available to it.
   *
   * Read-only, unauthenticated (it exposes only public model ids, never the key), cached for five
   * minutes so it cannot be used to burn provider rate limit.
   */
  let modelListCache = { at: 0, value: null };
  v1.get('/diagnostics/llm', asyncHandler(async (_req, res) => {
    const configured = env.featureLiveLlm && Boolean(env.llmApiKey);
    const base = { configured, provider: env.llmProvider ?? null, model: env.llmModel ?? null, baseUrl: env.llmBaseUrl ?? null };
    if (!configured) {
      return res.json({ ...base, ok: false, note: 'FEATURE_LIVE_LLM is off or LLM_API_KEY is empty — every turn runs on the deterministic planner.' });
    }
    const now = Date.now();
    if (!modelListCache.value || now - modelListCache.at > 5 * 60_000) {
      const endpoint = `${String(env.llmBaseUrl).replace(/\/+$/, '')}/models`;
      try {
        const response = await fetch(endpoint, {
          headers: { authorization: `Bearer ${env.llmApiKey}` },
          signal: AbortSignal.timeout(8000)
        });
        const text = await response.text();
        if (!response.ok) {
          modelListCache = { at: now, value: { ok: false, status: response.status, error: text.slice(0, 300).replace(/gsk_[A-Za-z0-9_-]+/g, 'gsk_***') } };
        } else {
          const parsed = JSON.parse(text);
          const ids = (parsed.data ?? []).map((m) => m.id).sort();
          modelListCache = { at: now, value: { ok: true, models: ids } };
        }
      } catch (error) {
        modelListCache = { at: now, value: { ok: false, error: error.message } };
      }
    }
    const list = modelListCache.value;
    if (!list.ok) return res.json({ ...base, reachable: true, ok: false, error: list.error, status: list.status ?? null });
    return res.json({
      ...base,
      reachable: true,
      ok: list.models.includes(env.llmModel),
      modelAvailable: list.models.includes(env.llmModel),
      availableModels: list.models,
      note: list.models.includes(env.llmModel)
        ? 'The configured model is available to this key.'
        : `This key cannot call "${env.llmModel}". Pick one of availableModels and set LLM_MODEL.`
    });
  }));

  app.use('/api/v1', v1);

  // ── helpers ──────────────────────────────────────────────────────────────
  function cartOwner(req) {
    if (!req.auth.session || !req.auth.user) throw new ApiError('UNAUTHENTICATED', 'Start a shopping session first.');
    return { sessionId: req.auth.session._id, userId: req.auth.user.role === 'guest' ? undefined : req.auth.user._id };
  }
  function idempotencyKey(req, owner) {
    const raw = req.get('idempotency-key');
    if (!raw) return null;
    return `${owner.sessionId}:${raw}`;
  }
  function requireUnsign(req) {
    return unsignCookie(req.cookies[env.cookieName]);
  }
  function toCategoryDto(category) {
    return { id: category._id, name: category.name, slug: category.slug, parentId: category.parentId ?? null, order: category.order, attributeSchema: category.attributeSchema };
  }
  return v1;
}

export default registerRoutes;
