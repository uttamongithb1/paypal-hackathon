/**
 * Cart drawer + the cart → quote → order handoff (the explicit approval gate).
 * Docs: docs/ui_flows.md §4 — nothing here can create a payment.
 */
import { $, h, toast, skeleton } from './ui.js';
import { clearCart, createOrder, createQuote, fetchCart, money, removeCartItem, setCartQuantity, state, track, event } from './api.js';
import { amountBreakdown } from './cards.js';
import { deliveryAddressField, readAddressForm, readDeliveryAddress } from './shipping.js';

const drawer = () => $('#cart-drawer');

export const cartCount = () =>
  (state.cart?.items ?? []).reduce((sum, item) => sum + item.quantity, 0) || state.cart?.itemCount || 0;

export function updateBadge() {
  const badge = $('#cart-count');
  const count = cartCount();
  if (badge) badge.textContent = String(count);
  // The button's visible text is "Cart" plus the number. An aria-label that said only "Cart" left
  // the count unannounced and tripped axe's label-content-name-mismatch; on a phone the word is
  // hidden by CSS, so the label is the only name left. Keep it in step with the badge.
  const button = $('#cart-button');
  if (button) button.setAttribute('aria-label', `Cart, ${count} item${count === 1 ? '' : 's'}`);
}

export function openCart() {
  drawer().hidden = false;
  renderCart();
  drawer().querySelector('button')?.focus();
}
export function closeCart() {
  drawer().hidden = true;
}

function line(item) {
  return h('div', { class: 'cart-line' }, [
    h('div', {}, [
      h('div', { class: 'cart-line__title', text: item.title }),
      h('div', { class: 'note', text: `${item.display} each${item.merchant?.name ? ` · ${item.merchant.name}` : ''}` }),
      item.unavailable ? h('div', { class: 'badge badge--danger', text: 'Unavailable — remove to continue' }) : null,
      item.priceChanged ? h('div', { class: 'badge badge--warning', text: `Price changed from ${money(item.previousPriceMinor)}` }) : null
    ]),
    h('div', { class: 'stack', style: { alignItems: 'flex-end', gap: '6px' } }, [
      h('div', { class: 'qty' }, [
        h('button', {
          type: 'button',
          'aria-label': `Decrease quantity of ${item.title}`,
          text: '−',
          onclick: () => changeQuantity(item.productId, item.quantity - 1)
        }),
        h('span', { text: String(item.quantity) }),
        h('button', {
          type: 'button',
          'aria-label': `Increase quantity of ${item.title}`,
          text: '+',
          disabled: item.quantity >= 10 || (item.availableStock !== undefined && item.quantity >= item.availableStock),
          onclick: () => changeQuantity(item.productId, item.quantity + 1)
        })
      ]),
      h('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        text: 'Remove',
        onclick: async () => {
          try {
            await removeCartItem(item.productId);
            toast('Removed from cart');
            renderCart();
          } catch (error) {
            toast(error.message, { tone: 'danger' });
          }
        }
      })
    ])
  ]);
}

async function changeQuantity(productId, quantity) {
  if (quantity < 1) return;
  try {
    await setCartQuantity(productId, quantity);
    renderCart();
    track([event('cart_updated', { productId, quantity, surface: 'cart_drawer' })]);
  } catch (error) {
    toast(error.code === 'INSUFFICIENT_STOCK' ? error.message : `Could not update: ${error.message}`, { tone: 'danger' });
    renderCart();
  }
}

export async function renderCart() {
  const body = $('#cart-body');
  const foot = $('#cart-foot');
  if (!body) return;
  body.replaceChildren(skeleton(2));
  try {
    const cart = await fetchCart();
    updateBadge();
    if (!cart.items.length) {
      body.replaceChildren(
        h('div', { class: 'empty-state' }, [
          h('h3', { text: 'Your cart is empty' }),
          h('p', { class: 'note', text: 'Ask the agent in chat, or load our pre-configured demo basket.' }),
          h('button', {
            class: 'btn btn--secondary btn--sm',
            type: 'button',
            style: 'margin-top: 12px;',
            text: '⚡ Load 2-Seller Demo Basket (Multi-Merchant Split)',
            onclick: async (event) => {
              const btn = event.currentTarget;
              btn.disabled = true;
              btn.textContent = 'Loading demo basket…';
              try {
                const { fetchProducts, addToCart } = await import('./api.js');
                const prods = await fetchProducts({ limit: 15 });
                const items = prods.items ?? [];
                const m1 = items.find((p) => p.merchant?.name?.includes('Vertex') && p.available > 0);
                const m2 = items.find((p) => !p.merchant?.name?.includes('Vertex') && p.available > 0);
                if (m1) await addToCart(m1.id, 1);
                if (m2) await addToCart(m2.id, 1);
                toast('Loaded multi-merchant demo basket!', { tone: 'success' });
                renderCart();
              } catch (err) {
                toast(err.message, { tone: 'danger' });
                btn.disabled = false;
                btn.textContent = '⚡ Load 2-Seller Demo Basket';
              }
            }
          })
        ])
      );
      foot.replaceChildren();
      return;
    }
    body.replaceChildren(
      h('div', {}, cart.items.map(line)),
      cart.warnings?.length
        ? h('div', { class: 'stack' }, cart.warnings.map((warning) =>
            h('div', { class: `callout callout--${warning.code === 'LOW_STOCK' ? 'warning' : 'agent'}`, text: warning.message })
          ))
        : null
    );
    const blocked = cart.items.some((item) => item.unavailable);
    // The drawer is rebuilt on every cart change, so whatever the shopper has typed into the
    // delivery address is carried across rather than wiped.
    const addressDraft = readAddressForm(document);
    const isGuest = !state.user?.email || state.user?.role === 'guest';
    const guestEmailField = isGuest
      ? h('div', { class: 'field', style: 'margin-bottom: 0.75rem; text-align: left;' }, [
          h('label', { for: 'cart-guest-email', class: 'label', text: 'Email for receipt & order status' }),
          h('input', {
            id: 'cart-guest-email',
            type: 'email',
            class: 'input',
            placeholder: 'guest@demo.dev',
            value: localStorage.getItem('shoppilot_guest_email') || 'shopper@demo.dev'
          })
        ])
      : null;

    foot.replaceChildren(
      amountBreakdown({ subtotalMinor: cart.subtotalMinor, shippingMinor: 0, taxMinor: 0, totalMinor: cart.subtotalMinor, display: { subtotal: cart.display, shipping: '—', tax: '—', total: cart.display } }),
      h('p', { class: 'note', text: 'Shipping and tax are computed server-side at checkout — the agent never guesses them.' }),
      guestEmailField,
      deliveryAddressField(addressDraft),
      h('button', {
        class: 'btn btn--primary btn--block',
        type: 'button',
        text: blocked ? 'Remove unavailable items to continue' : 'Review & pay',
        disabled: blocked,
        onclick: () => reviewAndPay()
      }),
      h('button', {
        class: 'btn btn--ghost btn--block',
        type: 'button',
        text: 'Empty cart',
        onclick: async () => {
          await clearCart();
          renderCart();
          toast('Cart emptied');
        }
      })
    );
  } catch (error) {
    body.replaceChildren(h('div', { class: 'callout callout--danger', text: error.message }));
  }
}

/**
 * The explicit step: quote (server prices + holds) → order (draft awaiting payment) → checkout page.
 * Only a human click on the checkout page can start a PayPal payment.
 */
export async function reviewAndPay() {
  const button = $('#cart-foot .btn--primary');
  if (button) {
    button.disabled = true;
    button.textContent = 'Reserving stock…';
  }
  try {
    const quote = await createQuote(true);
    if (!quote?.id || !quote?.hash) {
      // Never post an order without a quote: the server would reject it and the shopper would see
      // a raw validation error instead of a useful message.
      throw Object.assign(new Error('We could not price this cart just now. Please try again.'), { code: 'QUOTE_UNAVAILABLE' });
    }
    track([event('checkout_started', { itemCount: quote.lines?.length ?? 0, totalMinor: quote.amounts?.totalMinor ?? 0, fromSurface: 'checkout' })]);
    let email = state.user?.email;
    let name = state.user?.displayName ?? state.user?.email;
    if (!email || state.user?.role === 'guest') {
      const guestInput = $('#cart-guest-email');
      email = guestInput?.value?.trim() || localStorage.getItem('shoppilot_guest_email') || 'shopper@demo.dev';
      if (email) localStorage.setItem('shoppilot_guest_email', email);
      name = name ?? email.split('@')[0];
    }
    const contact = email ? { email, name: name || 'Guest Shopper' } : null;
    const shippingAddress = readDeliveryAddress(document);
    const result = await createOrder({ quoteId: quote.id, quoteHash: quote.hash, contact, shippingAddress });
    toast(`Order ${result.order.orderNumber} created — approve the payment to finish`, { tone: 'success' });
    closeCart();
    location.assign(`/checkout/${result.order.id}`);
  } catch (error) {
    if (error.code === 'QUOTE_STALE') {
      toast('Prices changed while you were reviewing — the totals have been refreshed. Review again.', { tone: 'warning' });
      renderCart();
    } else if (error.code === 'VALIDATION_ERROR' && /email/i.test(error.message ?? '')) {
      toast('Add an email address or sign in to place the order.', { tone: 'warning' });
      document.getElementById('auth-button')?.click();
    } else {
      toast(error.message, { tone: 'danger' });
    }
    if (button) {
      button.disabled = false;
      button.textContent = 'Review & pay';
    }
  }
}

export function wireCart() {
  $('#cart-button').addEventListener('click', () => (drawer().hidden ? openCart() : closeCart()));
  document.querySelectorAll('[data-close="cart"]').forEach((node) => node.addEventListener('click', closeCart));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !drawer().hidden) closeCart();
  });
  document.addEventListener('sp:cart', () => {
    updateBadge();
    if (!drawer().hidden) renderCart();
  });
  updateBadge();
}

export const cartSummaryText = (cart) => `${cart.itemCount} item(s) · ${cart.display}`;
