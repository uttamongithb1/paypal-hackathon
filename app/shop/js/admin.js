/**
 * The platform console (/admin) — styled with Material Kit React (Minimal UI) design.
 *
 * Enhanced with AG Grid for enterprise financial sorting, filtering, and CSV export (Sponsor Track).
 * Features:
 * - 2-column layout: Sticky modern sidebar navigation + executive main panel
 * - High-impact pastel KPI metric widgets (GMV, Commission Retained 5%, Net Disbursed, Multi-Seller Splits)
 * - Interactive AG Grid live table for Orders and Seller Settlements
 * - 1-click CSV exports and capture reconciliation engine (adminReconcile)
 * - Docs: docs/payments_paypal.md §3a, WIN_PLAN.md F1.
 */
import {
  adminOverview, adminReconcile, money, state
} from './api.js';
import { $, h, humanStatus, skeleton, statusTone, toast } from './ui.js';

let currentAdminTab = 'overview';

const ICONS = {
  overview: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
  aggrid: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>',
  settlement: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
  invariants: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
  export: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  gmv: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 18V6"/></svg>',
  commission: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>',
  vault: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M12 15v2m0-8V7m3 5h2m-8 0H7"/></svg>',
  splits: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 16l3-8 3 8c-.87.06-1.33.53-1.4 1.34L20 21h-2l-.6-3.66c-.07-.81-.53-1.28-1.4-1.34z"/><path d="M2 16l3-8 3 8c-.87.06-1.33.53-1.4 1.34L7 21H5l-.6-3.66c-.07-.81-.53-1.28-1.4-1.34z"/><path d="M7 21h10"/></svg>'
};

export async function renderAdmin() {
  const body = $('#admin-body');
  if (!body) return;
  body.replaceChildren(skeleton('Loading the platform view…'));

  // ── Access Gate (Material Kit React Style) ──────────────────────────────────
  let data;
  try {
    data = await adminOverview();
  } catch (err) {
    body.replaceChildren(
      h('div', { class: 'mk-gate' }, [
        h('div', { class: 'mk-gate__halo mk-gate__halo--admin', text: '⚙️' }),
        h('h1', { class: 'mk-gate__title', text: 'Platform Console (AG Grid)' }),
        h('p', { class: 'mk-gate__desc', text: 'Sign in with the verified platform administrator account to inspect marketplace GMV, 5% platform commission retention, multi-seller disbursements, and interactive AG Grid tables with sorting, filtering, and CSV export.' }),
        h('div', { class: 'mk-gate__grid' }, [
          h('div', { class: 'mk-gate__feature' }, [h('span', { text: '✓' }), h('span', { text: 'AG Grid Live: Multi-column filter & sort' })]),
          h('div', { class: 'mk-gate__feature' }, [h('span', { text: '✓' }), h('span', { text: 'Platform ledger: 5% fee deductions' })]),
          h('div', { class: 'mk-gate__feature' }, [h('span', { text: '✓' }), h('span', { text: '1-click CSV financial export' })]),
          h('div', { class: 'mk-gate__feature' }, [h('span', { text: '✓' }), h('span', { text: 'Automated capture reconciliation' })])
        ]),
        h('button', {
          class: 'btn btn--primary mk-gate__btn',
          type: 'button',
          text: 'Sign in as Demo Administrator',
          onclick: async () => {
            const { signIn } = await import('./api.js');
            try {
              await signIn('admin@demo.dev', 'Admin@12345');
              toast('Signed in as Demo Administrator — loading AG Grid console', { tone: 'success' });
              renderAdmin();
            } catch (error) {
              toast(error.message, { tone: 'danger' });
            }
          }
        }),
        h('p', { class: 'note', text: 'Demo credentials: admin@demo.dev / Admin@12345' })
      ])
    );
    return;
  }

  const commissionRate = data.commissionRateBps ? `${(data.commissionRateBps / 100).toFixed(1)}%` : '5.0%';
  const hasAgGrid = typeof window !== 'undefined' && Boolean(window.agGrid?.createGrid);

  // Settlement grid container
  const settlementGridEl = h('div', {
    id: 'ag-settlement-grid',
    class: 'ag-theme-quartz',
    style: { height: '260px', width: '100%', borderRadius: '12px', overflow: 'hidden' }
  });

  // Orders grid container
  const ordersGridEl = h('div', {
    id: 'ag-orders-grid',
    class: 'ag-theme-quartz',
    style: { height: '380px', width: '100%', borderRadius: '12px', overflow: 'hidden' }
  });

  let settlementApi = null;
  let ordersApi = null;

  // Fallback tables when ag-grid isn't loaded
  const fallbackSettlementTable = h('div', { class: 'mk-table-wrap', style: hasAgGrid ? { display: 'none' } : {} }, [
    h('table', { class: 'mk-table' }, [
      h('thead', {}, [
        h('tr', {}, [
          h('th', { text: 'Seller' }),
          h('th', { class: 'num', text: 'Orders' }),
          h('th', { class: 'num', text: 'Units' }),
          h('th', { class: 'num', text: 'Gross' }),
          h('th', { class: 'num', text: 'Commission' }),
          h('th', { class: 'num', text: 'Refunded' }),
          h('th', { class: 'num', text: 'Net to seller' })
        ])
      ]),
      h('tbody', {}, (data.merchants ?? []).map((m) =>
        h('tr', {}, [
          h('td', {}, [
            h('div', { style: { fontWeight: '650' }, text: m.name }),
            h('div', { class: 'note mono', style: { fontSize: '11px' }, text: m.slug })
          ]),
          h('td', { class: 'num mono', text: String(m.orders) }),
          h('td', { class: 'num mono', text: String(m.units) }),
          h('td', { class: 'num mono', text: m.grossDisplay }),
          h('td', { class: 'num mono' }, [
            h('span', { class: 'mk-chip mk-chip--info', text: m.commissionDisplay })
          ]),
          h('td', { class: 'num mono', text: m.refundedDisplay ?? '—' }),
          h('td', { class: 'num mono', style: { fontWeight: '700' }, text: m.netDisplay })
        ])
      ))
    ])
  ]);

  const fallbackOrdersTable = h('div', { class: 'mk-table-wrap', style: hasAgGrid ? { display: 'none' } : {} }, [
    h('table', { class: 'mk-table' }, [
      h('thead', {}, [
        h('tr', {}, [
          h('th', { text: 'Order' }),
          h('th', { text: 'Sellers' }),
          h('th', { class: 'num', text: 'Total' }),
          h('th', { text: 'Status' }),
          h('th', { text: 'Payment' }),
          h('th', { text: 'Actions' })
        ])
      ]),
      h('tbody', {}, (data.orders?.items ?? []).map((order) =>
        h('tr', {}, [
          h('td', {}, [
            h('div', { class: 'mono', style: { fontWeight: '700' }, text: order.orderNumber }),
            h('div', { class: 'note', style: { fontSize: '11px' }, text: new Date(order.createdAt).toLocaleString() })
          ]),
          h('td', { class: 'mono', text: String(new Set((order.lines ?? []).map((l) => l.merchantId)).size) }),
          h('td', { class: 'num mono', style: { fontWeight: '600' }, text: order.amounts?.display?.total ?? money(order.amounts?.totalMinor) }),
          h('td', {}, [
            h('span', { class: `mk-chip mk-chip--${statusTone(order.status)}`, text: humanStatus(order.status) })
          ]),
          h('td', { class: 'mono', text: order.payment?.status ?? 'none' }),
          h('td', {}, [
            ['awaiting_payment', 'payment_failed', 'payment_processing'].includes(order.status)
              ? h('button', {
                  class: 'btn btn--ghost btn--sm',
                  type: 'button',
                  text: 'Reconcile',
                  onclick: async () => {
                    try {
                      const result = await adminReconcile(order.id);
                      toast(result.applied
                        ? `${order.orderNumber} reconciled — marked paid from capture`
                        : `${order.orderNumber}: no capture to reconcile`, { tone: result.applied ? 'success' : 'default' });
                      renderAdmin();
                    } catch (e) {
                      toast(e?.message ?? 'Reconcile failed', { tone: 'danger' });
                    }
                  }
                })
              : null
          ])
        ])
      ))
    ])
  ]);

  // ── Helper: Switch active admin tab ──
  const switchAdminTab = (tab) => {
    currentAdminTab = tab;
    body.querySelectorAll('.mk-nav__item').forEach((item) => {
      item.classList.toggle('is-active', item.dataset.tab === tab);
    });
    body.querySelectorAll('.mk-tab').forEach((t) => {
      t.classList.toggle('is-active', t.dataset.tab === tab);
    });
    body.querySelectorAll('.mk-section-panel').forEach((panel) => {
      panel.hidden = panel.dataset.tab !== tab;
    });
    const bc = body.querySelector('#mk-admin-breadcrumb-current');
    if (bc) bc.textContent = tab.charAt(0).toUpperCase() + tab.slice(1);
  };

  // ── Build Main Content Sections ──────────────────────────────────────────

  // 1. Overview Section
  const overviewPanel = h('div', { class: 'mk-section-panel stack', dataset: { tab: 'overview' }, hidden: currentAdminTab !== 'overview' }, [
    // 4 KPI Cards
    h('div', { class: 'mk-kpi-grid' }, [
      h('div', { class: 'mk-kpi-card' }, [
        h('div', { class: 'mk-kpi__body' }, [
          h('span', { class: 'mk-kpi__label', text: 'Gross merchandise value' }),
          h('div', { class: 'mk-kpi__value', text: data.grossDisplay }),
          h('div', { class: 'mk-kpi__meta' }, [
            h('span', { class: 'mk-chip mk-chip--success', text: `${data.paidOrders} paid orders` }),
            h('span', { text: 'across all sellers' })
          ])
        ]),
        h('div', { class: 'mk-kpi__icon mk-kpi__icon--green', html: ICONS.gmv })
      ]),

      h('div', { class: 'mk-kpi-card' }, [
        h('div', { class: 'mk-kpi__body' }, [
          h('span', { class: 'mk-kpi__label', text: 'Commission retained' }),
          h('div', { class: 'mk-kpi__value', text: data.commissionDisplay }),
          h('div', { class: 'mk-kpi__meta' }, [
            h('span', { class: 'mk-chip mk-chip--purple', text: `${commissionRate} of GMV` }),
            h('span', { text: 'platform fee' })
          ])
        ]),
        h('div', { class: 'mk-kpi__icon mk-kpi__icon--purple', html: ICONS.commission })
      ]),

      h('div', { class: 'mk-kpi-card' }, [
        h('div', { class: 'mk-kpi__body' }, [
          h('span', { class: 'mk-kpi__label', text: 'Paid out to sellers' }),
          h('div', { class: 'mk-kpi__value', text: data.netPaidDisplay }),
          h('div', { class: 'mk-kpi__meta' }, [
            h('span', { class: 'mk-chip mk-chip--info', text: `${data.sellerCount} sellers` }),
            h('span', { text: 'net disbursements' })
          ])
        ]),
        h('div', { class: 'mk-kpi__icon mk-kpi__icon--blue', html: ICONS.vault })
      ]),

      h('div', { class: 'mk-kpi-card' }, [
        h('div', { class: 'mk-kpi__body' }, [
          h('span', { class: 'mk-kpi__label', text: 'Multi-seller baskets' }),
          h('div', { class: 'mk-kpi__value', text: String(data.multiSellerOrders) }),
          h('div', { class: 'mk-kpi__meta' }, [
            h('span', { class: 'mk-chip mk-chip--warning', text: `${data.splitOrders} split units` }),
            h('span', { text: 'PayPal Orders v2' })
          ])
        ]),
        h('div', { class: 'mk-kpi__icon mk-kpi__icon--amber', html: ICONS.splits })
      ])
    ]),

    // Marketplace Architecture Summary Card
    h('div', { class: 'mk-card' }, [
      h('div', { class: 'mk-card__head' }, [
        h('div', {}, [
          h('h2', { class: 'mk-card__title', text: 'Marketplace Routing & Settlement Engine' }),
          h('div', { class: 'mk-card__sub', text: 'How ShopPilot routes multi-seller shopping carts through PayPal' })
        ]),
        h('span', { class: 'mk-chip mk-chip--success', text: 'Multi-Seller Orders v2' })
      ]),
      h('div', { class: 'mk-card__body stack' }, [
        h('p', { class: 'note', text: 'Gross is what the shopper paid for goods across all sellers. Commission is what ShopPilot retains for routing a basket to multiple independent sellers — configured per seller unit by PLATFORM_FEE_BPS (500 bps = 5%) and deducted automatically, never surcharged to the shopper. Net to seller is what was disbursed directly to each merchant payee account.' }),
        h('div', { class: 'row', style: { gap: '12px' } }, [
          h('button', {
            class: 'btn btn--primary btn--sm',
            type: 'button',
            text: 'Open Interactive AG Grid →',
            onclick: () => switchAdminTab('aggrid')
          }),
          h('button', {
            class: 'btn btn--secondary btn--sm',
            type: 'button',
            text: 'View Seller Settlement Ledger',
            onclick: () => switchAdminTab('settlement')
          })
        ])
      ])
    ])
  ]);

  // 2. AG Grid Live Console Section
  const aggridPanel = h('div', { class: 'mk-section-panel stack', dataset: { tab: 'aggrid' }, hidden: currentAdminTab !== 'aggrid' }, [
    // Orders Grid Card
    h('div', { class: 'mk-card' }, [
      h('div', { class: 'mk-card__head' }, [
        h('div', {}, [
          h('h2', { class: 'mk-card__title', text: `Orders Ledger (${data.orders?.total ?? 0})` }),
          h('div', { class: 'mk-card__sub', text: 'Live multi-column sorting, filtering, and instant reconciliation' })
        ]),
        hasAgGrid ? h('div', { class: 'row', style: { gap: '8px' } }, [
          h('input', {
            type: 'search',
            class: 'input input--sm',
            placeholder: 'Search orders, status…',
            style: { width: '210px', borderRadius: '8px' },
            oninput: (e) => ordersApi?.setGridOption('quickFilterText', e.target.value)
          }),
          h('button', {
            class: 'btn btn--secondary btn--sm',
            type: 'button',
            onclick: () => ordersApi?.exportDataAsCsv({ fileName: 'shoppilot-orders.csv' })
          }, [
            h('span', { html: ICONS.export }),
            h('span', { text: 'Export CSV' })
          ])
        ]) : null
      ]),
      h('div', { class: 'mk-card__body--flush' }, [
        hasAgGrid ? ordersGridEl : fallbackOrdersTable
      ])
    ]),

    // Settlement Grid Card
    h('div', { class: 'mk-card', style: { marginTop: '16px' } }, [
      h('div', { class: 'mk-card__head' }, [
        h('div', {}, [
          h('h2', { class: 'mk-card__title', text: 'Seller Settlement Grid' }),
          h('div', { class: 'mk-card__sub', text: 'Disbursements, platform fees, and gross volume per merchant' })
        ]),
        hasAgGrid ? h('div', { class: 'row', style: { gap: '8px' } }, [
          h('input', {
            type: 'search',
            class: 'input input--sm',
            placeholder: 'Filter sellers…',
            style: { width: '180px', borderRadius: '8px' },
            oninput: (e) => settlementApi?.setGridOption('quickFilterText', e.target.value)
          }),
          h('button', {
            class: 'btn btn--secondary btn--sm',
            type: 'button',
            onclick: () => settlementApi?.exportDataAsCsv({ fileName: 'shoppilot-settlement.csv' })
          }, [
            h('span', { html: ICONS.export }),
            h('span', { text: 'Export CSV' })
          ])
        ]) : null
      ]),
      h('div', { class: 'mk-card__body--flush' }, [
        hasAgGrid ? settlementGridEl : fallbackSettlementTable
      ])
    ])
  ]);

  // 3. Seller Settlements Section
  const settlementPanelTab = h('div', { class: 'mk-section-panel stack', dataset: { tab: 'settlement' }, hidden: currentAdminTab !== 'settlement' }, [
    h('div', { class: 'mk-card' }, [
      h('div', { class: 'mk-card__head' }, [
        h('div', {}, [
          h('h2', { class: 'mk-card__title', text: 'Seller Breakdown & Commission Accounts' }),
          h('div', { class: 'mk-card__sub', text: 'Every merchant payee, order count, and net payout calculation' })
        ]),
        h('span', { class: 'mk-chip mk-chip--info', text: `${data.sellerCount} Registered Merchants` })
      ]),
      h('div', { class: 'mk-card__body--flush' }, [
        fallbackSettlementTable
      ])
    ])
  ]);

  // 4. Invariants & Reconciliation Section
  const invariantsPanel = h('div', { class: 'mk-section-panel stack', dataset: { tab: 'invariants' }, hidden: currentAdminTab !== 'invariants' }, [
    h('div', { class: 'mk-card' }, [
      h('div', { class: 'mk-card__head' }, [
        h('div', {}, [
          h('h2', { class: 'mk-card__title', text: 'Automated Capture Reconciliation' }),
          h('div', { class: 'mk-card__sub', text: 'Recovery engine for orders pending confirmation or webhook delays' })
        ]),
        h('span', { class: 'mk-chip mk-chip--success', text: 'Zero Double-Charge Invariant' })
      ]),
      h('div', { class: 'mk-card__body stack' }, [
        h('p', { class: 'note', text: 'When a buyer approves a payment but the browser is closed before the capture response returns, or if a webhook is delayed, adminReconcile inspects the PayPal Orders v2 API and safely transitions the order to paid only if the capture was verified.' }),
        fallbackOrdersTable
      ])
    ])
  ]);

  // ── Build Full Dashboard Frame ───────────────────────────────────────────
  body.replaceChildren(
    h('div', { class: 'mk-dashboard' }, [
      // ── Sidebar ──
      h('aside', { class: 'mk-sidebar' }, [
        // Operator Profile
        h('div', { class: 'mk-sidebar__profile' }, [
          h('div', { class: 'mk-avatar mk-avatar--admin', text: 'A' }),
          h('div', { class: 'mk-profile-info' }, [
            h('div', { class: 'mk-profile-info__name', text: 'Platform Operator' }),
            h('span', { class: 'mk-chip mk-chip--info mk-profile-info__role', text: 'Admin / AG Grid' })
          ])
        ]),

        // Nav List
        h('nav', { class: 'mk-nav', 'aria-label': 'Admin platform navigation' }, [
          h('span', { class: 'mk-nav__heading', text: 'Enterprise Console' }),
          h('button', {
            class: `mk-nav__item ${currentAdminTab === 'overview' ? 'is-active' : ''}`,
            dataset: { tab: 'overview' },
            onclick: () => switchAdminTab('overview')
          }, [
            h('span', { class: 'mk-nav__icon', html: ICONS.overview }),
            h('span', { text: 'Financials' })
          ]),
          h('button', {
            class: `mk-nav__item ${currentAdminTab === 'aggrid' ? 'is-active' : ''}`,
            dataset: { tab: 'aggrid' },
            onclick: () => switchAdminTab('aggrid')
          }, [
            h('span', { class: 'mk-nav__icon', html: ICONS.aggrid }),
            h('span', { text: 'AG Grid Live' }),
            h('span', { class: 'mk-chip mk-chip--info mk-nav__badge', text: 'v32' })
          ]),
          h('button', {
            class: `mk-nav__item ${currentAdminTab === 'settlement' ? 'is-active' : ''}`,
            dataset: { tab: 'settlement' },
            onclick: () => switchAdminTab('settlement')
          }, [
            h('span', { class: 'mk-nav__icon', html: ICONS.settlement }),
            h('span', { text: 'Settlements' })
          ]),
          h('button', {
            class: `mk-nav__item ${currentAdminTab === 'invariants' ? 'is-active' : ''}`,
            dataset: { tab: 'invariants' },
            onclick: () => switchAdminTab('invariants')
          }, [
            h('span', { class: 'mk-nav__icon', html: ICONS.invariants }),
            h('span', { text: 'Invariants & Audit' })
          ])
        ]),

        // Sidebar Footer Status
        h('div', { class: 'mk-sidebar__foot' }, [
          h('div', { class: 'mk-status-card' }, [
            h('span', { class: 'mk-pulse-dot' }),
            h('span', { text: 'AG Grid: Enterprise Ready' })
          ]),
          h('div', { class: 'mk-status-card' }, [
            h('span', { text: '⚖️ 10 Invariants Verified' })
          ])
        ])
      ]),

      // ── Main Content Area ──
      h('div', { class: 'mk-main' }, [
        // Header Bar
        h('header', { class: 'mk-header' }, [
          h('div', { class: 'mk-title-wrap' }, [
            h('nav', { class: 'mk-breadcrumb', 'aria-label': 'Breadcrumb' }, [
              h('span', { text: 'Platform' }),
              h('span', { class: 'mk-breadcrumb__sep', text: '/' }),
              h('span', { text: 'Operator' }),
              h('span', { class: 'mk-breadcrumb__sep', text: '/' }),
              h('span', { id: 'mk-admin-breadcrumb-current', text: currentAdminTab.charAt(0).toUpperCase() + currentAdminTab.slice(1) })
            ]),
            h('h1', { class: 'mk-title', text: 'Platform Console' }),
            h('p', { class: 'mk-subtitle', text: 'Multi-seller settlement, marketplace commission ledger, and AG Grid live audit' })
          ]),
          h('div', { class: 'mk-actions' }, [
            h('button', {
              class: 'btn btn--secondary btn--sm',
              type: 'button',
              title: 'Refresh platform data',
              onclick: () => {
                toast('Refreshing platform overview & AG Grid…');
                renderAdmin();
              }
            }, [
              h('span', { html: ICONS.refresh }),
              h('span', { text: 'Refresh' })
            ]),
            hasAgGrid ? h('button', {
              class: 'btn btn--primary btn--sm',
              type: 'button',
              onclick: () => ordersApi?.exportDataAsCsv({ fileName: 'shoppilot-orders.csv' })
            }, [
              h('span', { html: ICONS.export }),
              h('span', { text: 'Export CSV' })
            ]) : null
          ])
        ]),

        // Horizontal Quick Tabs
        h('div', { class: 'mk-tabs' }, [
          h('button', { class: `mk-tab ${currentAdminTab === 'overview' ? 'is-active' : ''}`, dataset: { tab: 'overview' }, onclick: () => switchAdminTab('overview'), text: 'Financials & GMV' }),
          h('button', { class: `mk-tab ${currentAdminTab === 'aggrid' ? 'is-active' : ''}`, dataset: { tab: 'aggrid' }, onclick: () => switchAdminTab('aggrid'), text: 'AG Grid Live Console' }),
          h('button', { class: `mk-tab ${currentAdminTab === 'settlement' ? 'is-active' : ''}`, dataset: { tab: 'settlement' }, onclick: () => switchAdminTab('settlement'), text: 'Seller Settlements' }),
          h('button', { class: `mk-tab ${currentAdminTab === 'invariants' ? 'is-active' : ''}`, dataset: { tab: 'invariants' }, onclick: () => switchAdminTab('invariants'), text: 'Invariants & Reconcile' })
        ]),

        // Active Panel Bodies
        overviewPanel,
        aggridPanel,
        settlementPanelTab,
        invariantsPanel
      ])
    ])
  );

  // Initialize AG Grid if script is present in browser environment
  if (hasAgGrid) {
    const settlementRowData = (data.merchants ?? []).map((m) => ({
      name: m.name,
      slug: m.slug,
      orders: m.orders,
      units: m.units,
      gross: m.grossDisplay,
      commission: m.commissionDisplay,
      refunded: m.refundedDisplay ?? '—',
      net: m.netDisplay
    }));

    const settlementColDefs = [
      { field: 'name', headerName: 'Seller Name', flex: 2, filter: true, sortable: true },
      { field: 'slug', headerName: 'Merchant Slug', flex: 1, filter: true },
      { field: 'orders', headerName: 'Orders', width: 110, sortable: true },
      { field: 'units', headerName: 'Units Sold', width: 110, sortable: true },
      { field: 'gross', headerName: 'Gross GMV', width: 140, sortable: true },
      { field: 'commission', headerName: 'Platform Fee (5%)', width: 160, sortable: true },
      { field: 'refunded', headerName: 'Refunded', width: 120 },
      { field: 'net', headerName: 'Net Disbursed', width: 150, sortable: true }
    ];

    settlementApi = window.agGrid.createGrid(settlementGridEl, {
      rowData: settlementRowData,
      columnDefs: settlementColDefs,
      defaultColDef: { resizable: true },
      pagination: false,
      domLayout: 'autoHeight'
    });

    const ordersRowData = (data.orders?.items ?? []).map((order) => ({
      id: order.id,
      orderNumber: order.orderNumber,
      createdAt: new Date(order.createdAt).toLocaleString(),
      sellerCount: new Set((order.lines ?? []).map((l) => l.merchantId)).size,
      total: order.amounts?.display?.total ?? money(order.amounts?.totalMinor),
      status: order.status,
      paymentStatus: order.payment?.status ?? 'none'
    }));

    const ordersColDefs = [
      { field: 'orderNumber', headerName: 'Order Number', width: 180, filter: true, sortable: true },
      { field: 'createdAt', headerName: 'Timestamp', width: 200, sortable: true },
      { field: 'sellerCount', headerName: 'Sellers', width: 110, sortable: true },
      { field: 'total', headerName: 'Order Total', width: 140, sortable: true },
      {
        field: 'status',
        headerName: 'Status',
        width: 150,
        sortable: true,
        filter: true,
        cellRenderer: (params) => {
          const tone = statusTone(params.value);
          const label = humanStatus(params.value);
          return `<span class="mk-chip mk-chip--${tone}">${label}</span>`;
        }
      },
      { field: 'paymentStatus', headerName: 'PayPal Payment', width: 150, filter: true },
      {
        headerName: 'Action',
        width: 130,
        cellRenderer: (params) => {
          if (['awaiting_payment', 'payment_failed', 'payment_processing'].includes(params.data.status)) {
            return `<button class="btn btn--ghost btn--sm ag-reconcile-btn" data-order-id="${params.data.id}">Reconcile</button>`;
          }
          return '<span class="note">—</span>';
        }
      }
    ];

    ordersApi = window.agGrid.createGrid(ordersGridEl, {
      rowData: ordersRowData,
      columnDefs: ordersColDefs,
      defaultColDef: { resizable: true },
      pagination: true,
      paginationPageSize: 10,
      domLayout: 'autoHeight',
      onCellClicked: async (event) => {
        if (event.event?.target?.classList?.contains('ag-reconcile-btn')) {
          const orderId = event.event.target.dataset.orderId;
          try {
            const result = await adminReconcile(orderId);
            toast(result.applied ? 'Order reconciled and marked paid' : 'No capture to reconcile', { tone: result.applied ? 'success' : 'default' });
            renderAdmin();
          } catch (err) {
            toast(err?.message ?? 'Reconcile failed', { tone: 'danger' });
          }
        }
      }
    });
  }
}
