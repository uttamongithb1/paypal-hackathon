/**
 * Driver selector. Defaults to the bundled file store; refuses to boot silently against Mongo
 * (so a missing driver can never masquerade as "persistence works").
 */
import env from '../config/env.mjs';
import { openStore } from './store.mjs';
import { MONGO_DRIVER_NOT_IMPLEMENTED } from './mongo.driver.mjs';

export async function createStore() {
  if (env.mongoUri) {
    throw new Error(`MONGO_URI is set but ${MONGO_DRIVER_NOT_IMPLEMENTED}`);
  }
  return openStore(env.dataDir);
}

export default createStore;
