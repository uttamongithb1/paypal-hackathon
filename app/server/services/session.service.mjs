/**
 * Session + auth service: guest sessions, registration, login, JWT/refresh rotation, guest→user
 * upgrade with cart merge and order claim, RBAC helpers.
 * Docs: ../docs/api_spec.md §2, ../docs/security_privacy.md §2–3
 */
import { ApiError } from '../lib/errors.mjs';
import { hashPassword, objectId, passwordProblems, sessionId as newSessionId, signJwt, token, verifyJwt, verifyPassword, hashPii, safeEqual } from '../lib/crypto.mjs';
import env from '../config/env.mjs';

const ttlMs = (spec) => {
  const m = /^(\d+)(s|m|h|d)$/.exec(spec);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
};

export class SessionService {
  constructor(store, { cart, analytics }) {
    this.store = store;
    this.cart = cart;
    this.analytics = analytics;
  }

  get sessions() {
    return this.store.collection('sessions');
  }

  get users() {
    return this.store.collection('users');
  }

  get refreshTokens() {
    return this.store.collection('refresh_tokens');
  }

  /** Guest sessions are real user rows so carts/orders/analytics always have an owner (DEC-06). */
  createGuest({ userAgent, ip } = {}) {
    const user = this.users.insert({ role: 'guest', displayName: 'Guest shopper', prefs: { theme: 'system' }, status: 'active', lastSeenAt: new Date().toISOString() });
    const session = this.sessions.insert({
      _id: newSessionId(),
      userId: user._id,
      kind: 'guest',
      userAgent: userAgent?.slice(0, 200),
      ipHash: ip ? hashPii(ip) : undefined,
      chat: { requirement: null, requirementRevision: 0, lastCandidateProductIds: [], attachedProductIds: [], messageCount: 0 },
      expiresAt: new Date(Date.now() + ttlMs(env.guestSessionTtl)).toISOString()
    });
    const cart = this.cart.getOrCreate({ sessionId: session._id });
    this.sessions.updateOne({ _id: session._id }, { cartId: cart._id });
    this.analytics.emit('session_started', { sessionId: session._id, userId: user._id, props: { role: 'guest' } });
    return { user, session, cartId: cart._id };
  }

  byId(id) {
    if (!id) return null;
    const session = this.sessions.findOne({ _id: id });
    if (!session) return null;
    if (session.revokedAt) return null;
    if (session.expiresAt && session.expiresAt < new Date().toISOString()) return null;
    return session;
  }

  userById(id) {
    return this.users.findOne({ _id: id });
  }

  register({ email, password, displayName }, session) {
    const emailLower = String(email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailLower)) throw new ApiError('VALIDATION_ERROR', 'Enter a valid email address.');
    const problems = passwordProblems(password);
    if (problems.length) throw new ApiError('WEAK_PASSWORD', problems.join(' '), { details: { problems } });
    if (this.users.findOne({ emailLower })) throw new ApiError('EMAIL_TAKEN', 'That email already has an account. Sign in instead.');

    const user = this.users.findOne({ _id: session.userId });
    this.users.updateOne(
      { _id: user._id },
      { role: 'customer', email: emailLower, emailLower, passwordHash: hashPassword(password), displayName: displayName ?? emailLower.split('@')[0] }
    );
    this.sessions.updateOne({ _id: session._id }, { kind: 'user', expiresAt: new Date(Date.now() + ttlMs(env.guestSessionTtl)).toISOString() });
    const claimedOrders = this.claimGuestOrders(session, user._id);
    this.analytics.emit('session_started', { sessionId: session._id, userId: user._id, props: { role: 'customer' } });
    return { user: this.users.findOne({ _id: user._id }), session: this.byId(session._id), claimedOrders, tokens: this.issueTokens(user._id, 'customer') };
  }

  login({ email, password }, currentSession) {
    const emailLower = String(email ?? '').trim().toLowerCase();
    const user = this.users.findOne({ emailLower });
    if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
      throw new ApiError('INVALID_CREDENTIALS', 'Email or password is incorrect.');
    }
    if (user.status === 'disabled') throw new ApiError('ACCOUNT_DISABLED', 'This account is disabled.');

    // Upgrade the *current* session in place (no fixation): same sid, new identity.
    this.sessions.updateOne(
      { _id: currentSession._id },
      { kind: 'user', userId: user._id, expiresAt: new Date(Date.now() + ttlMs(env.guestSessionTtl)).toISOString() }
    );
    let merged = { addedQuantity: 0, itemCount: 0 };
    const guestCart = this.cart.find({ sessionId: currentSession._id });
    const userCart = this.cart.carts.findOne({ userId: user._id, status: 'active' });
    if (guestCart && userCart) merged = this.cart.merge(guestCart, userCart);
    else if (guestCart) this.cart.carts.updateOne({ _id: guestCart._id }, { userId: user._id, ownerType: 'user' });

    const claimedOrders = this.claimGuestOrders(currentSession, user._id);
    this.users.updateOne({ _id: user._id }, { lastSeenAt: new Date().toISOString() });
    return { user, session: this.byId(currentSession._id), cart: this.cart.toDto(this.cart.getOrCreate({ sessionId: currentSession._id, userId: user._id })), merged, claimedOrders, tokens: this.issueTokens(user._id, user.role) };
  }

  /** Guest orders from the last 24 h become visible to the new account (FR-1.4). */
  claimGuestOrders(session, userId) {
    const orders = this.store.collection('orders');
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const claimable = orders.find({ sessionId: session._id, userId: session.userId, status: { $ne: 'cancelled' }, createdAt: { $gte: cutoff } });
    for (const order of claimable) orders.updateOne({ _id: order._id }, { userId });
    return claimable.length;
  }

  issueTokens(userId, role) {
    const accessToken = signJwt({ sub: userId, role });
    const refresh = token(32);
    const familyId = objectId();
    this.refreshTokens.insert({
      userId,
      tokenHash: hashPii(refresh),
      familyId,
      expiresAt: new Date(Date.now() + ttlMs(env.refreshTokenTtl)).toISOString()
    });
    return { accessToken, expiresIn: Math.floor(ttlMs(env.accessTokenTtl) / 1000), refreshToken: refresh, familyId };
  }

  refresh(refreshToken) {
    const row = this.refreshTokens.findOne({ tokenHash: hashPii(refreshToken) });
    if (!row) throw new ApiError('TOKEN_EXPIRED', 'Your session expired. Please sign in again.');
    if (row.revokedAt) {
      // Reuse of a rotated token → revoke the whole family (theft detection).
      for (const sibling of this.refreshTokens.find({ familyId: row.familyId })) {
        this.refreshTokens.updateOne({ _id: sibling._id }, { revokedAt: new Date().toISOString() });
      }
      throw new ApiError('TOKEN_REUSE', 'This session was signed out for security. Please sign in again.');
    }
    const user = this.users.findOne({ _id: row.userId });
    const next = this.issueTokens(row.userId, user?.role ?? 'customer');
    this.refreshTokens.updateOne({ _id: row._id }, { revokedAt: new Date().toISOString(), replacedBy: next.familyId });
    return { tokens: next, user };
  }

  logout(session, refreshToken) {
    if (refreshToken) {
      const row = this.refreshTokens.findOne({ tokenHash: hashPii(refreshToken) });
      if (row) this.refreshTokens.updateOne({ _id: row._id }, { revokedAt: new Date().toISOString() });
    }
    if (session?.kind === 'user') {
      // Keep the session row (cart/orders survive) but drop its identity back to the guest user.
      const guest = this.users.findOne({ _id: session.userId });
      if (guest && guest.role !== 'guest') {
        const fresh = this.users.insert({ role: 'guest', displayName: 'Guest shopper', status: 'active', lastSeenAt: new Date().toISOString() });
        this.sessions.updateOne({ _id: session._id }, { userId: fresh._id, kind: 'guest' });
      }
    }
    return { ok: true };
  }

  /** Resolve the caller from cookie + bearer token; never trusts a client-supplied id. */
  authenticate({ sessionCookieValue, bearerToken }) {
    let session = this.byId(sessionCookieValue);
    let user = session ? this.userById(session.userId) : null;
    if (bearerToken) {
      const payload = verifyJwt(bearerToken);
      if (payload?.expired) throw new ApiError('TOKEN_EXPIRED', 'Access token expired.');
      if (payload) {
        user = this.userById(payload.sub);
        if (!session) session = this.sessions.findOne({ userId: user?._id, kind: 'user' });
      }
    }
    return { session, user };
  }

  /** RBAC helpers — docs/security_privacy.md §3 */
  requireUser(auth) {
    if (!auth.user) throw new ApiError('UNAUTHENTICATED', 'Sign in to continue.');
    return auth.user;
  }

  requireRole(auth, roles) {
    const user = this.requireUser(auth);
    if (!roles.includes(user.role)) throw new ApiError('FORBIDDEN', 'You do not have access to that.');
    return user;
  }

  hashIp(ip) {
    return hashPii(ip ?? 'unknown');
  }

  assertPassword(password, stored) {
    return verifyPassword(password, stored);
  }

  safeEqual(a, b) {
    return safeEqual(a, b);
  }
}

export default SessionService;
