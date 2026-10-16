/**
 * MongoDB driver stub. The reference build ships the file store (server/store/store.mjs), which
 * implements the same small surface the services use. To run against real MongoDB:
 *
 *   1. npm i mongoose
 *   2. set MONGO_URI in .env (a replica set is required for transactions — ../docs/env_setup.md §8)
 *   3. implement the methods below against the Mongoose schemas in ../docs/data_model.md and return
 *      the driver from `openStore()` in server/store/index.mjs
 *
 * The method surface the services rely on (keep it identical — nothing else changes):
 *   collection(name).find(filter, {sort, limit, skip, fields})  → Doc[]
 *   collection(name).findOne(filter)                            → Doc | null
 *   collection(name).count(filter)                              → number
 *   collection(name).insert(doc)                                → Doc
 *   collection(name).insertMany(docs)                           → Doc[]
 *   collection(name).updateOne(filter, update, {returnDocument, upsert}) → Doc | null
 *   collection(name).findOneAndUpdate(filter, update, {returnDocument})  → Doc | null   (atomic guard)
 *   collection(name).deleteOne(filter) / deleteMany(filter)     → { deletedCount }
 *   collection(name).distinct(field, filter)                    → any[]
 *   store.transact(fn)                                          → serialisable transaction
 *   store.nextSequence(name) / nextOrderNumber(year)
 *   store.once({scopeKey, ttlMs}, work)                          → idempotency guard
 *   store.sweepExpired(now)                                      → {collection: count}
 *   store.stats() / store.flush()
 */
export const MONGO_DRIVER_NOT_IMPLEMENTED =
  'MongoDB driver is not bundled with the reference build. See server/store/mongo.driver.mjs for the exact method surface to implement.';
