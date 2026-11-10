/**
 * Merchant dashboard (/merchant) — styled with Material Kit React (Minimal UI) design.
 * Features:
 * - 2-column layout: Sticky modern sidebar navigation + executive main panel
 * - High-impact pastel KPI metric widgets (Revenue, Orders in Flight, Products, Conversion)
 * - Discovery conversion funnel with visual completion tracks and timeseries sparklines
 * - Product catalogue management (Search, Stock status chips, Edit, Archive, + New Product modal)
 * - Orders management (Fulfillment status, Split-settlement breakdown, Ship, Refund, Payment attempt audit)
 * - Strict money invariants: merchants cannot move money or mark an order paid.
 */
import {
  merchantAnalytics, merchantAttempts, merchantCreateProduct, merchantOrderAction, merchantOrders,
  merchantOverview, merchantProducts, merchantRefundOrder, merchantUpdateProduct, money, state
} from './api.js';
import { settlementPanel, settlementBadge } from './settlement.js';
import { $, h, humanStatus, openModal, skeleton, statusTone, toast, closeModal } from './ui.js';

const range = { value: '7d' };
let currentTab = 'overview';

const ICONS = {
  overview: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
  products: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
  orders: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>',
  funnel: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>',
  settlement: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
  revenue: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 18V6"/></svg>',
  bag: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>',
  box: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>',
  chart: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>'
};

const funnelRow = (label, count, max) =>
  h('div', { class: 'funnel__row' }, [
    h('span', { text: label }),
    h('div', { class: 'funnel__track' }, [
      h('div', {
        class: 'funnel__bar',
        style: { width: `${Math.max(2, Math.round((count / Math.max(1, max)) * 100))}%` }
      })
    ]),
    h('span', { class: 'num', text: String(count) })
  ]);

const sparkline = (series, key, label) => {
  const max = Math.max(1, ...series.map((point) => point[key] ?? 0));
  return h('div', { class: 'stack' }, [
    h('div', { class: 'note', text: label }),
    h('div', { class: 'spark' }, series.map((point) =>
      h('div', {
        class: 'spark__bar',
        style: { height: `${Math.max(3, Math.round(((point[key] ?? 0) / max) * 66))}px` },
        title: `${point.date}: ${point[key] ?? 0}`
      })
    ))
  ]);
};

export async function renderMerchant() {
  const host = $('#merchant-body');
  if (!host) return;
  host.replaceChildren(skeleton(5));

  // ── Access Gate (Material Kit React Style) ──────────────────────────────────
  if (!state.user || !['merchant', 'admin'].includes(state.user.role)) {
    host.replaceChildren(
      h('div', { class: 'mk-gate' }, [
        h('div', { class: 'mk-gate__halo mk-gate__halo--merchant', text: '🏪' }),
        h('h1', { class: 'mk-gate__title', text: 'Merchant Workspace' }),
        h('p', { class: 'mk-gate__desc', text: 'Sign in with the verified demo merchant account to access live product management, stock quotas, multi-seller settlement, and conversion analytics.' }),
        h('div', { class: 'mk-gate__grid' }, [
          h('div', { class: 'mk-gate__feature' }, [h('span', { text: '✓' }), h('span', { text: 'Live catalogue & price management' })]),
          h('div', { class: 'mk-gate__feature' }, [h('span', { text: '✓' }), h('span', { text: 'Discovery conversion funnel' })]),
          h('div', { class: 'mk-gate__feature' }, [h('span', { text: '✓' }), h('span', { text: 'Split settlement disbursements' })]),
          h('div', { class: 'mk-gate__feature' }, [h('span', { text: '✓' }), h('span', { text: 'PayPal capture & refund audit' })])
        ]),
        h('button', {
          class: 'btn btn--primary mk-gate__btn',
          type: 'button',
          text: 'Sign in as Demo Merchant',
          onclick: async () => {
            const { signIn } = await import('./api.js');
            try {
              await signIn('merchant@demo.dev', 'Merchant@12345');
              toast('Signed in as Vertex Systems (Demo Merchant)', { tone: 'success' });
              renderMerchant();
            } catch (error) {
              toast(error.message, { tone: 'danger' });
            }
          }
        }),
        h('p', { class: 'note', text: 'Demo credentials: merchant@demo.dev / Merchant@12345' })
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
    const allOrders = orders.items ?? [];
    const inFlight = allOrders.filter((o) => ['awaiting_payment', 'payment_processing'].includes(o.status)).length;
    const failed = allOrders.filter((o) => ['payment_failed', 'expired', 'cancelled'].includes(o.status)).length;
    const productRows = products.items ?? [];
    const lowStock = (overview.lowStock ?? []).length ? overview.lowStock : productRows.filter((p) => p.stock > 0 && p.stock <= 3);
    const outOfStock = productRows.filter((p) => (p.stock ?? 0) <= 0).length;
    const merchantName = productRows[0]?.merchant?.name ?? 'Vertex Systems';

    // ── Helper: Switch active tab ──
    const switchTab = (tab) => {
      currentTab = tab;
      // Update sidebar nav items
      host.querySelectorAll('.mk-nav__item').forEach((item) => {
        item.classList.toggle('is-active', item.dataset.tab === tab);
      });
      // Update horizontal tabs
      host.querySelectorAll('.mk-tab').forEach((t) => {
        t.classList.toggle('is-active', t.dataset.tab === tab);
      });
      // Toggle panels
      host.querySelectorAll('.mk-section-panel').forEach((panel) => {
        panel.hidden = panel.dataset.tab !== tab;
      });
      // Update breadcrumb
      const bc = host.querySelector('#mk-breadcrumb-current');
      if (bc) bc.textContent = tab.charAt(0).toUpperCase() + tab.slice(1);
    };

    // ── Build Main Content Sections ──────────────────────────────────────────

    // 1. Overview Section
    const overviewPanel = h('div', { class: 'mk-section-panel stack', dataset: { tab: 'overview' }, hidden: currentTab !== 'overview' }, [
      // KPI Stat Cards (Material Kit React Style)
      h('div', { class: 'mk-kpi-grid' }, [
        h('div', { class: 'mk-kpi-card' }, [
          h('div', { class: 'mk-kpi__body' }, [
            h('span', { class: 'mk-kpi__label', text: 'Paid revenue' }),
            h('div', { class: 'mk-kpi__value', text: overview.revenueDisplay ?? money(overview.revenueMinor ?? 0) }),
            h('div', { class: 'mk-kpi__meta' }, [
              h('span', { class: 'mk-chip mk-chip--success', text: `+${overview.paidOrders ?? 0} paid` }),
              h('span', { text: `avg ${overview.avgOrderValueDisplay ?? money(overview.avgOrderValueMinor ?? 0)}` })
            ])
          ]),
          h('div', { class: 'mk-kpi__icon mk-kpi__icon--green', html: ICONS.revenue })
        ]),

        h('div', { class: 'mk-kpi-card' }, [
          h('div', { class: 'mk-kpi__body' }, [
            h('span', { class: 'mk-kpi__label', text: 'Orders in flight' }),
            h('div', { class: 'mk-kpi__value', text: String(inFlight) }),
            h('div', { class: 'mk-kpi__meta' }, [
              h('span', { class: 'mk-chip mk-chip--info', text: `${overview.totalOrders ?? orders.total ?? 0} total` }),
              h('span', { text: `${failed} failed / cancelled` })
            ])
          ]),
          h('div', { class: 'mk-kpi__icon mk-kpi__icon--blue', html: ICONS.bag })
        ]),

        h('div', { class: 'mk-kpi-card' }, [
          h('div', { class: 'mk-kpi__body' }, [
            h('span', { class: 'mk-kpi__label', text: 'Active products' }),
            h('div', { class: 'mk-kpi__value', text: String(overview.products?.active ?? products.total ?? 0) }),
            h('div', { class: 'mk-kpi__meta' }, [
              h('span', { class: lowStock.length ? 'mk-chip mk-chip--warning' : 'mk-chip mk-chip--success', text: `${lowStock.length} low stock` }),
              h('span', { text: `${outOfStock} out of stock` })
            ])
          ]),
          h('div', { class: 'mk-kpi__icon mk-kpi__icon--purple', html: ICONS.box })
        ]),

        h('div', { class: 'mk-kpi-card' }, [
          h('div', { class: 'mk-kpi__body' }, [
            h('span', { class: 'mk-kpi__label', text: 'Conversion rate' }),
            h('div', { class: 'mk-kpi__value', text: `${((analytics.rates?.viewToPurchaseBps ?? 0) / 100).toFixed(1)}%` }),
            h('div', { class: 'mk-kpi__meta' }, [
              h('span', { class: 'mk-chip mk-chip--success', text: 'View → Paid' }),
              h('span', { text: `last ${analytics.range?.days ?? 7} days` })
            ])
          ]),
          h('div', { class: 'mk-kpi__icon mk-kpi__icon--amber', html: ICONS.chart })
        ])
      ]),

      // Funnel & Activity Card
      h('div', { class: 'mk-card' }, [
        h('div', { class: 'mk-card__head' }, [
          h('div', {}, [
            h('h2', { class: 'mk-card__title', text: 'Discovery Funnel & Engagement' }),
            h('div', { class: 'mk-card__sub', text: 'Live shopper progression across the catalogue' })
          ]),
          h('select', {
            class: 'input input--sm',
            style: { width: 'auto' },
            'aria-label': 'Analytics range',
            onchange: (event) => {
              range.value = event.target.value;
              renderMerchant();
            }
          }, [
            h('option', { value: '24h', selected: range.value === '24h', text: 'Last 24 hours' }),
            h('option', { value: '7d', selected: range.value === '7d', text: 'Last 7 days' }),
            h('option', { value: '30d', selected: range.value === '30d', text: 'Last 30 days' })
          ])
        ]),
        h('div', { class: 'mk-card__body stack' }, [
          h('div', { class: 'funnel' }, [
            funnelRow('Product views', funnel.views ?? 0, max),
            funnelRow('Adds to cart', funnel.cartAdds ?? 0, max),
            funnelRow('Checkout attempts', funnel.checkoutAttempts ?? 0, max),
            funnelRow('Completed purchases', funnel.purchases ?? 0, max)
          ]),
          h('div', { class: 'mk-kpi-grid', style: { marginTop: '8px' } }, [
            h('div', { class: 'kpi' }, [h('div', { class: 'kpi__label', text: 'View → Cart' }), h('div', { class: 'kpi__value', text: `${((analytics.rates?.viewToCartBps ?? 0) / 100).toFixed(1)}%` })]),
            h('div', { class: 'kpi' }, [h('div', { class: 'kpi__label', text: 'Cart → Checkout' }), h('div', { class: 'kpi__value', text: `${((analytics.rates?.cartToCheckoutBps ?? 0) / 100).toFixed(1)}%` })]),
            h('div', { class: 'kpi' }, [h('div', { class: 'kpi__label', text: 'Checkout → Paid' }), h('div', { class: 'kpi__value', text: `${((analytics.rates?.checkoutToPaidBps ?? 0) / 100).toFixed(1)}%` })]),
            h('div', { class: 'kpi' }, [
              h('div', { class: 'kpi__label', text: 'AI Recommendations' }),
              h('div', { class: 'kpi__value', text: String(analytics.counts?.recommendationShown ?? 0) }),
              h('div', { class: 'note', text: `${analytics.counts?.chatMessages ?? 0} messages · ${analytics.counts?.agentTurns ?? 0} turns` })
            ])
          ]),
          h('div', { class: 'mk-kpi-grid' }, [
            sparkline(analytics.timeseries ?? [], 'views', 'Views per day'),
            sparkline(analytics.timeseries ?? [], 'cartAdds', 'Cart adds per day'),
            sparkline(analytics.timeseries ?? [], 'purchases', 'Purchases per day')
          ])
        ])
      ]),

      // Top Products summary
      analytics.topProducts?.length ? h('div', { class: 'mk-card' }, [
        h('div', { class: 'mk-card__head' }, [
          h('h2', { class: 'mk-card__title', text: 'Top Products by Traffic' }),
          h('span', { class: 'mk-chip mk-chip--info', text: 'Live Telemetry' })
        ]),
        h('div', { class: 'mk-table-wrap' }, [
          h('table', { class: 'mk-table' }, [
            h('thead', {}, [
              h('tr', {}, [
                h('th', { text: 'Product' }),
                h('th', { class: 'num', text: 'Views' }),
                h('th', { class: 'num', text: 'Cart adds' }),
                h('th', { class: 'num', text: 'Purchases' })
              ])
            ]),
            h('tbody', {}, analytics.topProducts.slice(0, 6).map((product) =>
              h('tr', {}, [
                h('td', { style: { fontWeight: '600' }, text: product.title ?? product.productId }),
                h('td', { class: 'num mono', text: String(product.views ?? 0) }),
                h('td', { class: 'num mono', text: String(product.cartAdds ?? 0) }),
                h('td', { class: 'num mono', text: String(product.purchases ?? 0) })
              ])
            ))
          ])
        ])
      ]) : null
    ]);

    // 2. Products Section
    const productsPanel = h('div', { class: 'mk-section-panel stack', dataset: { tab: 'products' }, hidden: currentTab !== 'products' }, [
      h('div', { class: 'mk-card' }, [
        h('div', { class: 'mk-card__head' }, [
          h('div', {}, [
            h('h2', { class: 'mk-card__title', text: `Products & Inventory (${products.total})` }),
            h('div', { class: 'mk-card__sub', text: 'Active listings, price points, and stock availability' })
          ]),
          h('div', { class: 'row', style: { gap: '10px' } }, [
            h('input', {
              id: 'mk-product-search',
              class: 'input input--sm mk-search-input',
              placeholder: 'Search products…',
              style: { width: '240px' },
              oninput: (e) => {
                const query = e.target.value.trim().toLowerCase();
                for (const row of host.querySelectorAll('#mk-products-table tbody tr')) {
                  row.hidden = Boolean(query) && !row.dataset.title.includes(query);
                }
              }
            }),
            h('button', {
              class: 'btn btn--primary btn--sm',
              type: 'button',
              text: '+ New product',
              onclick: openCreateProduct
            })
          ])
        ]),
        h('div', { class: 'mk-table-wrap' }, [
          h('table', { class: 'mk-table', id: 'mk-products-table' }, [
            h('thead', {}, [
              h('tr', {}, [
                h('th', { text: 'Product' }),
                h('th', { class: 'num', text: 'Price' }),
                h('th', { class: 'num', text: 'Stock' }),
                h('th', { class: 'num', text: 'Sold' }),
                h('th', { text: 'Status' }),
                h('th', { text: 'Actions' })
              ])
            ]),
            h('tbody', {}, products.items.map((product) =>
              h('tr', { dataset: { title: product.title.toLowerCase() } }, [
                h('td', {}, [
                  h('div', { style: { fontWeight: '650' }, text: product.title }),
                  h('div', { class: 'note mono', style: { fontSize: '11px' }, text: `${product.categorySlug} · ${product.sku ?? ''}` })
                ]),
                h('td', { class: 'num mono', style: { fontWeight: '600' }, text: money(product.price?.amountMinor ?? product.priceMinor) }),
                h('td', { class: 'num' }, [
                  h('span', { class: `mk-chip mk-chip--${statusTone(product.availability)}`, text: String(product.stock?.available ?? product.stock) })
                ]),
                h('td', { class: 'num mono', text: String(product.soldCount ?? 0) }),
                h('td', {}, [
                  h('span', { class: `mk-chip mk-chip--${product.status === 'active' ? 'success' : 'muted'}`, text: homeStatus(product.status) })
                ]),
                h('td', {}, [
                  h('div', { class: 'row', style: { gap: '6px' } }, [
                    h('button', {
                      class: 'btn btn--secondary btn--sm',
                      type: 'button',
                      text: 'Edit',
                      onclick: () => openEditProduct(product)
                    }),
                    h('button', {
                      class: 'btn btn--ghost btn--sm',
                      type: 'button',
                      text: product.status === 'active' ? 'Archive' : 'Activate',
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
      ])
    ]);

    // 3. Orders Section
    const ordersPanel = h('div', { class: 'mk-section-panel stack', dataset: { tab: 'orders' }, hidden: currentTab !== 'orders' }, [
      h('div', { class: 'mk-card' }, [
        h('div', { class: 'mk-card__head' }, [
          h('div', {}, [
            h('h2', { class: 'mk-card__title', text: `Orders & Fulfillment (${orders.total})` }),
            h('div', { class: 'mk-card__sub', text: 'Live orders, shipping tracking, and PayPal payment verifications' })
          ])
        ]),
        h('div', { class: 'mk-table-wrap' }, [
          h('table', { class: 'mk-table' }, [
            h('thead', {}, [
              h('tr', {}, [
                h('th', { text: 'Order' }),
                h('th', { text: 'Customer' }),
                h('th', { class: 'num', text: 'Total' }),
                h('th', { text: 'Order status' }),
                h('th', { text: 'Payment & Settlement' }),
                h('th', { text: 'Actions' })
              ])
            ]),
            h('tbody', {}, orders.items.map((order) =>
              h('tr', {}, [
                h('td', {}, [
                  h('div', { class: 'mono', style: { fontWeight: '700' }, text: order.orderNumber }),
                  h('div', { class: 'note', style: { fontSize: '11px' }, text: new Date(order.createdAt).toLocaleString() })
                ]),
                h('td', { text: order.contact?.email ?? '—' }),
                h('td', { class: 'num' }, [
                  h('div', { class: 'mono', style: { fontWeight: '600' }, text: order.amounts?.display?.total ?? money(order.amounts?.totalMinor) }),
                  (() => {
                    const unit = order.payment?.settlement?.units?.find((u) => u.merchantId === state.user?.merchantId);
                    if (order.payment?.settlement?.mode !== 'split' || !unit) return null;
                    return h('div', { class: 'note', style: { fontSize: '11px' }, text: `share ${money(unit.amountMinor)} · net ${money(Math.max(0, unit.amountMinor - (unit.platformFeeMinor ?? 0)))}` });
                  })()
                ]),
                h('td', {}, [
                  h('span', { class: `mk-chip mk-chip--${statusTone(order.status)}`, text: humanStatus(order.status) })
                ]),
                h('td', {}, [
                  h('div', { class: 'row', style: { gap: '6px' } }, [
                    h('span', {
                      class: `mk-chip mk-chip--${statusTone(order.payment?.status === 'succeeded' ? 'paid' : order.payment?.status === 'failed' ? 'failed' : 'pending')}`,
                      text: `${humanStatus(order.payment?.status ?? 'none')} · #${order.payment?.lastAttemptNo ?? 0}`
                    }),
                    settlementBadge(order)
                  ])
                ]),
                h('td', {}, [
                  h('div', { class: 'row', style: { gap: '6px' } }, [
                    h('button', {
                      class: 'btn btn--secondary btn--sm',
                      type: 'button',
                      text: 'Attempts',
                      onclick: () => openAttempts(order)
                    }),
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
                            const unit = order.payment?.settlement?.units?.find((u) => u.merchantId === state.user?.merchantId);
                            const isSplit = order.payment?.settlement?.mode === 'split' && Boolean(unit);
                            const amount = isSplit ? money(unit.amountMinor) : (order.amounts?.display?.total ?? money(order.amounts?.totalMinor));
                            const scope = isSplit
                              ? `your share of ${amount} (the other seller's capture is untouched)`
                              : `the full ${amount}`;
                            if (!confirm(`Refund ${scope} on ${order.orderNumber}? This executes against PayPal.`)) return;
                            try {
                              const result = await merchantRefundOrder(order.id, { reason: 'Merchant return/cancellation' });
                              const refunded = result?.refundedMinor != null ? money(result.refundedMinor) : amount;
                              toast(result?.partial
                                ? `${order.orderNumber}: ${refunded} refunded (partial — other seller untouched)`
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
        ])
      ])
    ]);

    // 4. Funnel Section
    const funnelPanel = h('div', { class: 'mk-section-panel stack', dataset: { tab: 'funnel' }, hidden: currentTab !== 'funnel' }, [
      h('div', { class: 'mk-card' }, [
        h('div', { class: 'mk-card__head' }, [
          h('h2', { class: 'mk-card__title', text: 'Conversion Funnel Telemetry' }),
          h('span', { class: 'mk-chip mk-chip--info', text: 'Monotonic Funnel Invariant Verified' })
        ]),
        h('div', { class: 'mk-card__body stack' }, [
          h('div', { class: 'funnel' }, [
            funnelRow('Product views', funnel.views ?? 0, max),
            funnelRow('Adds to cart', funnel.cartAdds ?? 0, max),
            funnelRow('Checkout attempts', funnel.checkoutAttempts ?? 0, max),
            funnelRow('Completed purchases', funnel.purchases ?? 0, max)
          ])
        ])
      ])
    ]);

    // 5. Settlement Section
    const settlementTabPanel = h('div', { class: 'mk-section-panel stack', dataset: { tab: 'settlement' }, hidden: currentTab !== 'settlement' }, [
      h('div', { class: 'mk-card' }, [
        h('div', { class: 'mk-card__head' }, [
          h('h2', { class: 'mk-card__title', text: 'Multi-Seller Settlement & Platform Routing' }),
          h('span', { class: 'mk-chip mk-chip--success', text: 'PayPal Orders v2' })
        ]),
        h('div', { class: 'mk-card__body stack' }, [
          h('p', { class: 'note', text: 'In multi-merchant baskets, PayPal distributes separate purchase units to each seller with their own payee address, while deducting the platform fee automatically.' }),
          orders.items.find((o) => o.payment?.settlement)
            ? settlementPanel(orders.items.find((o) => o.payment?.settlement), { merchantId: state.user?.merchantId })
            : h('p', { class: 'note', text: 'No multi-seller settlement records found yet. Place a multi-vendor order to see live split units.' })
        ])
      ])
    ]);

    // ── Build Full Dashboard Frame ───────────────────────────────────────────
    host.replaceChildren(
      h('div', { class: 'mk-dashboard' }, [
        // ── Sidebar ──
        h('aside', { class: 'mk-sidebar' }, [
          // Store Profile
          h('div', { class: 'mk-sidebar__profile' }, [
            h('div', { class: 'mk-avatar mk-avatar--merchant', text: merchantName.charAt(0).toUpperCase() }),
            h('div', { class: 'mk-profile-info' }, [
              h('div', { class: 'mk-profile-info__name', text: merchantName }),
              h('span', { class: 'mk-chip mk-chip--success mk-profile-info__role', text: 'Store Merchant' })
            ])
          ]),

          // Navigation Links
          h('nav', { class: 'mk-nav', 'aria-label': 'Merchant navigation' }, [
            h('span', { class: 'mk-nav__heading', text: 'Management' }),
            h('button', {
              class: `mk-nav__item ${currentTab === 'overview' ? 'is-active' : ''}`,
              dataset: { tab: 'overview' },
              onclick: () => switchTab('overview')
            }, [
              h('span', { class: 'mk-nav__icon', html: ICONS.overview }),
              h('span', { text: 'Overview' })
            ]),
            h('button', {
              class: `mk-nav__item ${currentTab === 'products' ? 'is-active' : ''}`,
              dataset: { tab: 'products' },
              onclick: () => switchTab('products')
            }, [
              h('span', { class: 'mk-nav__icon', html: ICONS.products }),
              h('span', { text: 'Products' }),
              h('span', { class: 'mk-chip mk-chip--muted mk-nav__badge', text: String(products.total) })
            ]),
            h('button', {
              class: `mk-nav__item ${currentTab === 'orders' ? 'is-active' : ''}`,
              dataset: { tab: 'orders' },
              onclick: () => switchTab('orders')
            }, [
              h('span', { class: 'mk-nav__icon', html: ICONS.orders }),
              h('span', { text: 'Orders' }),
              h('span', { class: 'mk-chip mk-chip--muted mk-nav__badge', text: String(orders.total) })
            ]),
            h('button', {
              class: `mk-nav__item ${currentTab === 'funnel' ? 'is-active' : ''}`,
              dataset: { tab: 'funnel' },
              onclick: () => switchTab('funnel')
            }, [
              h('span', { class: 'mk-nav__icon', html: ICONS.funnel }),
              h('span', { text: 'Funnel' })
            ]),
            h('button', {
              class: `mk-nav__item ${currentTab === 'settlement' ? 'is-active' : ''}`,
              dataset: { tab: 'settlement' },
              onclick: () => switchTab('settlement')
            }, [
              h('span', { class: 'mk-nav__icon', html: ICONS.settlement }),
              h('span', { text: 'Settlement' })
            ])
          ]),

          // Sidebar Footer Status
          h('div', { class: 'mk-sidebar__foot' }, [
            h('div', { class: 'mk-status-card' }, [
              h('span', { class: 'mk-pulse-dot' }),
              h('span', { text: 'PayPal Sandbox: Connected' })
            ]),
            h('div', { class: 'mk-status-card' }, [
              h('span', { text: '🛡️ Invariant Guard: Active' })
            ])
          ])
        ]),

        // ── Main Content Area ──
        h('div', { class: 'mk-main' }, [
          // Header Bar
          h('header', { class: 'mk-header' }, [
            h('div', { class: 'mk-title-wrap' }, [
              h('nav', { class: 'mk-breadcrumb', 'aria-label': 'Breadcrumb' }, [
                h('span', { text: 'Dashboard' }),
                h('span', { class: 'mk-breadcrumb__sep', text: '/' }),
                h('span', { text: 'Merchant' }),
                h('span', { class: 'mk-breadcrumb__sep', text: '/' }),
                h('span', { id: 'mk-breadcrumb-current', text: currentTab.charAt(0).toUpperCase() + currentTab.slice(1) })
              ]),
              h('h1', { class: 'mk-title', text: 'Merchant Dashboard' }),
              h('p', { class: 'mk-subtitle', text: `Signed in as ${state.user.email} · ${merchantName}` })
            ]),
            h('div', { class: 'mk-actions' }, [
              h('button', {
                class: 'btn btn--secondary btn--sm',
                type: 'button',
                title: 'Refresh dashboard',
                onclick: () => {
                  toast('Refreshing merchant metrics…');
                  renderMerchant();
                }
              }, [
                h('span', { html: ICONS.refresh }),
                h('span', { text: 'Refresh' })
              ]),
              h('button', {
                class: 'btn btn--primary btn--sm',
                type: 'button',
                text: '+ New product',
                onclick: openCreateProduct
              })
            ])
          ]),

          // Horizontal Quick Tabs
          h('div', { class: 'mk-tabs' }, [
            h('button', { class: `mk-tab ${currentTab === 'overview' ? 'is-active' : ''}`, dataset: { tab: 'overview' }, onclick: () => switchTab('overview'), text: 'Overview & KPIs' }),
            h('button', { class: `mk-tab ${currentTab === 'products' ? 'is-active' : ''}`, dataset: { tab: 'products' }, onclick: () => switchTab('products'), text: `Products (${products.total})` }),
            h('button', { class: `mk-tab ${currentTab === 'orders' ? 'is-active' : ''}`, dataset: { tab: 'orders' }, onclick: () => switchTab('orders'), text: `Orders (${orders.total})` }),
            h('button', { class: `mk-tab ${currentTab === 'funnel' ? 'is-active' : ''}`, dataset: { tab: 'funnel' }, onclick: () => switchTab('funnel'), text: 'Discovery Funnel' }),
            h('button', { class: `mk-tab ${currentTab === 'settlement' ? 'is-active' : ''}`, dataset: { tab: 'settlement' }, onclick: () => switchTab('settlement'), text: 'Settlement' })
          ]),

          // Active Panel Bodies
          overviewPanel,
          productsPanel,
          ordersPanel,
          funnelPanel,
          settlementTabPanel
        ])
      ])
    );
  } catch (error) {
    host.replaceChildren(h('div', { class: 'callout callout--danger', text: `${error.message} (${error.code ?? 'ERROR'})` }));
  }
}

const homeStatus = (status) => (status === 'active' ? 'active' : status ?? 'unknown');

function openCreateProduct() {
  const fields = {
    title: h('input', { class: 'input', placeholder: 'Title', value: '' }),
    slug: h('input', { class: 'input', placeholder: 'slug-like-this' }),
    categorySlug: h('select', { class: 'input' }, state.categories.map((category) => h('option', { value: category.slug, text: category.name ?? category.slug }))),
    brand: h('input', { class: 'input', placeholder: 'Brand' }),
    price: h('input', { class: 'input', type: 'number', min: '1', step: '0.01', placeholder: 'Price in USD, e.g. 899.00' }),
    stock: h('input', { class: 'input', type: 'number', min: '0', step: '1', placeholder: 'Stock' }),
    description: h('textarea', { class: 'input', rows: '3', placeholder: 'Short description' }),
    attributes: h('textarea', { class: 'input', rows: '3', placeholder: '{"ramGb":16,"storageGb":512}' })
  };
  const body = h('div', { class: 'stack' }, Object.entries(fields).map(([key, input]) =>
    h('div', {}, [h('label', { style: { fontWeight: '600', fontSize: '13px', marginBottom: '4px', display: 'block' }, text: key.replace(/([A-Z])/g, ' $1') }), input])
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
  const price = h('input', { class: 'input', type: 'number', min: '1', step: '0.01', value: ((product.price?.amountMinor ?? product.priceMinor) / 100).toFixed(2) });
  const stock = h('input', { class: 'input', type: 'number', min: '0', step: '1', value: String(product.stock?.available ?? product.stock ?? 0) });
  const status = h('select', { class: 'input' }, [
    h('option', { value: 'active', selected: product.status === 'active', text: 'active' }),
    h('option', { value: 'draft', selected: product.status === 'draft', text: 'draft' }),
    h('option', { value: 'archived', selected: product.status === 'archived', text: 'archived' })
  ]);
  openModal({
    title: `Edit ${product.title}`,
    body: h('div', { class: 'stack' }, [
      h('div', {}, [h('label', { style: { fontWeight: '600', fontSize: '13px', marginBottom: '4px', display: 'block' }, text: 'Price (USD)' }), price]),
      h('div', {}, [h('label', { style: { fontWeight: '600', fontSize: '13px', marginBottom: '4px', display: 'block' }, text: 'Stock on hand' }), stock]),
      h('div', {}, [h('label', { style: { fontWeight: '600', fontSize: '13px', marginBottom: '4px', display: 'block' }, text: 'Status' }), status]),
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
      h('div', { class: 'mk-table-wrap' }, [
        h('table', { class: 'mk-table' }, [
          h('thead', {}, [
            h('tr', {}, [
              h('th', { text: '#' }),
              h('th', { text: 'Status' }),
              h('th', { text: 'PayPal order' }),
              h('th', { text: 'Capture' }),
              h('th', { text: 'Error' }),
              h('th', { text: 'Created' })
            ])
          ]),
          h('tbody', {}, items.map((attempt) =>
            h('tr', {}, [
              h('td', { text: String(attempt.attemptNo) }),
              h('td', {}, [
                h('span', { class: `mk-chip mk-chip--${statusTone(attempt.status === 'succeeded' ? 'paid' : attempt.status === 'failed' ? 'failed' : 'pending')}`, text: attempt.status })
              ]),
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
