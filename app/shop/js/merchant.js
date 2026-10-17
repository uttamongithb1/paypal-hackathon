/**
 * Merchant dashboard (/merchant): catalogue management, orders with payment status, the discovery
 * funnel (views → cart adds → checkout attempts → completed purchases) and payment attempt audit.
 * Merchants can change products, prices and stock — they can never mark an order paid.
 */
import {
  merchantAnalytics, merchantAttempts, merchantCreateProduct, merchantOrderAction, merchantOrders,
  merchantOverview, merchantProducts, merchantRefundOrder, merchantUpdateProduct, money, state
} from './api.js';
import { settlementPanel, settlementBadge } from './settlement.js';
import { $, h, humanStatus, openModal, skeleton, statusTone, toast, closeModal } from './ui.js';

const range = { value: '7d' };

const funnelRow = (label, count, max) =>
  h('div', { class: 'funnel__row' }, [
    h('span', { text: label }),
    h('div', { class: 'funnel__track' }, [h('div', { class: 'funnel__bar', style: { width: `${Math.max(2, Math.round((count / Math.max(1, max)) * 100))}%` } })]),
    h('span', { class: 'num', text: String(count) })
  ]);

const sparkline = (series, key, label) => {
  const max = Math.max(1, ...series.map((point) => point[key] ?? 0));
  return h('div', { class: 'stack' }, [
    h('div', { class: 'note', text: label }),
    h('div', { class: 'spark' }, series.map((point) =>
      h('div', { class: 'spark__bar', style: { height: `${Math.max(3, Math.round(((point[key] ?? 0) / max) * 66))}px` }, title: `${point.date}: ${point[key] ?? 0}` })
    ))
  ]);
};

export async function renderMerchant() {
  const host = $('#merchant-body');
  host.replaceChildren(skeleton(5));

  if (!state.user || !['merchant', 'admin'].includes(state.user.role)) {
    host.replaceChildren(
      h('div', { class: 'empty-state empty-state--gate' }, [
        h('h1', { text: 'Merchant sign-in required' }),
        h('p', { class: 'note', text: 'Use the seeded merchant account to open the dashboard: merchant@demo.dev / Merchant@12345' }),
        h('button', {
          class: 'btn btn--primary',
          type: 'button',
          text: 'Sign in as the demo merchant',
          onclick: async () => {
            const { signIn } = await import('./api.js');
            try {
              await signIn('merchant@demo.dev', 'Merchant@12345');
              toast('Signed in as the demo merchant');
              renderMerchant();
            } catch (error) {
              toast(error.message, { tone: 'danger' });
            }
          }
        }),
        // The gate used to be a lone card in ~900px of white space, which read as a broken page
        // rather than a door. Say what is behind it.
        h('div', { class: 'gate-preview' }, [
          h('p', { class: 'gate-preview__label', text: 'Behind this sign-in' }),
          h('ul', { class: 'gate-preview__list' }, [
            h('li', { text: 'Paid revenue, orders in flight and conversion for the last 7 days' }),
            h('li', { text: 'The discovery funnel: views → cart → checkout → paid' }),
            h('li', { text: 'Per-SKU stock, sold counts and low-stock warnings' }),
            h('li', { text: 'Every settlement split, merchant by merchant' })
          ])
        ])
      ])
    );
    return;
  }

  try {
    const [overview, analytics, products, orders] = await Promise.all([
      merchantOverview(),
      merchantAnalytics(range.value),
      merchantProducts({ limit: 50 }),
      merchantOrders({ limit: 25 })
    ]);
    const funnel = analytics.funnel ?? {};
    const max = Math.max(1, funnel.views ?? 1);
    // Order-health numbers are derived from the lists we already have, so the KPI row can never
    // disagree with the table below it.
    const allOrders = orders.items ?? [];
    const inFlight = allOrders.filter((o) => ['awaiting_payment', 'payment_processing'].includes(o.status)).length;
    const failed = allOrders.filter((o) => ['payment_failed', 'expired', 'cancelled'].includes(o.status)).length;
    const productRows = products.items ?? [];
    const lowStock = (overview.lowStock ?? []).length ? overview.lowStock : productRows.filter((p) => p.stock > 0 && p.stock <= 3);
    const outOfStock = productRows.filter((p) => (p.stock ?? 0) <= 0).length;

    host.replaceChildren(
      h('div', { class: 'page-head' }, [
        h('h1', { text: 'Merchant dashboard' }),
        // The overview DTO carries no merchant object, so resolve the display name from the
        // merchant's own product rows rather than printing a raw id at the top of the dashboard.
        h('p', { class: 'muted', text: `Signed in as ${state.user.email} · ${productRows[0]?.merchant?.name ?? 'merchant'}` })
      ]),

      // ── KPIs ──────────────────────────────────────────────────────────────
      h('div', { class: 'section' }, [
        h('div', { class: 'kpi-grid' }, [
          // GET /merchant/overview answers a *flat* shape (docs/api_spec.md §merchant):
          // { revenueMinor, paidOrders, avgOrderValueMinor, conversionRateBps, lowStock[], recentOrders[] }.
          // Reading a nested `overview.revenue.paidMinor` silently rendered $0.00 forever.
          h('div', { class: 'kpi' }, [h('div', { class: 'kpi__label', text: 'Paid revenue (all time)' }), h('div', { class: 'kpi__value', text: overview.revenueDisplay ?? money(overview.revenueMinor ?? 0) }), h('div', { class: 'note', text: `${overview.paidOrders ?? 0} paid orders · avg ${overview.avgOrderValueDisplay ?? money(overview.avgOrderValueMinor ?? 0)}` })]),
          h('div', { class: 'kpi' }, [h('div', { class: 'kpi__label', text: 'Orders in flight' }), h('div', { class: 'kpi__value', text: String(inFlight) }), h('div', { class: 'note', text: `of ${overview.totalOrders ?? orders.total ?? 0} orders · ${failed} failed` })]),
          h('div', { class: 'kpi' }, [h('div', { class: 'kpi__label', text: 'Active products' }), h('div', { class: 'kpi__value', text: String(overview.products?.active ?? products.total ?? 0) }), h('div', { class: 'note', text: `${lowStock.length} low stock · ${outOfStock} out of stock` })]),
          h('div', { class: 'kpi' }, [h('div', { class: 'kpi__label', text: 'Conversion (view → purchase)' }), h('div', { class: 'kpi__value', text: `${((analytics.rates?.viewToPurchaseBps ?? 0) / 100).toFixed(1)}%` }), h('div', { class: 'note', text: `last ${analytics.range?.days ?? 7} days` })])
        ])
      ]),

      // ── Funnel ────────────────────────────────────────────────────────────
      h('div', { class: 'section' }, [
        h('div', { class: 'row row--between' }, [
          h('h2', { text: 'Discovery funnel' }),
          h('select', {
            style: { width: 'auto' },
            'aria-label': 'Analytics range',
            onchange: (event) => {
              range.value = event.target.value;
              renderMerchant();
            }
          }, [
            h('option', { value: '24h', text: 'Last 24 hours' }),
            h('option', { value: '7d', selected: range.value === '7d', text: 'Last 7 days' }),
            h('option', { value: '30d', selected: range.value === '30d', text: 'Last 30 days' })
          ])
        ]),
        h('div', { class: 'funnel' }, [
          funnelRow('Product views', funnel.views ?? 0, max),
          funnelRow('Adds to cart', funnel.cartAdds ?? 0, max),
          funnelRow('Checkout attempts', funnel.checkoutAttempts ?? 0, max),
          funnelRow('Completed purchases', funnel.purchases ?? 0, max)
        ]),
        h('div', { class: 'kpi-grid' }, [
          h('div', { class: 'kpi' }, [h('div', { class: 'kpi__label', text: 'View → cart' }), h('div', { class: 'kpi__value', text: `${((analytics.rates?.viewToCartBps ?? 0) / 100).toFixed(1)}%` })]),
          h('div', { class: 'kpi' }, [h('div', { class: 'kpi__label', text: 'Cart → checkout' }), h('div', { class: 'kpi__value', text: `${((analytics.rates?.cartToCheckoutBps ?? 0) / 100).toFixed(1)}%` })]),
          h('div', { class: 'kpi' }, [h('div', { class: 'kpi__label', text: 'Checkout → paid' }), h('div', { class: 'kpi__value', text: `${((analytics.rates?.checkoutToPaidBps ?? 0) / 100).toFixed(1)}%` })]),
          h('div', { class: 'kpi' }, [
            h('div', { class: 'kpi__label', text: 'Agent recommendations shown' }),
            h('div', { class: 'kpi__value', text: String(analytics.counts?.recommendationShown ?? 0) }),
            // Merchant-scoped count; chat/turn telemetry is platform-level (agent events carry no
            // merchant id), so it is labelled instead of being silently folded into the tile.
            h('div', { class: 'note', text: `${analytics.counts?.chatMessages ?? 0} chat messages · ${analytics.counts?.agentTurns ?? 0} agent turns (all stores)` })
          ])
        ]),
        h('div', { class: 'kpi-grid' }, [
          sparkline(analytics.timeseries ?? [], 'views', 'Views per day'),
          sparkline(analytics.timeseries ?? [], 'cartAdds', 'Cart adds per day'),
          sparkline(analytics.timeseries ?? [], 'purchases', 'Purchases per day')
        ]),
        analytics.topProducts?.length
          ? h('div', { class: 'table-wrap' }, [
              h('table', {}, [
                h('thead', {}, [h('tr', {}, [h('th', { text: 'Top products by views' }), h('th', { class: 'num', text: 'Views' }), h('th', { class: 'num', text: 'Cart adds' }), h('th', { class: 'num', text: 'Purchases' })])]),
                h('tbody', {}, analytics.topProducts.slice(0, 6).map((product) =>
                  h('tr', {}, [
                    h('td', { text: product.title ?? product.productId }),
                    h('td', { class: 'num', text: String(product.views ?? 0) }),
                    h('td', { class: 'num', text: String(product.cartAdds ?? 0) }),
                    h('td', { class: 'num', text: String(product.purchases ?? 0) })
                  ])
                ))
              ])
            ])
          : null
      ]),

      // ── Products ──────────────────────────────────────────────────────────
      h('div', { class: 'section' }, [
        h('div', { class: 'row row--between' }, [
          h('h2', { text: `Products (${products.total})` }),
          h('div', { class: 'row' }, [
            h('input', { id: 'product-search', placeholder: 'Search products…', style: { width: '220px' } }),
            h('button', { class: 'btn btn--primary btn--sm', type: 'button', text: '+ New product', onclick: openCreateProduct })
          ])
        ]),
        h('div', { class: 'table-wrap' }, [
          h('table', { id: 'products-table' }, [
            h('thead', {}, [h('tr', {}, [h('th', { text: 'Product' }), h('th', { class: 'num', text: 'Price' }), h('th', { class: 'num', text: 'Stock' }), h('th', { class: 'num', text: 'Sold' }), h('th', { text: 'Status' }), h('th', { text: '' })])]),
            h('tbody', {}, products.items.map((product) =>
              h('tr', { dataset: { title: product.title.toLowerCase() } }, [
                h('td', {}, [h('div', { text: product.title }), h('div', { class: 'card__merchant', text: `${product.categorySlug} · ${product.sku ?? ''}` })]),
                h('td', { class: 'num mono', text: money(product.price?.amountMinor ?? product.priceMinor) }),
                h('td', { class: 'num' }, [h('span', { class: `badge badge--${statusTone(product.availability)}`, text: String(product.stock?.available ?? product.stock) })]),
                h('td', { class: 'num', text: String(product.soldCount ?? 0) }),
                h('td', {}, [h('span', { class: `badge badge--${product.status === 'active' ? 'success' : 'muted'}`, text: homeStatus(product.status) })]),
                h('td', {}, [
                  h('div', { class: 'row' }, [
                    h('button', { class: 'btn btn--secondary btn--sm', type: 'button', text: 'Edit', onclick: () => openEditProduct(product) }),
                    h('button', {
                      class: 'btn btn--ghost btn--sm',
                      type: 'button',
                      text: product.status === 'active' ? 'Archive' : 'Re-activate',
                      onclick: async () => {
                        await merchantUpdateProduct(product.id, { status: product.status === 'active' ? 'archived' : 'active' });
                        toast(`${product.title} ${product.status === 'active' ? 'archived' : 'activated'}`);
                        renderMerchant();
                      }
                    })
                  ])
                ])
              ])
            ))
          ])
        ])
      ]),

      // ── Orders ────────────────────────────────────────────────────────────
      h('div', { class: 'section' }, [
        h('h2', { text: `Orders (${orders.total})` }),
        h('div', { class: 'table-wrap' }, [
          h('table', {}, [
            h('thead', {}, [h('tr', {}, [h('th', { text: 'Order' }), h('th', { text: 'Customer' }), h('th', { class: 'num', text: 'Total' }), h('th', { text: 'Order status' }), h('th', { text: 'Payment' }), h('th', { text: '' })])]),
            h('tbody', {}, orders.items.map((order) =>
              h('tr', {}, [
                h('td', {}, [h('div', { class: 'mono', text: order.orderNumber }), h('div', { class: 'card__merchant', text: new Date(order.createdAt).toLocaleString() })]),
                h('td', { text: order.contact?.email ?? '—' }),
                h('td', { class: 'num' }, [
                  h('div', { class: 'mono', text: order.amounts?.display?.total ?? money(order.amounts?.totalMinor) }),
                  // In a split settlement the merchant cares about their own unit, not the basket total.
                  (() => {
                    const unit = order.payment?.settlement?.units?.find((u) => u.merchantId === state.user?.merchantId);
                    if (order.payment?.settlement?.mode !== 'split' || !unit) return null;
                    return h('div', { class: 'note', text: `your share ${money(unit.amountMinor)} · commission ${money(unit.platformFeeMinor ?? 0)}` });
                  })()
                ]),
                h('td', {}, [h('span', { class: `badge badge--${statusTone(order.status)}`, text: humanStatus(order.status) })]),
                h('td', {}, [
                  h('div', { class: 'row' }, [
                    h('span', { class: `badge badge--${statusTone(order.payment?.status === 'succeeded' ? 'paid' : order.payment?.status === 'failed' ? 'failed' : 'pending')}`, text: `${humanStatus(order.payment?.status ?? 'none')} · ${order.payment?.lastAttemptNo ?? 0}` }),
                    settlementBadge(order)
                  ])
                ]),
                h('td', {}, [
                  h('div', { class: 'row' }, [
                    h('button', { class: 'btn btn--secondary btn--sm', type: 'button', text: 'Attempts', onclick: () => openAttempts(order) }),
                    ['paid', 'processing'].includes(order.status)
                      ? h('button', {
                          class: 'btn btn--ghost btn--sm',
                          type: 'button',
                          text: 'Mark shipped',
                          onclick: async () => {
                            await merchantOrderAction(order.id, { action: 'ship', trackingNumber: `SP${Date.now().toString().slice(-6)}` });
                            toast(`${order.orderNumber} marked shipped`);
                            renderMerchant();
                          }
                        })
                      : null,
                    ['paid', 'processing', 'shipped', 'delivered'].includes(order.status)
                      ? h('button', {
                          class: 'btn btn--ghost btn--sm',
                          type: 'button',
                          text: 'Refund',
                          onclick: async () => {
                            // A seller refunds the capture that holds *their* money. On a split
                            // order that is their own unit, not the whole basket — so say so
                            // before the button spends real (sandbox) money.
                            const unit = order.payment?.settlement?.units?.find((u) => u.merchantId === state.user?.merchantId);
                            const isSplit = order.payment?.settlement?.mode === 'split' && Boolean(unit);
                            const amount = isSplit ? money(unit.amountMinor) : (order.amounts?.display?.total ?? money(order.amounts?.totalMinor));
                            const scope = isSplit
                              ? `your share of ${amount} (the basket total is ${order.amounts?.display?.total}; the other seller's capture is untouched)`
                              : `the full ${amount}`;
                            if (!confirm(`Refund ${scope} on ${order.orderNumber}? This executes against PayPal.`)) return;
                            try {
                              const result = await merchantRefundOrder(order.id, { reason: 'Merchant return/cancellation' });
                              const refunded = result?.refundedMinor != null ? money(result.refundedMinor) : amount;
                              toast(result?.partial
                                ? `${order.orderNumber}: ${refunded} refunded (partial — the other seller's capture is untouched)`
                                : `${order.orderNumber}: ${refunded} refunded`);
                              renderMerchant();
                            } catch (e) {
                              toast(e.message || 'Refund failed', { tone: 'danger' });
                            }
                          }
                        })
                      : null
                  ])
                ])
              ])
            ))
          ])
        ]),
        h('p', { class: 'note', text: 'Merchant actions are limited to fulfilment. Payment status can only change through a verified PayPal capture or webhook.' })
      ])
    );

    $('#product-search')?.addEventListener('input', (event) => {
      const query = event.target.value.trim().toLowerCase();
      for (const row of host.querySelectorAll('#products-table tbody tr')) {
        row.hidden = Boolean(query) && !row.dataset.title.includes(query);
      }
    });
  } catch (error) {
    host.replaceChildren(h('div', { class: 'callout callout--danger', text: `${error.message} (${error.code})` }));
  }
}

const homeStatus = (status) => (status === 'active' ? 'active' : status ?? 'unknown');

function openCreateProduct() {
  const fields = {
    title: h('input', { placeholder: 'Title', value: '' }),
    slug: h('input', { placeholder: 'slug-like-this' }),
    categorySlug: h('select', {}, state.categories.map((category) => h('option', { value: category.slug, text: category.name ?? category.slug }))),
    brand: h('input', { placeholder: 'Brand' }),
    price: h('input', { type: 'number', min: '1', step: '0.01', placeholder: 'Price in USD, e.g. 899.00' }),
    stock: h('input', { type: 'number', min: '0', step: '1', placeholder: 'Stock' }),
    description: h('textarea', { rows: '3', placeholder: 'Short description' }),
    attributes: h('textarea', { rows: '3', placeholder: '{"ramGb":16,"storageGb":512}' })
  };
  const body = h('div', { class: 'stack' }, Object.entries(fields).map(([key, input]) =>
    h('div', {}, [h('label', { text: key.replace(/([A-Z])/g, ' $1') }), input])
  ));
  openModal({
    title: 'New product',
    body,
    actions: [
      h('button', { class: 'btn btn--ghost', type: 'button', text: 'Cancel', onclick: closeModal }),
      h('button', {
        class: 'btn btn--primary',
        type: 'button',
        text: 'Create product',
        onclick: async () => {
          try {
            await merchantCreateProduct({
              title: fields.title.value,
              slug: fields.slug.value,
              categorySlug: fields.categorySlug.value,
              brand: fields.brand.value,
              priceMinor: Math.round(Number(fields.price.value) * 100),
              stock: Number(fields.stock.value),
              description: fields.description.value,
              attributes: fields.attributes.value ? JSON.parse(fields.attributes.value) : {}
            });
            closeModal();
            toast('Product created', { tone: 'success' });
            renderMerchant();
          } catch (error) {
            toast(error.code === 'VALIDATION_ERROR' ? `Fix the form: ${error.message}` : error.message, { tone: 'danger' });
          }
        }
      })
    ]
  });
}

function openEditProduct(product) {
  const price = h('input', { type: 'number', min: '1', step: '0.01', value: ((product.price?.amountMinor ?? product.priceMinor) / 100).toFixed(2) });
  const stock = h('input', { type: 'number', min: '0', step: '1', value: String(product.stock?.available ?? product.stock ?? 0) });
  const status = h('select', {}, [
    h('option', { value: 'active', selected: product.status === 'active', text: 'active' }),
    h('option', { value: 'draft', selected: product.status === 'draft', text: 'draft' }),
    h('option', { value: 'archived', selected: product.status === 'archived', text: 'archived' })
  ]);
  openModal({
    title: `Edit ${product.title}`,
    body: h('div', { class: 'stack' }, [
      h('div', {}, [h('label', { text: 'Price (USD)' }), price]),
      h('div', {}, [h('label', { text: 'Stock on hand' }), stock]),
      h('div', {}, [h('label', { text: 'Status' }), status]),
      h('p', { class: 'note', text: 'Price changes are recorded in the product price history and re-checked at quote time — a customer can never be charged a price they did not approve.' })
    ]),
    actions: [
      h('button', { class: 'btn btn--ghost', type: 'button', text: 'Cancel', onclick: closeModal }),
      h('button', {
        class: 'btn btn--primary',
        type: 'button',
        text: 'Save changes',
        onclick: async () => {
          try {
            await merchantUpdateProduct(product.id, {
              priceMinor: Math.round(Number(price.value) * 100),
              stock: Number(stock.value),
              status: status.value
            });
            closeModal();
            toast('Product updated', { tone: 'success' });
            renderMerchant();
          } catch (error) {
            toast(error.message, { tone: 'danger' });
          }
        }
      })
    ]
  });
}

async function openAttempts(order) {
  const modal = openModal({ title: `Payment attempts · ${order.orderNumber}`, body: skeleton(2) });
  try {
    const { items } = await merchantAttempts(order.id);
    modal.querySelector('.modal__body').replaceChildren(
      h('div', { class: 'table-wrap' }, [
        h('table', {}, [
          h('thead', {}, [h('tr', {}, [h('th', { text: '#' }), h('th', { text: 'Status' }), h('th', { text: 'PayPal order' }), h('th', { text: 'Capture' }), h('th', { text: 'Error' }), h('th', { text: 'Created' })])]),
          h('tbody', {}, items.map((attempt) =>
            h('tr', {}, [
              h('td', { text: String(attempt.attemptNo) }),
              h('td', {}, [h('span', { class: `badge badge--${statusTone(attempt.status === 'succeeded' ? 'paid' : attempt.status === 'failed' ? 'failed' : 'pending')}`, text: attempt.status })]),
              h('td', { class: 'mono', text: attempt.paypalOrderId ?? '—' }),
              h('td', { class: 'mono', text: attempt.paypalCaptureId ?? '—' }),
              h('td', { class: 'mono', text: attempt.errorCode ?? '—' }),
              h('td', { text: new Date(attempt.createdAt).toLocaleTimeString() })
            ])
          ))
        ])
      ]),
      settlementPanel(order, { merchantId: state.user?.merchantId }),
      h('p', { class: 'note', text: 'Idempotency keys make each attempt safe to replay. A failed attempt never marks an order paid.' })
    );
  } catch (error) {
    modal.querySelector('.modal__body').replaceChildren(h('div', { class: 'callout callout--danger', text: error.message }));
  }
}
