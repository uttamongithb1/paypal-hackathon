/**
 * File-backed document store with Mongo-like semantics (collections, indexes, filters, atomic
 * update-with-guard, TTL sweeps, single-writer transactions).
 *
 * Why: this reference build must run anywhere with zero infrastructure. The collection names,
 * field names and access patterns mirror ../docs/data_model.md exactly, and every service talks
 * to this API only — swapping in real MongoDB means implementing the same ~12 methods
 * (see server/store/mongo.driver.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { objectId, stableHash } from '../lib/crypto.mjs';
import { applyOperators, applyPatch, getPath, matches, project, sortDocs } from '../lib/query.mjs';
import { ApiError } from '../lib/errors.mjs';
import logger from '../lib/logger.mjs';

export const INDEXES = {
  users: [{ fields: ['emailLower'], unique: true, sparse: true }],
  sessions: [{ fields: ['expiresAt'] }],
  refresh_tokens: [{ fields: ['tokenHash'], unique: true }],
  merchants: [{ fields: ['slug'], unique: true }],
  categories: [{ fields: ['slug'], unique: true }],
  products: [
    { fields: ['slug'], unique: true },
    { fields: ['sku', 'merchantId'], unique: true }
  ],
  price_history: [{ fields: ['productId', 'createdAt'] }],
  carts: [
    { fields: ['sessionId', 'status'] },
    { fields: ['userId', 'status'] }
  ],
  quotes: [{ fields: ['cartId', 'status'] }],
  orders: [
    { fields: ['orderNumber'], unique: true },
    { fields: ['payment.paypalOrderId'], unique: true, sparse: true },
    { fields: ['payment.paypalCaptureId'], unique: true, sparse: true },
    { fields: ['idempotencyKey'], unique: true, sparse: true }
  ],
  payment_attempts: [
    { fields: ['orderId', 'attemptNo'], unique: true },
    { fields: ['captureId'], unique: true, sparse: true },
    { fields: ['idempotencyKey'], unique: true, sparse: true },
    { fields: ['paypalOrderId'] }
  ],
  inventory_holds: [{ fields: ['orderId', 'status'] }, { fields: ['productId', 'status'] }],
  analytics_events: [{ fields: ['eventId'], unique: true }, { fields: ['name', 'ts'] }, { fields: ['dedupeKey'], unique: true, sparse: true }],
  webhook_events: [{ fields: ['eventId'], unique: true }],
  idempotency_keys: [{ fields: ['scopeKey'], unique: true }],
  chat_messages: [{ fields: ['sessionId', 'createdAt'] }],
  counters: [{ fields: ['_id'], unique: true }]
};

/** Collections with a TTL field (swept by the scheduler). */
export const TTL_FIELDS = {
  sessions: 'expiresAt',
  refresh_tokens: 'expiresAt',
  quotes: 'expiresAt',
  inventory_holds: 'expiresAt',
  idempotency_keys: 'expiresAt',
  carts: null // carts are long-lived; abandoned carts are pruned explicitly
};

export class Collection {
  constructor(store, name) {
    this.store = store;
    this.name = name;
  }

  get docs() {
    if (!this.store.data[this.name]) this.store.data[this.name] = [];
    return this.store.data[this.name];
  }

  find(filter = {}, { sort, limit, skip = 0, fields } = {}) {
    let out = this.docs.filter((d) => matches(d, filter));
    out = sortDocs(out, sort);
    if (skip) out = out.slice(skip);
    if (limit !== undefined) out = out.slice(0, limit);
    return out.map((d) => (fields ? project(structuredClone(d), fields) : structuredClone(d)));
  }

  findOne(filter = {}, options = {}) {
    return this.find(filter, { ...options, limit: 1 })[0] ?? null;
  }

  count(filter = {}) {
    return this.docs.filter((d) => matches(d, filter)).length;
  }

  insert(doc) {
    const now = new Date().toISOString();
    const record = { _id: doc._id ?? objectId(), createdAt: doc.createdAt ?? now, ...doc, updatedAt: now };
    this.docs.push(record);
    this.store.assertIndexes(this.name, record);
    this.store.touch(this.name);
    return structuredClone(record);
  }

  insertMany(docs) {
    return docs.map((d) => this.insert(d));
  }

  updateOne(filter, update, { returnDocument = 'after', upsert = false } = {}) {
    const doc = this.docs.find((d) => matches(d, filter));
    if (!doc) {
      if (!upsert) return null;
      const base = typeof update === 'object' && !Object.keys(update).some((k) => k.startsWith('$')) ? update : {};
      return this.insert(base);
    }
    const before = structuredClone(doc);
    const isOperatorUpdate = Object.keys(update).some((k) => k.startsWith('$'));
    if (isOperatorUpdate) applyOperators(doc, update);
    else applyPatch(doc, update);
    doc.updatedAt = new Date().toISOString();
    this.store.assertIndexes(this.name, doc);
    this.store.touch(this.name);
    return returnDocument === 'before' ? before : structuredClone(doc);
  }

  /** Atomic conditional update — the concurrency-safe primitive (e.g. stock >= qty guard). */
  findOneAndUpdate(filter, update, options = {}) {
    return this.updateOne(filter, update, options);
  }

  deleteOne(filter) {
    const idx = this.docs.findIndex((d) => matches(d, filter));
    if (idx === -1) return { deletedCount: 0 };
    this.docs.splice(idx, 1);
    this.store.touch(this.name);
    return { deletedCount: 1 };
  }

  deleteMany(filter) {
    const keep = this.docs.filter((d) => !matches(d, filter));
    const deletedCount = this.docs.length - keep.length;
    this.store.data[this.name] = keep;
    if (deletedCount) this.store.touch(this.name);
    return { deletedCount };
  }

  distinct(field, filter = {}) {
    return [...new Set(this.find(filter).map((d) => getPath(d, field)).filter((v) => v !== undefined))];
  }
}

export class Store {
  constructor({ dir, file = 'db.json' } = {}) {
    this.dir = dir;
    this.file = path.join(dir, file);
    this.data = {};
    this.dirty = new Set();
    this.saveTimer = null;
    this.lockChain = Promise.resolve();
    this.lockDepth = 0;
    this.metrics = { writes: 0, transactions: 0, conflicts: 0 };
  }

  static async open({ dir }) {
    const store = new Store({ dir });
    await store.load();
    return store;
  }

  async load() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (fs.existsSync(this.file)) {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = raw.data ?? {};
      this.meta = raw.meta ?? {};
      logger.info('store.loaded', { file: this.file, collections: Object.keys(this.data).length });
    } else {
      this.data = {};
      this.meta = { createdAt: new Date().toISOString(), seeded: false };
      await this.flush();
      logger.info('store.created', { file: this.file });
    }
  }

  /** Drop in-memory state and re-read the file (used after scripts/reset.mjs rewrites it). */
  async reload() {
    await this.flush();
    this.data = {};
    this.meta = {};
    await this.load();
    return this.stats();
  }

  collection(name) {
    return new Collection(this, name);
  }

  touch(name) {
    this.metrics.writes += 1;
    this.dirty.add(name);
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.flush().catch((err) => logger.error('store.save.failed', { error: err.message }));
      }, 150);
      this.saveTimer.unref?.();
    }
  }

  async flush() {
    const payload = JSON.stringify({ meta: this.meta, data: this.data }, null, 0);
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, this.file);
    this.dirty.clear();
  }

  /** Single-writer critical section; re-entrant so services can nest safely. */
  async transact(fn) {
    if (this.lockDepth > 0) return fn();
    const previous = this.lockChain;
    let release;
    this.lockChain = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    this.lockDepth += 1;
    this.metrics.transactions += 1;
    const before = structuredClone(this.data);
    try {
      const result = await fn();
      await this.flush();
      return result;
    } catch (err) {
      this.data = before; // rollback
      this.metrics.conflicts += 1;
      throw err;
    } finally {
      this.lockDepth -= 1;
      release();
    }
  }

  /** Unique-index enforcement (in-memory scan; fine at demo scale). */
  assertIndexes(collectionName, doc) {
    const indexes = INDEXES[collectionName] ?? [];
    for (const index of indexes) {
      if (!index.unique) continue;
      const values = index.fields.map((f) => getPath(doc, f));
      if (index.sparse && values.every((v) => v === undefined || v === null)) continue;
      const clash = (this.data[collectionName] ?? []).some(
        (other) => other._id !== doc._id && index.fields.every((f, i) => getPath(other, f) === values[i])
      );
      if (clash) {
        const detail = index.fields.map((f, i) => `${f}=${values[i]}`).join(', ');
        throw new ApiError('VALIDATION_ERROR', `Duplicate value for unique index (${detail})`, { status: 409 });
      }
    }
  }

  /** Monotonic counter (order numbers, sequences). */
  nextSequence(name) {
    const counters = this.collection('counters');
    const existing = counters.findOne({ _id: name });
    if (!existing) {
      counters.insert({ _id: name, seq: 1 });
      return 1;
    }
    counters.updateOne({ _id: name }, { $inc: { seq: 1 } });
    return counters.findOne({ _id: name }).seq;
  }

  nextOrderNumber(year = new Date().getFullYear()) {
    const seq = this.nextSequence(`orderNumber:${year}`);
    return `SP-${year}-${String(seq).padStart(6, '0')}`;
  }

  /** Idempotency helper: returns the stored response for a replayed key, or runs the work once. */
  async once({ scopeKey, ttlMs = 24 * 60 * 60 * 1000 }, work) {
    const keys = this.collection('idempotency_keys');
    const existing = keys.findOne({ scopeKey });
    if (existing?.status === 'completed') return { replayed: true, response: existing.responseBody, status: existing.responseStatus };
    if (existing?.status === 'in_progress') {
      throw new ApiError('PAYMENT_IN_PROGRESS', 'That request is already being processed.', { status: 409 });
    }
    keys.insert({ scopeKey, status: 'in_progress', expiresAt: new Date(Date.now() + ttlMs).toISOString() });
    try {
      const result = await work();
      keys.updateOne({ scopeKey }, { status: 'completed', responseBody: result.body, responseStatus: result.status });
      return { replayed: false, response: result.body, status: result.status };
    } catch (err) {
      keys.deleteOne({ scopeKey });
      throw err;
    }
  }

  sweepExpired(now = new Date()) {
    const swept = {};
    for (const [collectionName, field] of Object.entries(TTL_FIELDS)) {
      if (!field) continue;
      const collection = this.collection(collectionName);
      const { deletedCount } = collection.deleteMany({ [field]: { $lt: now.toISOString() } });
      if (deletedCount) swept[collectionName] = deletedCount;
    }
    return swept;
  }

  stats() {
    return Object.fromEntries(Object.entries(this.data).map(([k, v]) => [k, v.length]));
  }

  fingerprint() {
    return stableHash(this.stats());
  }
}

export async function openStore(dir) {
  return Store.open({ dir });
}
