/**
 * Service container — one place where everything is wired, so tests can build the same graph.
 */
import createStore from './store/index.mjs';
import AnalyticsService from './services/analytics.service.mjs';
import CatalogueService from './services/catalogue.service.mjs';
import InventoryService from './services/inventory.service.mjs';
import CartService from './services/cart.service.mjs';
import QuoteService from './services/quote.service.mjs';
import SessionService from './services/session.service.mjs';
import OrderService from './services/order.service.mjs';
import PaymentService from './services/payment.service.mjs';
import { createPaypalGateway } from './payments/paypal.gateway.mjs';
import ToolRegistry from './agent/tools.mjs';
import Orchestrator from './agent/orchestrator.mjs';
import logger from './lib/logger.mjs';
import env from './config/env.mjs';

export async function buildContainer({ store: providedStore } = {}) {
  const store = providedStore ?? (await createStore());
  const analytics = new AnalyticsService(store);
  const catalogue = new CatalogueService(store);
  const inventory = new InventoryService(store);
  // DTOs report available-to-sell (stock − active holds), so the catalogue needs the inventory view.
  catalogue.attachInventory(inventory);
  const cart = new CartService(store, { catalogue, inventory });
  const quote = new QuoteService(store, { catalogue, inventory, cart });
  const session = new SessionService(store, { cart, analytics });
  const payment = new PaymentService(store, { catalogue, cart, inventory, analytics, sessionService: session });
  const order = new OrderService(store, { catalogue, quote, inventory, cart, analytics, payment });
  payment.order = order;
  payment.quote = quote;

  const gateway = createPaypalGateway();
  payment.gateway = gateway;

  const tools = new ToolRegistry({ store, catalogue, cart, quote, order, inventory, analytics, env, logger });
  const orchestrator = new Orchestrator({ store, session, catalogue, cart, quote, order, payment, inventory, analytics, tools, logger });

  return { store, analytics, catalogue, inventory, cart, quote, session, order, payment, gateway, tools, orchestrator, logger, env };
}

export default buildContainer;
