/**
 * Application shell: routing, session bootstrap, auth, theme, catalogue rail, event wiring.
 * Routes: / (chat), /shop, /orders, /orders/:id, /checkout/:orderId, /merchant
 */
import {
  api, fetchCategories, fetchProducts, loadSession, on, register, signIn, signOut, state, track, event
} from './api.js';
import { $, $$, closeModal, h, openModal, skeleton, toast } from './ui.js';
import { start as startChat, send, resetConversation, openProduct } from './chat.js';
import { railItem } from './cards.js';
import { updateBadge, wireCart } from './cart.js';
import { renderCheckout } from './checkout.js';
import { renderOrderDetail, renderOrders } from './orders.js';
import { renderMerchant } from './merchant.js';
import { renderCatalogue } from './catalogue.js';
import { renderAdmin } from './admin.js';

/**
 * The catalogue rail is a companion to the shop view, not a view of its own — it shares the grid
 * column with the chat pane. Mapping every view to the panes it owns keeps that explicit instead of
 * hiding the rail on the one screen that needs it.
 */
const VIEW_PANES = {
  shop: ['shop', 'rail'],
  catalogue: ['catalogue'],
  orders: ['orders'],
  checkout: ['checkout'],
  merchant: ['merchant'],
  admin: ['admin']
};

const setView = (view) => {
  const panes = VIEW_PANES[view] ?? [view];
  for (const node of $$('[data-view]')) node.hidden = !panes.includes(node.dataset.view);
  const nav = { shop: 'shop', catalogue: 'catalogue', orders: 'orders', merchant: 'merchant', checkout: 'orders', admin: 'admin' }[view];
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
  if (path === '/catalogue') {
    setView('catalogue');
    await renderCatalogue();
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
  if (path === '/admin') {
    setView('admin');
    await renderAdmin();
    return;
  }
  setView('shop');
  startChat();
  await renderRail();
  track([event('view_loaded', { surface: 'shop' })]);
}

const navigate = (href, { replace = false } = {}) => {
  if (replace) history.replaceState({}, '', href);
  else history.pushState({}, '', href);
  route();
};

/* ── Catalogue rail ─────────────────────────────────────────────────────── */
async function renderRail() {
  const grid = $('#rail-grid');
  if (!grid) return;
  const category = $('#category-filter')?.value ?? '';
  const query = $('#rail-search')?.value ?? '';
  grid.replaceChildren(skeleton(3));
  try {
    const { items, total } = await fetchProducts({ category, q: query, limit: 8 });
    grid.replaceChildren(
      ...(items.length
        ? items.map((product) => railItem(product, { onDetails: (slug) => openProduct(slug) }))
        : [h('div', { class: 'empty-state' }, [h('p', { class: 'note', text: 'No products match that filter.' })])])
    );
    $('#rail-count').textContent = `${total ?? items.length} products`;
  } catch (error) {
    grid.replaceChildren(h('div', { class: 'callout callout--danger', text: error.message }));
  }
}

/* ── Auth modal ─────────────────────────────────────────────────────────── */
function openAuth() {
  const email = h('input', { type: 'email', placeholder: 'you@example.com', value: 'customer@demo.dev' });
  const password = h('input', { type: 'password', placeholder: 'Password', value: 'Customer@12345' });
  const error = h('div', {});
  openModal({
    title: state.user && state.user.role !== 'guest' ? `Signed in as ${state.user.email}` : 'Sign in or create an account',
    body: h('div', { class: 'stack' }, [
      error,
      h('div', {}, [h('label', { text: 'Email' }), email]),
      h('div', {}, [h('label', { text: 'Password' }), password]),
      h('div', { class: 'callout' }, [
        h('strong', { text: 'Demo accounts' }),
        h('p', { class: 'note', text: 'customer@demo.dev / Customer@12345 · merchant@demo.dev / Merchant@12345 · admin@demo.dev / Admin@12345' })
      ]),
      h('p', { class: 'note', text: 'Signing in claims any orders placed as a guest with the same email and merges your cart.' })
    ]),
    actions: [
      h('button', { class: 'btn btn--ghost', type: 'button', text: 'Cancel', onclick: closeModal }),
      h('button', { class: 'btn btn--secondary', type: 'button', text: 'Create account', onclick: () => doAuth(true) }),
      h('button', { class: 'btn btn--primary', type: 'button', text: 'Sign in', onclick: () => doAuth(false) })
    ]
  });

  async function doAuth(isRegister) {
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
      await route();
    } catch (authError) {
      error.replaceChildren(h('div', { class: 'callout callout--danger', text: `${authError.message} (${authError.code})` }));
    }
  }
}

/* ── Wiring ─────────────────────────────────────────────────────────────── */
function wire() {
  wireCart();
  $('#chat-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('#chat-input');
    const value = input.value;
    input.value = '';
    send(value);
  });
  $('#new-search').addEventListener('click', () => {
    resetConversation();
    toast('Fresh conversation — the requirement history is cleared for this session.');
  });
  // First-run hero: each example is a real prompt handed straight to the agent.
  for (const button of $$('#hero-examples [data-prompt]')) {
    button.addEventListener('click', () => {
      track([event('hero_example_clicked', { prompt: button.dataset.prompt })]);
      send(button.dataset.prompt);
    });
  }
  $('#auth-button').addEventListener('click', async () => {
    if (state.user && state.user.role !== 'guest') {
      await signOut();
      toast('Signed out — you are browsing as a guest again.');
      route();
    } else {
      openAuth();
    }
  });
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
  $('#category-filter').addEventListener('change', renderRail);
  let searchTimer;
  $('#rail-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderRail, 220);
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
    // The platform console is only for the platform operator, so the link appears for that role
    // and nobody else. The route itself is guarded by the API.
    const adminNav = $('#admin-nav');
    if (adminNav) adminNav.hidden = state.user?.role !== 'admin';
    await fetchCategories();
    const filter = $('#category-filter');
    filter.replaceChildren(h('option', { value: '', text: 'All categories' }), ...state.categories.map((category) => h('option', { value: category.slug, text: category.name ?? category.slug })));
    try {
      const version = await api('/version');
      state.env = { ...version, currency: version.currency ?? 'USD' };
      const isSandbox = version.paypalMode === 'sandbox';
      const isLiveLlm = version.llm?.live === true;
      const paypalDown = version.paypalHealth === 'down';
      // Quote the suite's real size — it comes from the server, which reads it from
      // test-count.json, so it can never drift from the number of tests that actually run.
      const tests = version.tests?.count ? `${version.tests.count} tests` : 'tested build';
      const pill = $('#payments-pill');
      if (paypalDown) {
        pill.textContent = 'payments degraded';
        pill.title = 'PayPal is not answering right now — browsing and the agent still work, checkout is paused.';
        pill.classList.add('pill--warning');
      } else {
        pill.textContent = isSandbox ? (isLiveLlm ? 'sandbox · live AI' : 'sandbox · deterministic') : 'simulator';
        pill.title = isSandbox
          ? `PayPal Sandbox API active · Live LLM: ${version.llm?.model ?? 'active'} · ${tests}`
          : 'Simulator: no external calls, the full PayPal outcome matrix is reproducible locally';
        pill.classList.remove('pill--warning');
      }
      $('#build-info').textContent = `v${version.version} · node ${version.node} · PayPal ${version.paypalMode} · ${version.llm?.model ?? 'deterministic'} · ${tests}`;
    } catch {
      /* version is best-effort */
    }
    $('#planner-hint').textContent = 'The agent can search, compare, add to cart and prepare an order — it has no tool that can pay.';
    $('#chat-log').replaceChildren();
    await route();
  } catch (error) {
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

export { navigate, openAuth, renderRail };
