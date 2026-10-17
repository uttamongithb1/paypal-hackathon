/**
 * Order history (/orders, /orders/:orderId): orders, payment status, the PayPal capture that proved
 * each payment, retry for failed attempts and cancellation for unpaid orders.
 */
import { cancelOrder, fetchOrder, fetchOrders, money, retryPayment, state, track, event } from './api.js';
import { $, h, humanStatus, skeleton, statusTone, toast } from './ui.js';
import { settlementPanel, settlementBadge, verificationMatrix } from './settlement.js';
import { amountBreakdown } from './cards.js';

const statusLine = (order) =>
  h('div', { class: 'row' }, [
    h('span', { class: `badge badge--${statusTone(order.status)}`, text: humanStatus(order.status) }),
    h('span', { class: 'badge', text: `payment: ${humanStatus(order.payment?.status ?? 'none')}` }),
    order.payment?.lastAttemptNo ? h('span', { class: 'badge', text: `attempts: ${order.payment.lastAttemptNo}` }) : null,
    settlementBadge(order),
    order.payment?.paypalCaptureId ? h('span', { class: 'badge badge--success mono', text: order.payment.paypalCaptureId }) : null
  ]);

export async function renderOrders() {
  const host = $('#orders-body');
  host.replaceChildren(skeleton(3));
  if (!state.user || state.user.role === 'guest') {
    host.replaceChildren(
      h('div', { class: 'empty-state' }, [
        h('h3', { text: 'Sign in to see your orders' }),
        h('p', { class: 'note', text: 'Guest orders are claimed automatically when you sign in with the same email.' }),
        h('button', { class: 'btn btn--primary', type: 'button', text: 'Sign in', onclick: () => document.getElementById('auth-button')?.click() })
      ])
    );
    return;
  }
  try {
    const { items } = await fetchOrders({ limit: 20 });
    if (!items.length) {
      host.replaceChildren(h('div', { class: 'empty-state' }, [h('h3', { text: 'No orders yet' }), h('p', { class: 'note', text: 'Complete a checkout and it will appear here with its payment trail.' })]));
      return;
    }
    host.replaceChildren(
      h('div', { class: 'table-wrap' }, [
        h('table', {}, [
          h('thead', {}, [h('tr', {}, [h('th', { text: 'Order' }), h('th', { text: 'Placed' }), h('th', { class: 'num', text: 'Total' }), h('th', { text: 'Status' }), h('th', { text: '' })])]),
          h('tbody', {}, items.map((order) =>
            h('tr', {}, [
              h('td', {}, [
                h('div', { class: 'mono', text: order.orderNumber }),
                h('div', { class: 'card__merchant', text: order.lines.map((line) => `${line.quantity}× ${line.title}`).join(', ') })
              ]),
              h('td', { text: new Date(order.createdAt).toLocaleString() }),
              h('td', { class: 'num', text: order.amounts.display?.total ?? money(order.amounts.totalMinor) }),
              h('td', {}, [statusLine(order)]),
              h('td', {}, [
                h('div', { class: 'row' }, [
                  h('a', { class: 'btn btn--secondary btn--sm', href: `/orders/${order.id}`, 'data-link': 'true', text: 'Open' }),
                  ['awaiting_payment', 'payment_failed'].includes(order.status)
                    ? h('a', { class: 'btn btn--primary btn--sm', href: `/checkout/${order.id}`, 'data-link': 'true', text: 'Pay' })
                    : null
                ])
              ])
            ])
          ))
        ])
      ])
    );
  } catch (error) {
    host.replaceChildren(h('div', { class: 'callout callout--danger', text: error.message }));
  }
}

export async function renderOrderDetail(orderId) {
  const host = $('#orders-body');
  host.replaceChildren(skeleton(3));
  try {
    const { order } = await fetchOrder(orderId);
    track([event('order_viewed', { orderId })]);
    const attempts = await import('./api.js').then(({ merchantAttempts }) => null).catch(() => null);
    // Timeline entries carry `meta`, so reading only `detail` left this column empty and made the
    // audit trail — the thing that proves what happened to the money — look like it had nothing to
    // say. Minor-unit values are shown as money; everything else prints as-is.
    const detailText = (entry) => {
      const meta = entry.detail ?? entry.meta;
      if (meta == null) return '—';
      if (typeof meta !== 'object') return String(meta);
      const parts = Object.entries(meta).map(([key, value]) => {
        const label = key.replace(/Minor$/, '');
        const shown = key.endsWith('Minor') && Number.isFinite(value) ? money(value) : String(value);
        return `${label} ${shown}`;
      });
      return parts.join(' · ').slice(0, 120);
    };

    const timelineRows = (order.timeline ?? []).map((entry) =>
      h('tr', {}, [
        h('td', { text: new Date(entry.at).toLocaleString() }),
        h('td', { text: humanStatus(entry.event) }),
        h('td', { text: entry.actor ?? 'system' }),
        h('td', { class: 'mono', text: detailText(entry) })
      ])
    );

    host.replaceChildren(
      h('div', { class: 'page-head' }, [
        h('h1', { text: `Order ${order.orderNumber}` }),
        h('div', { class: 'row' }, [statusLine(order)])
      ]),
      h('div', { class: 'checkout-grid' }, [
        h('div', { class: 'stack' }, [
          h('div', { class: 'table-wrap' }, [
            h('table', {}, [
              h('thead', {}, [h('tr', {}, [h('th', { text: 'Item' }), h('th', { class: 'num', text: 'Qty' }), h('th', { class: 'num', text: 'Line total' })])]),
              h('tbody', {}, order.lines.map((line) =>
                h('tr', {}, [h('td', { text: line.title }), h('td', { class: 'num', text: String(line.quantity) }), h('td', { class: 'num', text: money(line.lineTotalMinor) })])
              ))
            ])
          ]),
          h('h3', { text: 'Timeline' }),
          h('div', { class: 'table-wrap' }, [
            h('table', {}, [h('thead', {}, [h('tr', {}, [h('th', { text: 'When' }), h('th', { text: 'Event' }), h('th', { text: 'Actor' }), h('th', { text: 'Detail' })])]), h('tbody', {}, timelineRows)])
          ]),
          h('a', { class: 'btn btn--ghost btn--sm', href: '/orders', 'data-link': 'true', text: '← All orders' })
        ]),
        h('div', { class: 'pay-panel' }, [
          h('h3', { text: 'Payment' }),
          amountBreakdown(order.amounts),
          h('div', { class: 'note', text: `Provider: PayPal (${state.env?.paypalMode ?? 'simulator'}) · ${order.payment?.paypalOrderId ?? 'no PayPal order'}` }),
          // Split settlement is the most interesting thing about this order — show it, don't bury it.
          settlementPanel(order),
          verificationMatrix(order),
          order.payment?.paypalCaptureId
            ? h('div', { class: 'callout callout--success' }, [
                h('strong', { text: 'Capture verified' }),
                h('p', { class: 'note mono', text: order.payment.paypalCaptureId })
              ])
            : null,
          order.payment?.lastErrorCode
            ? h('div', { class: 'callout callout--danger' }, [h('strong', { text: order.payment.lastErrorCode }), h('p', { class: 'note', text: order.payment.lastErrorMessage ?? '' })])
            : null,
          ['awaiting_payment', 'payment_failed'].includes(order.status)
            ? h('div', { class: 'stack' }, [
                h('a', { class: 'btn btn--primary btn--block', href: `/checkout/${order.id}`, 'data-link': 'true', text: 'Continue payment' }),
                order.payment?.lastAttemptNo ? h('button', {
                  class: 'btn btn--secondary btn--block',
                  type: 'button',
                  text: 'Retry payment (new attempt)',
                  onclick: async (event) => {
                    event.currentTarget.disabled = true;
                    try {
                      const result = await retryPayment(order.id);
                      toast(`Attempt #${result.payment?.attemptNo} created`, { tone: 'success' });
                      location.assign(`/checkout/${order.id}`);
                    } catch (error) {
                      toast(error.message, { tone: 'danger' });
                      event.currentTarget.disabled = false;
                    }
                  }
                }) : null,
                h('button', {
                  class: 'btn btn--ghost btn--block',
                  type: 'button',
                  text: 'Cancel order',
                  onclick: async () => {
                    await cancelOrder(order.id);
                    toast('Order cancelled, stock released');
                    location.assign('/orders');
                  }
                })
              ])
            : null,
          h('div', { class: 'note', text: 'Need help with this order? Ask the agent — it can read the order status but can never change a payment.' })
        ])
      ])
    );
  } catch (error) {
    host.replaceChildren(h('div', { class: 'empty-state' }, [h('h3', { text: 'Order not found' }), h('p', { class: 'note', text: error.message })]));
  }
}
