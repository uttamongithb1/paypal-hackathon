/**
 * The platform console.
 *
 * A shopper sees one order. A merchant sees their own share of it. The platform operator sees
 * something neither of them can: what the *routing* was worth. ShopPilot takes a commission on
 * every seller unit, and until now that number was computed by the settlement plan and shown to
 * nobody — so the multi-seller model was implemented but invisible.
 *
 * This page is that view: gross merchandise value, commission retained, net paid to sellers, and
 * the order queue with the reconciliation action that was already in the API but had no screen.
 *
 * Enhanced with AG Grid for enterprise financial sorting, filtering, and CSV export (Sponsor Track).
 * Docs: docs/payments_paypal.md §3a, WIN_PLAN.md F1.
 */
import {
  adminOverview, adminReconcile, money
} from './api.js';
import { $, h, humanStatus, skeleton, statusTone, toast } from './ui.js';

const stat = (label, value, sub) =>
  h('div', { class: 'kpi' }, [
    h('div', { class: 'kpi__label', text: label }),
    h('div', { class: 'kpi__value', text: value }),
    sub ? h('div', { class: 'note', text: sub }) : null
  ]);

export async function renderAdmin() {
  const body = $('#admin-body');
  if (!body) return;
  body.replaceChildren(skeleton('Loading the platform view…'));

  let data;
  try {
    data = await adminOverview();
  } catch (err) {
    body.replaceChildren(
      h('div', { class: 'callout callout--danger' }, [
        h('strong', { text: 'The platform view is not available to this account.' }),
        h('p', { class: 'note', text: err?.message ?? 'Sign in as an administrator to see it.' })
      ])
    );
    return;
  }

  const commissionRate = data.commissionRateBps ? `${(data.commissionRateBps / 100).toFixed(1)}%` : '—';
  const hasAgGrid = typeof window !== 'undefined' && Boolean(window.agGrid?.createGrid);

  // Settlement grid container
  const settlementGridEl = h('div', {
    id: 'ag-settlement-grid',
    class: 'ag-theme-quartz',
    style: { height: '240px', width: '100%', marginBottom: '16px' }
  });

  // Orders grid container
  const ordersGridEl = h('div', {
    id: 'ag-orders-grid',
    class: 'ag-theme-quartz',
    style: { height: '360px', width: '100%', marginBottom: '16px' }
  });

  let settlementApi = null;
  let ordersApi = null;

  const fallbackSettlementTable = h('div', { class: 'table-wrap', style: hasAgGrid ? { display: 'none' } : {} }, [
    h('table', {}, [
      h('thead', {}, [h('tr', {}, [
        h('th', { text: 'Seller' }),
        h('th', { class: 'num', text: 'Orders' }),
        h('th', { class: 'num', text: 'Units' }),
        h('th', { class: 'num', text: 'Gross' }),
        h('th', { class: 'num', text: 'Commission' }),
        h('th', { class: 'num', text: 'Refunded' }),
        h('th', { class: 'num', text: 'Net to seller' })
      ])]),
      h('tbody', {}, (data.merchants ?? []).map((m) =>
        h('tr', {}, [
          h('td', {}, [
            h('div', { text: m.name }),
            h('div', { class: 'note mono', text: m.slug })
          ]),
          h('td', { class: 'num mono', text: String(m.orders) }),
          h('td', { class: 'num mono', text: String(m.units) }),
          h('td', { class: 'num mono', text: m.grossDisplay }),
          h('td', { class: 'num mono' }, [
            h('span', { class: 'badge badge--brand', text: m.commissionDisplay })
          ]),
          h('td', { class: 'num mono', text: m.refundedDisplay ?? '—' }),
          h('td', { class: 'num mono', text: m.netDisplay })
        ])
      ))
    ])
  ]);

  const fallbackOrdersTable = h('div', { class: 'table-wrap', style: hasAgGrid ? { display: 'none' } : {} }, [
    h('table', {}, [
      h('thead', {}, [h('tr', {}, [
        h('th', { text: 'Order' }),
        h('th', { text: 'Sellers' }),
        h('th', { class: 'num', text: 'Total' }),
        h('th', { text: 'Status' }),
        h('th', { text: 'Payment' }),
        h('th', { text: '' })
      ])]),
      h('tbody', {}, (data.orders?.items ?? []).map((order) =>
        h('tr', {}, [
          h('td', {}, [
            h('div', { class: 'mono', text: order.orderNumber }),
            h('div', { class: 'note', text: new Date(order.createdAt).toLocaleString() })
          ]),
          h('td', { class: 'mono', text: String(new Set((order.lines ?? []).map((l) => l.merchantId)).size) }),
          h('td', { class: 'num mono', text: order.amounts?.display?.total ?? money(order.amounts?.totalMinor) }),
          h('td', {}, [h('span', { class: `badge badge--${statusTone(order.status)}`, text: humanStatus(order.status) })]),
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
                        ? `${order.orderNumber} reconciled — marked paid from the stored capture`
                        : `${order.orderNumber}: no capture to reconcile`, { tone: result.applied ? 'success' : 'default' });
                      renderAdmin();
                    } catch (err) {
                      toast(err?.message ?? 'Reconcile failed', { tone: 'danger' });
                    }
                  }
                })
              : null
          ])
        ])
      ))
    ])
  ]);

  body.replaceChildren(
    h('div', { class: 'page-head' }, [
      h('div', {}, [
        h('h1', { text: 'Platform console' }),
        h('p', {
          class: 'note',
          text: 'Every seller on ShopPilot, what they earned, and what the platform kept for routing the basket.'
        })
      ])
    ]),

    h('div', { class: 'section' }, [
      h('div', { class: 'kpi-grid' }, [
        stat('Gross merchandise value', data.grossDisplay, `${data.paidOrders} paid orders`),
        stat('Commission retained', data.commissionDisplay, `${commissionRate} of GMV`),
        stat('Paid out to sellers', data.netPaidDisplay, `${data.sellerCount} sellers`),
        stat('Multi-seller baskets', String(data.multiSellerOrders), `${data.splitOrders} settled as a split`)
      ])
    ]),

    h('div', { class: 'section' }, [
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px', flexWrap: 'wrap', gap: '8px' } }, [
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
          h('h2', { text: 'Settlement by seller', style: { margin: 0 } }),
          h('span', { class: 'badge badge--brand', text: 'AG Grid Enabled' })
        ]),
        hasAgGrid ? h('div', { class: 'row', style: { gap: '8px' } }, [
          h('input', {
            type: 'search',
            class: 'input input--sm',
            placeholder: 'Filter sellers…',
            style: { width: '180px' },
            oninput: (e) => settlementApi?.setGridOption('quickFilterText', e.target.value)
          }),
          h('button', {
            class: 'btn btn--secondary btn--sm',
            type: 'button',
            text: 'Export CSV',
            onclick: () => settlementApi?.exportDataAsCsv({ fileName: 'shoppilot-settlement.csv' })
          })
        ]) : null
      ]),
      hasAgGrid ? settlementGridEl : null,
      fallbackSettlementTable,
      h('p', {
        class: 'note',
        text: 'Gross is what the shopper paid for that seller’s goods. Commission is what ShopPilot keeps for routing a basket to several independent sellers — set per seller unit by PLATFORM_FEE_BPS and deducted from the unit, never taken from the shopper. Net to seller is what was actually paid out.'
      })
    ]),

    h('div', { class: 'section' }, [
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px', flexWrap: 'wrap', gap: '8px' } }, [
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
          h('h2', { text: `Order queue (${data.orders?.total ?? 0})`, style: { margin: 0 } }),
          h('span', { class: 'badge badge--brand', text: 'AG Grid Live' })
        ]),
        hasAgGrid ? h('div', { class: 'row', style: { gap: '8px' } }, [
          h('input', {
            type: 'search',
            class: 'input input--sm',
            placeholder: 'Search orders, status…',
            style: { width: '200px' },
            oninput: (e) => ordersApi?.setGridOption('quickFilterText', e.target.value)
          }),
          h('button', {
            class: 'btn btn--secondary btn--sm',
            type: 'button',
            text: 'Export CSV',
            onclick: () => ordersApi?.exportDataAsCsv({ fileName: 'shoppilot-orders.csv' })
          })
        ]) : null
      ]),
      hasAgGrid ? ordersGridEl : null,
      fallbackOrdersTable
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
          return `<span class="badge badge--${tone}">${label}</span>`;
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
