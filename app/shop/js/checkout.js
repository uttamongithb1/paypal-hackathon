/**
 * Checkout page (/checkout/:orderId): the money side of the flow.
 *
 * The customer approves in PayPal; the backend verifies the capture with PayPal before the order
 * becomes `paid`. In `PAYPAL_MODE=simulator` the same client contract is driven by explicit buttons
 * (approve / decline / pending) so the whole failure matrix is demonstrable without sandbox keys.
 */
import {
  capturePayment, cancelOrder, fetchOrder, money, paymentStatus, retryPayment, state, track, event
} from './api.js';
import { $, h, humanStatus, skeleton, statusTone, toast, openModal } from './ui.js';
import { settlementPanel, settlementBadge } from './settlement.js';
import { amountBreakdown } from './cards.js';

let pollTimer = null;
const stopPolling = () => {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
};

const STEPS = [
  { key: 'order', label: 'Order created, stock reserved', test: (order) => Boolean(order) },
  { key: 'approved', label: 'You approved the payment in PayPal', test: (order) => ['payment_processing', 'paid', 'processing', 'shipped', 'delivered'].includes(order?.status) || ['processing', 'succeeded'].includes(order?.payment?.status) },
  { key: 'captured', label: 'Capture verified with PayPal (amount + currency + order id)', test: (order) => order?.payment?.amountVerified === true || Boolean(order?.payment?.paypalCaptureId) },
  { key: 'paid', label: 'Order marked paid', test: (order) => ['paid', 'processing', 'shipped', 'delivered'].includes(order?.status) }
];

function timeline(order) {
  return h('ul', { class: 'timeline' }, STEPS.map((step) => {
    const done = step.test(order);
    const active = !done && ['payment_processing', 'awaiting_payment'].includes(order?.status) && STEPS.findIndex((s) => s.key === step.key) === STEPS.filter((s) => s.test(order)).length;
    return h('li', {}, [
      h('span', { class: `timeline__dot${done ? ' timeline__dot--done' : active ? ' timeline__dot--active' : ''}` }),
      h('div', {}, [h('div', { text: step.label }), done ? h('div', { class: 'note', text: 'done' }) : null])
    ]);
  }));
}

function payPanel(order) {
  const isSimulator = (state.env?.paypalMode ?? 'simulator') !== 'sandbox';
  const panel = h('div', { class: 'pay-panel pay-panel--approval' }, [
    h('div', { class: 'row row--between' }, [
      h('h3', { text: 'Payment' }),
      h('span', { class: `badge badge--${statusTone(order.status)}`, text: humanStatus(order.status) })
    ]),
    amountBreakdown(order.amounts),
    h('div', { class: 'note', text: `Order ${order.orderNumber} · PayPal order ${order.payment?.paypalOrderId ?? '—'} · attempt ${order.payment?.lastAttemptNo ?? 0}` })
  ]);

  const payable = ['awaiting_payment', 'payment_failed'].includes(order.status);
  const processing = order.status === 'payment_processing';
  const paid = ['paid', 'processing', 'shipped', 'delivered'].includes(order.status);

  if (paid) {
    panel.append(
      h('div', { class: 'callout callout--success' }, [
        h('strong', { text: 'Payment verified' }),
        h('p', { class: 'note', text: `Capture ${order.payment?.paypalCaptureId} confirmed with PayPal for ${order.amounts.display?.total}. The merchant has been notified.` })
      ]),
      // Who actually got the money, and whether it was split per seller by PayPal.
      settlementPanel(order),
      h('a', { class: 'btn btn--secondary btn--block', href: '/orders', 'data-link': 'true', text: 'View my orders' })
    );
    return panel;
  }

  if (processing) {
    panel.append(
      h('div', { class: 'callout callout--warning' }, [
        h('strong', { text: 'Confirming with PayPal…' }),
        h('p', { class: 'note', text: 'The capture is in flight. This page polls the backend and updates itself; you do not need to pay again.' })
      ])
    );
    return panel;
  }

  if (!payable) {
    panel.append(
      h('div', { class: 'callout callout--danger' }, [
        h('strong', { text: `This order is ${humanStatus(order.status)}` }),
        h('p', { class: 'note', text: 'Nothing was captured. Start a new checkout from your cart to try again.' })
      ]),
      h('a', { class: 'btn btn--secondary btn--block', href: '/shop', 'data-link': 'true', text: 'Back to the shop' })
    );
    return panel;
  }

  if (order.status === 'payment_failed') {
    panel.append(
      h('div', { class: 'callout callout--danger' }, [
        h('strong', { text: `Last attempt failed${order.payment?.lastErrorCode ? ` (${order.payment.lastErrorCode})` : ''}` }),
        h('p', { class: 'note', text: 'No money moved. You can retry with another payment method — the order and its stock hold are still yours.' })
      ]),
      h('button', { class: 'btn btn--primary btn--block', type: 'button', text: 'Retry payment', onclick: (event) => retry(event.currentTarget) })
    );
    return panel;
  }

  panel.append(
    h('div', { class: 'callout callout--agent' }, [
      h('strong', { text: 'Only you can pay' }),
      h('p', { class: 'note', text: 'ShopPilot prepared this order and reserved the stock. The agent has no tool that can charge you — approval happens in PayPal.' })
    ]),
    isSimulator ? simulatorControls(order) : paypalControls(order)
  );
  return panel;
}

function simulatorControls(order) {
  const host = h('div', { class: 'paypal-sim' }, [
    h('div', { class: 'note', text: 'PAYPAL_MODE=simulator — no calls leave this machine. Choose the sandbox-buyer outcome you want to see:' }),
    h('button', {
      class: 'btn btn--primary btn--block',
      type: 'button',
      text: 'Approve & Pay (simulated PayPal)',
      onclick: (event) => capture(event.currentTarget, order, 'approve')
    }),
    h('div', { class: 'row' }, [
      h('button', { class: 'btn btn--secondary btn--sm', type: 'button', text: 'Decline (INSTRUMENT_DECLINED)', onclick: (event) => capture(event.currentTarget, order, 'decline') }),
      h('button', { class: 'btn btn--secondary btn--sm', type: 'button', text: 'Pending / timeout', onclick: (event) => capture(event.currentTarget, order, 'pending') }),
      h('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: 'Cancel checkout', onclick: (event) => cancel(event.currentTarget, order) })
    ])
  ]);
  return host;
}

function paypalControls(order) {
  const host = h('div', { class: 'stack', id: 'paypal-buttons' }, [h('div', { class: 'skeleton' })]);
  // Prefer the boot config; fall back to the id returned by POST /orders or /payments/retry.
  const clientId = state.env?.paypalClientId ?? order.payment?.clientId;
  if (!clientId) {
    host.replaceChildren(h('div', { class: 'callout callout--warning', text: 'PAYPAL_MODE=sandbox but no PAYPAL_CLIENT_ID is configured for the browser SDK. Add it to .env or switch to simulator mode.' }));
    return host;
  }
  const script = document.createElement('script');
  script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=capture&components=buttons`;
  script.onload = () => {
    if (!window.paypal) {
      host.replaceChildren(h('div', { class: 'callout callout--danger', text: 'PayPal SDK loaded but did not initialise.' }));
      return;
    }
    host.replaceChildren();
    window.paypal.Buttons({
      style: { layout: 'vertical', shape: 'pill', label: 'paypal', color: 'gold' },
      createOrder: () => order.payment?.paypalOrderId,
      onApprove: (data) => capture(null, order, 'approve', data?.orderID),
      onCancel: () => toast('Checkout cancelled in PayPal — nothing was charged.', { tone: 'warning' }),
      onError: (error) => toast(`PayPal error: ${error?.message ?? error}`, { tone: 'danger' })
    }).render(host);
  };
  script.onerror = () => host.replaceChildren(h('div', { class: 'callout callout--danger', text: 'Could not load the PayPal SDK (offline?). The order is safe — retry when back online.' }));
  document.head.append(script);
  return host;
}

async function capture(button, order, outcome, paypalOrderId) {
  if (button) {
    button.disabled = true;
    button.textContent = outcome === 'approve' ? 'Contacting PayPal…' : 'Working…';
  }
  try {
    const result = await capturePayment(order.id, { paypalOrderId: paypalOrderId ?? order.payment?.paypalOrderId, simulatedOutcome: outcome });
    if (outcome === 'approve' && result.payment?.captureId) {
      toast(`Paid ${money(result.payment.amountMinor)} — capture ${result.payment.captureId} verified`, { tone: 'success' });
      closeCartAndReload();
      return;
    }
    toast(result.message ?? 'PayPal is still confirming this payment — this page will keep checking.', { tone: 'warning' });
    startPolling(order.id);
  } catch (error) {
    const tone = error.code === 'PAYMENT_DECLINED' ? 'danger' : 'warning';
    toast(`${error.message}${error.code ? ` (${error.code})` : ''}`, { tone });
    closeCartAndReload();
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = 'Approve & Pay (simulated PayPal)';
    }
  }
}

async function cancel(button, order) {
  button.disabled = true;
  try {
    await cancelOrder(order.id, 'customer_cancelled');
    toast('Order cancelled and stock released — nothing was charged.', { tone: 'success' });
    location.assign('/shop');
  } catch (error) {
    toast(error.message, { tone: 'danger' });
    button.disabled = false;
  }
}

async function retry(button) {
  button.disabled = true;
  button.textContent = 'Creating a new attempt…';
  try {
    const result = await retryPayment(button.dataset.orderId);
    toast(`Attempt #${result.payment?.attemptNo} ready — approve it below`, { tone: 'success' });
    location.reload();
  } catch (error) {
    toast(error.code === 'QUOTE_STALE' ? 'The quote expired — rebuild the order from your cart.' : error.message, { tone: 'danger' });
    button.disabled = false;
    button.textContent = 'Retry payment';
  }
}

function startPolling(orderId) {
  stopPolling();
  let attempts = 0;
  pollTimer = setInterval(async () => {
    attempts += 1;
    try {
      // docs/api_spec.md §6: the status endpoint is flat — { orderStatus, paymentStatus, attemptNo, … }
      const status = await paymentStatus(orderId);
      if (['paid', 'processing', 'shipped', 'delivered'].includes(status.orderStatus)) {
        stopPolling();
        toast('Payment confirmed by the backend.', { tone: 'success' });
        closeCartAndReload();
        return;
      }
      if (status.orderStatus === 'payment_failed') {
        stopPolling();
        toast('PayPal declined the capture. No money moved — you can retry.', { tone: 'danger' });
        closeCartAndReload();
        return;
      }
    } catch {
      /* transient — keep polling */
    }
    if (attempts >= 8) stopPolling();
  }, 3000);
}

const closeCartAndReload = () => setTimeout(() => location.reload(), 400);

export async function renderCheckout(orderId) {
  stopPolling();
  const host = $('#checkout-body');
  host.replaceChildren(skeleton(4));
  try {
    const { order } = await fetchOrder(orderId);
    track([event('checkout_viewed', { orderId: order.id, status: order.status })]);

    host.replaceChildren(
      h('div', { class: 'page-head' }, [
        h('h1', { text: `Checkout · ${order.orderNumber}` }),
        h('p', { class: 'muted', text: `Expires ${new Date(order.expiresAt).toLocaleTimeString()} · total ${order.amounts.display?.total} · ${order.lines.length} line(s)` })
      ]),
      h('div', { class: 'checkout-grid' }, [
        h('div', { class: 'stack' }, [
          h('div', { class: 'table-wrap' }, [
            h('table', {}, [
              h('thead', {}, [h('tr', {}, [h('th', { text: 'Item' }), h('th', { class: 'num', text: 'Qty' }), h('th', { class: 'num', text: 'Unit' }), h('th', { class: 'num', text: 'Line total' })])]),
              h('tbody', {}, order.lines.map((line) =>
                h('tr', {}, [
                  h('td', {}, [h('div', { text: line.title }), h('div', { class: 'card__merchant', text: line.brand ?? '' })]),
                  h('td', { class: 'num', text: String(line.quantity) }),
                  h('td', { class: 'num', text: money(line.unitPriceMinor) }),
                  h('td', { class: 'num', text: money(line.lineTotalMinor) })
                ])
              ))
            ])
          ]),
          h('div', { class: 'callout' }, [
            h('strong', { text: 'What happens when you approve' }),
            h('ol', { class: 'note' }, [
              h('li', { text: 'PayPal captures the amount for this order (no card data ever touches ShopPilot).' }),
              h('li', { text: 'The backend fetches the capture from PayPal and re-checks amount, currency and order id.' }),
              h('li', { text: 'Only then does the order move to paid, and the stock is committed to you.' })
            ])
          ]),
          h('h3', { text: 'Progress' }),
          timeline(order),
          h('a', { class: 'btn btn--ghost btn--sm', href: '/orders', 'data-link': 'true', style: { justifySelf: 'flex-start' }, text: '← All orders' })
        ]),
        payPanel(order)
      ])
    );
    const retryButton = host.querySelector('.pay-panel button.btn--primary');
    if (retryButton) retryButton.dataset.orderId = order.id;
    if (order.status === 'payment_processing') startPolling(order.id);

    // Keep the failure matrix discoverable in demos: the webhook can be replayed from the panel.
    if ((state.env?.paypalMode ?? 'simulator') === 'simulator' && order.status === 'paid') {
      host.querySelector('.pay-panel')?.append(
        h('details', {}, [
          h('summary', { class: 'note', text: 'Payment audit' }),
          h('div', { class: 'note', text: `Verified capture ${order.payment.paypalCaptureId} · amount match: ${order.payment.amountVerified ? 'yes' : 'unknown'} · attempts: ${order.payment.lastAttemptNo}` }),
          h('button', {
            class: 'btn btn--ghost btn--sm',
            type: 'button',
            text: 'Replay PAYMENT.CAPTURE.COMPLETED webhook',
            onclick: async () => {
              const { simulateWebhook } = await import('./api.js');
              await simulateWebhook(order.id).catch((error) => toast(error.message, { tone: 'danger' }));
              toast('Duplicate webhook delivered — the order was already paid, so nothing changed.');
            }
          })
        ])
      );
    }
  } catch (error) {
    host.replaceChildren(
      h('div', { class: 'empty-state' }, [
        h('h3', { text: 'We could not load that order' }),
        h('p', { class: 'note', text: `${error.message} (${error.code})` }),
        h('a', { class: 'btn btn--secondary', href: '/shop', 'data-link': 'true', text: 'Back to the shop' })
      ])
    );
  }
}

/* Payment failure help: show the exact PayPal error mapping without leaking provider internals. */
export function explainPaymentError(code) {
  const map = {
    PAYMENT_DECLINED: 'The payment method was declined by PayPal. Try another method or retry.',
    PAYMENT_PENDING: 'PayPal reported the payment as pending review. Wait for the webhook, then refresh.',
    PAYMENT_VERIFICATION_FAILED: 'PayPal returned a capture that did not match this order (amount, currency or order id), so the order stays unpaid for review.',
    PAYMENT_PROVIDER_UNAVAILABLE: 'PayPal did not answer in time. Nothing was charged — retry in a moment.',
    PAYMENT_ATTEMPT_LIMIT: 'This order reached the attempt limit. Start a new checkout from the cart.',
    QUOTE_STALE: 'Prices or availability changed, so the order needs a fresh review before payment.',
    ORDER_NOT_PAYABLE: 'This order can no longer be paid — start a new checkout from your cart.'
  };
  openModal({ title: 'Payment issue', body: h('p', { text: map[code] ?? `Payment could not complete (${code}).` }) });
}
