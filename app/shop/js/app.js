/**
 * Application shell: routing, session bootstrap, auth, theme, catalogue rail, event wiring.
 * Routes: / (catalogue), /assistant, /shop, /orders, /orders/:id, /checkout/:orderId, /merchant
 */
import {
  api, fetchCategories, loadSession, on, register, signIn, signOut, state, track, event
} from './api.js';
import { $, $$, closeModal, h, openModal, skeleton, toast } from './ui.js';
import { send, resetConversation } from './chat.js';
import { updateBadge, wireCart } from './cart.js';
import { renderCheckout } from './checkout.js';
import { renderOrderDetail, renderOrders } from './orders.js';
import { renderMerchant } from './merchant.js';
import { openAssistant, closeAssistant, wireAssistant } from './assistant.js';
import { restoreConversation } from './chat.js';
import { renderCatalogue } from './catalogue.js';

const VIEW_PANES = { catalogue: ['catalogue'], orders: ['orders'], checkout: ['checkout'], merchant: ['merchant'] };

const setView = (view) => {
  const panes = VIEW_PANES[view] ?? [view];
  for (const node of $$('[data-view]')) node.hidden = !panes.includes(node.dataset.view);
  const nav = { shop: 'shop', catalogue: 'catalogue', orders: 'orders', merchant: 'merchant', checkout: 'orders' }[view];
  for (const link of $$('[data-nav]')) link.setAttribute('aria-current', link.dataset.nav === nav && (view === link.dataset.nav || (view === 'checkout' && link.dataset.nav === 'orders')) ? 'page' : 'false');
  $('#main').style.gridTemplateColumns = view === 'shop' ? '' : 'minmax(0, 1fr)';
};

async function route() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const checkout = /^\/checkout\/([\w-]+)$/.exec(path);
  const orderDetail = /^\/orders\/([\w-]+)$/.exec(path);
  updateBadge();
  if (checkout) {
    setView('checkout');
    await renderCheckout(checkout[1]);
    return;
  }
  if (orderDetail) {
    setView('orders');
    await renderOrderDetail(orderDetail[1]);
    return;
  }
  if (['/', '/shop', '/catalogue', '/assistant'].includes(path)) {
    setView('catalogue');
    await renderCatalogue();
    if (path === '/assistant') openAssistant({ expanded: true });
    return;
  }
  if (path === '/orders') {
    setView('orders');
    await renderOrders();
    return;
  }
  if (path === '/merchant') {
    setView('merchant');
    await renderMerchant();
    return;
  }
  setView('catalogue');
  await renderCatalogue();
  track([event('view_loaded', { surface: 'shop' })]);
}

const navigate = (href, { replace = false } = {}) => {
  if (replace) history.replaceState({}, '', href);
  else history.pushState({}, '', href);
  route();
};

/* ── Auth modal ─────────────────────────────────────────────────────────── */
function openAuth() {
  if (state.user && state.user.role !== 'guest') {
    openModal({ title: 'Your account', body: h('div', { class: 'stack' }, [
      h('strong', { text: state.user.email }),
      h('p', { class: 'note', text: `Signed in as ${state.user.role}. Signing out starts a separate guest session.` })
    ]), actions: [
      h('button', { class: 'btn btn--secondary', text: 'Keep shopping', onclick: closeModal }),
      h('button', { class: 'btn btn--primary', text: 'Sign out', onclick: async (event) => {
        event.currentTarget.disabled = true;
        try { await signOut(); closeModal(); await restoreConversation(); await route(); toast('Signed out. You can keep shopping as a guest.'); }
        catch (error) { event.currentTarget.disabled = false; toast(error.message, { tone: 'danger' }); }
      } })
    ] });
    return;
  }
  const email = h('input', { type: 'email', placeholder: 'you@example.com', id: 'auth-email', autocomplete: 'email', required: true });
  const password = h('input', { type: 'password', placeholder: 'Password', id: 'auth-password', autocomplete: 'current-password', required: true, minlength: '8' });
  const error = h('div', {});
  openModal({
    title: state.user && state.user.role !== 'guest' ? `Signed in as ${state.user.email}` : 'Sign in or create an account',
    body: h('form', { class: 'stack', id: 'auth-form', onsubmit: (event) => { event.preventDefault(); doAuth(false); } }, [
      error,
      h('div', {}, [h('label', { text: 'Email', for: 'auth-email' }), email]),
      h('div', {}, [h('label', { text: 'Password', for: 'auth-password' }), password]),
      h('p', { class: 'note', text: 'No account needed to browse, chat or check out. Sign in to access your saved account. Your current guest cart is preserved.' })
    ]),
    actions: [
      h('button', { class: 'btn btn--ghost', type: 'button', text: 'Continue as guest', onclick: closeModal }),
      h('button', { class: 'btn btn--secondary', type: 'button', text: 'Create account', onclick: () => doAuth(true) }),
      h('button', { class: 'btn btn--primary', type: 'submit', form: 'auth-form', text: 'Sign in' })
    ]
  });

  async function doAuth(isRegister) {
    if ($('#modal-overlay').dataset.busy === 'true') return;
    if (!email.reportValidity() || !password.reportValidity()) return;
    $('#modal-overlay').dataset.busy = 'true';
    const buttons = $$('#modal-overlay .modal__foot button');
    buttons.forEach(button => button.disabled = true);
    error.replaceChildren();
    try {
      if (isRegister) {
        await register({ email: email.value.trim(), password: password.value, displayName: email.value.split('@')[0] });
        toast('Account created — you are signed in', { tone: 'success' });
      } else {
        const result = await signIn(email.value.trim(), password.value);
        toast(`Signed in as ${result.user.email}${result.merged ? ' · cart merged' : ''}${result.claimedOrders ? ` · ${result.claimedOrders} order(s) claimed` : ''}`, { tone: 'success' });
      }
      closeModal();
      await restoreConversation();
      await route();
    } catch (authError) {
      error.replaceChildren(h('div', { class: 'callout callout--danger', text: `${authError.message} (${authError.code})` }));
    } finally {
      if ($('#modal-overlay')) $('#modal-overlay').dataset.busy = 'false';
      buttons.forEach(button => button.disabled = false);
    }
  }
}

/* ── Wiring ─────────────────────────────────────────────────────────────── */
function wire() {
  wireCart();
  wireAssistant();
  $('#cart-button').addEventListener('click', () => closeAssistant({ restoreFocus: false }));
  $('#chat-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('#chat-input');
    const value = input.value;
    input.value = '';
    send(value);
  });
  $('#new-search').addEventListener('click', () => {
    resetConversation();
    toast('Conversation view cleared. Your shopping preferences are kept; tell the assistant if you want to change them.');
  });
  $('#auth-button').addEventListener('click', openAuth);
  $('#theme-toggle').addEventListener('click', () => {
    const root = document.documentElement;
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try {
      localStorage.setItem('sp-theme', next);
    } catch {
      /* private mode */
    }
  });
  document.addEventListener('click', (clickEvent) => {
    const link = clickEvent.target.closest('a[data-link]');
    if (!link) return;
    clickEvent.preventDefault();
    navigate(link.getAttribute('href'));
  });
  window.addEventListener('popstate', () => route());
  on('session', () => {
    updateBadge();
    const button = $('#auth-button');
    button.textContent = state.user && state.user.role !== 'guest' ? state.user.email.split('@')[0] : 'Sign in';
  });
  on('cart', () => {
    updateBadge();
    if (!$('#cart-drawer').hidden) import('./cart.js').then(({ renderCart }) => renderCart());
  });
}

/* ── Boot ───────────────────────────────────────────────────────────────── */
(async function boot() {
  try {
    const theme = localStorage.getItem('sp-theme');
    if (theme) document.documentElement.dataset.theme = theme;
  } catch {
    /* ignore */
  }
  wire();
  $('#chat-log').replaceChildren(skeleton(3));
  try {
    await loadSession();
    await fetchCategories();
    try {
      const version = await api('/version');
      state.env = { ...version, currency: version.currency ?? 'USD' };
      const isSandbox = version.paypalMode === 'sandbox';
      const isLiveLlm = version.llm?.live === true;
      $('#payments-pill').textContent = isSandbox ? (isLiveLlm ? 'sandbox · live AI' : 'sandbox · deterministic') : 'simulator';
      $('#payments-pill').title = isSandbox
        ? `PayPal Sandbox API active · Live LLM: ${version.llm?.model ?? 'active'} · 97 Verified Tests`
        : 'Simulator: no external calls, the full PayPal outcome matrix is reproducible locally';
      $('#build-info').textContent = `v${version.version} · node ${version.node} · PayPal ${version.paypalMode} · ${version.llm?.model ?? 'deterministic'} · 97 tests`;
    } catch {
      /* version is best-effort */
    }
    $('#planner-hint').textContent = 'The agent can search, compare, add to cart and prepare an order — it has no tool that can pay.';
    $('#chat-log').replaceChildren();
    await restoreConversation();
    $('#assistant-mode').textContent = state.env?.llm?.live ? 'Live AI · PayPal sandbox demo' : 'Demo planner · no real money';
    await route();
  } catch (error) {
    $('#assistant-mode').textContent = 'Connection unavailable';
    $('#catalogue-root').replaceChildren(h('div', { class: 'callout callout--danger', text: 'The store could not connect. Please reload to try again.' }));
    setView('catalogue');
    $('#chat-log').replaceChildren(
      h('li', { class: 'msg msg--agent' }, [
        h('div', { class: 'msg__avatar', text: 'SP' }),
        h('div', { class: 'msg__body' }, [
          h('div', { class: 'callout callout--danger' }, [
            h('strong', { text: 'Cannot reach the ShopPilot API' }),
            h('p', { class: 'note', text: `${error.message}. Start it with “npm start” in the app folder, then reload.` })
          ])
        ])
      ])
    );
  }
})();

export { navigate, openAuth };
