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
import { renderAdmin } from './admin.js';

/**
 * Every view to the panes it owns. The storefront is the catalogue now and the chat lives in the
 * assistant panel, so there is no separate shop page or catalogue rail to map.
 */
const VIEW_PANES = {
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
  document.body.classList.toggle('view-dashboard', view === 'merchant' || view === 'admin');
};

export function updateNavForRole() {
  const role = state.user?.role ?? 'guest';
  const merchantNav = $('[data-nav="merchant"]');
  const adminNav = $('#admin-nav');
  const footAdminLink = $('#foot-admin-link');

  if (merchantNav) {
    // Merchant nav is visible only when merchant or admin is logged in
    merchantNav.hidden = !(role === 'merchant' || role === 'admin');
  }
  if (adminNav) {
    // Platform Console nav is visible only when platform admin is logged in
    adminNav.hidden = role !== 'admin';
  }
  if (footAdminLink) {
    // Platform Console footer link is visible only when platform admin is logged in
    footAdminLink.hidden = role !== 'admin';
  }
}

async function route() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const checkout = /^\/checkout\/([\w-]+)$/.exec(path);
  const orderDetail = /^\/orders\/([\w-]+)$/.exec(path);
  updateBadge();
  updateNavForRole();
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
    if (state.user && state.user.role === 'customer') {
      toast('Merchant account required. Shoppers cannot access the Merchant panel.', { tone: 'danger' });
      navigate('/', { replace: true });
      return;
    }
    setView('merchant');
    await renderMerchant();
    return;
  }
  if (path === '/admin') {
    if (state.user && state.user.role !== 'admin' && state.user.role !== 'guest') {
      toast(`Access denied: Administrator privileges required. ${state.user.role} accounts cannot access the Platform Console.`, { tone: 'danger' });
      navigate(state.user.role === 'merchant' ? '/merchant' : '/', { replace: true });
      return;
    }
    setView('admin');
    await renderAdmin();
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
export function openAuth({ message, onSuccess, requireLogin = false } = {}) {
  if (state.user && state.user.role !== 'guest') {
    openModal({ title: 'Your account', body: h('div', { class: 'stack' }, [
      h('strong', { text: state.user.email }),
      h('p', { class: 'note', text: `Signed in as ${state.user.role}. Signing out starts a separate guest session.` })
    ]), actions: [
      h('button', { class: 'btn btn--secondary', text: 'Keep shopping', onclick: closeModal }),
      h('button', { class: 'btn btn--primary', text: 'Sign out', onclick: async (event) => {
        event.currentTarget.disabled = true;
        try {
          await signOut();
          closeModal();
          updateNavForRole();
          await restoreConversation();
          if (['/merchant', '/admin'].includes(location.pathname.replace(/\/+$/, '') || '/')) {
            navigate('/', { replace: true });
          } else {
            await route();
          }
          toast('Signed out. You can keep shopping as a guest.');
        }
        catch (error) { event.currentTarget.disabled = false; toast(error.message, { tone: 'danger' }); }
      } })
    ] });
    return;
  }
  const email = h('input', { type: 'email', placeholder: 'you@example.com', id: 'auth-email', autocomplete: 'email', required: true });
  const password = h('input', { type: 'password', placeholder: 'Password', id: 'auth-password', autocomplete: 'current-password', required: true, minlength: '8' });
  const error = h('div', {});

  const notice = message
    ? h('div', { class: 'callout callout--warning', style: 'margin-bottom: 6px;' }, [
        h('strong', { text: '🔒 Sign in required to buy' }),
        h('p', { class: 'note', text: message })
      ])
    : null;

  const demoRoles = [
    {
      role: 'Shopper',
      icon: '🛍️',
      title: 'Shopper Account',
      email: 'customer@demo.dev',
      pass: 'Customer@12345',
      desc: 'Buy products & view order history',
      tone: 'primary'
    },
    {
      role: 'Merchant',
      icon: '🏪',
      title: 'Merchant Account',
      email: 'merchant@demo.dev',
      pass: 'Merchant@12345',
      desc: 'Vertex Systems seller portal & analytics',
      tone: 'secondary'
    },
    {
      role: 'Admin',
      icon: '⚙️',
      title: 'Platform Admin',
      email: 'admin@demo.dev',
      pass: 'Admin@12345',
      desc: 'AG Grid console, platform fees & audit',
      tone: 'secondary'
    }
  ];

  const roleCards = demoRoles.map(role =>
    h('div', {
      class: 'card',
      style: {
        padding: '10px 12px',
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: '8px',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px'
      }
    }, [
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, [
        h('strong', { style: { fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }, text: `${role.icon} ${role.title}` }),
        h('span', { class: 'note', style: { fontSize: '11px', color: 'var(--color-primary)' }, text: role.desc })
      ]),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '12px', fontSize: '12px', background: 'var(--color-surface-2)', padding: '6px 8px', borderRadius: '6px' } }, [
        h('span', { class: 'note' }, [
          h('span', { style: { fontWeight: '600', color: 'var(--color-text)' }, text: 'Email: ' }),
          h('code', { class: 'mono', style: { color: 'var(--color-text)' }, text: role.email })
        ]),
        h('span', { class: 'note' }, [
          h('span', { style: { fontWeight: '600', color: 'var(--color-text)' }, text: 'Password: ' }),
          h('code', { class: 'mono', style: { color: 'var(--color-primary)', fontWeight: '700' }, text: role.pass })
        ])
      ]),
      h('button', {
        class: `btn btn--${role.tone} btn--sm`,
        type: 'button',
        style: 'width: 100%; font-weight: 600; margin-top: 2px;',
        text: `⚡ Sign in as ${role.role} (${role.email})`,
        onclick: async () => {
          email.value = role.email;
          password.value = role.pass;
          await doAuth(false);
        }
      })
    ])
  );

  const demoBox = h('div', {
    class: 'stack',
    style: {
      gap: '8px',
      background: 'var(--color-surface-2)',
      padding: '12px',
      borderRadius: '10px',
      border: '1px solid var(--color-border)'
    }
  }, [
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, [
      h('span', { style: { fontWeight: '700', fontSize: '13px' }, text: '🔑 3 Demo Accounts (With Visible Passwords)' }),
      h('span', { class: 'note mono', style: { fontSize: '11px' }, text: '1-click sign in' })
    ]),
    h('p', { class: 'note', style: { margin: '0 0 2px 0', fontSize: '12px' }, text: 'Test any role below. Each account shows its visible email and password, plus a 1-click instant login button:' }),
    ...roleCards
  ]);

  const divider = h('div', { style: { textAlign: 'center', margin: '4px 0' } }, [
    h('span', { class: 'note mono', style: { fontSize: '11px', textTransform: 'uppercase' }, text: '— Or enter credentials manually —' })
  ]);

  openModal({
    title: requireLogin ? 'Sign in to complete your purchase' : (state.user && state.user.role !== 'guest' ? `Signed in as ${state.user.email}` : 'Sign in or create an account'),
    body: h('form', { class: 'stack', id: 'auth-form', onsubmit: (event) => { event.preventDefault(); doAuth(false); } }, [
      notice,
      error,
      demoBox,
      divider,
      h('div', {}, [h('label', { text: 'Email', for: 'auth-email' }), email]),
      h('div', {}, [h('label', { text: 'Password', for: 'auth-password' }), password]),
      h('p', { class: 'note', text: 'Sign in to complete orders and access your order history. Your current cart items are preserved and merged upon sign-in.' })
    ]),
    actions: [
      h('button', { class: 'btn btn--ghost', type: 'button', text: requireLogin ? 'Cancel' : 'Continue as guest', onclick: closeModal }),
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
      updateNavForRole();
      await restoreConversation();
      if (onSuccess) {
        // A context-specific sign-in (e.g. completing checkout) resumes that action, not a redirect.
        await onSuccess(state.user);
      } else {
        // Land each role on its home surface: a merchant goes straight to the Merchant dashboard
        // and an admin to the Platform Console, so the relevant panel is visible immediately after
        // sign-in instead of leaving them on the catalogue with only a new nav link. Shoppers stay
        // where they were. `replace` keeps the back button from returning to a pre-login state.
        const role = state.user?.role;
        if (role === 'merchant') navigate('/merchant', { replace: true });
        else if (role === 'admin') navigate('/admin', { replace: true });
        else await route();
      }
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
  const micBtn = $('#chat-mic');
  if (micBtn) {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRec) {
      const rec = new SpeechRec();
      rec.continuous = false;
      rec.interimResults = true;
      let listening = false;
      micBtn.addEventListener('click', () => {
        if (listening) {
          rec.stop();
          return;
        }
        try {
          rec.start();
          listening = true;
          micBtn.classList.add('composer__mic--active');
          micBtn.setAttribute('title', 'Listening… speak your shopping request');
          toast('Listening… describe what you need', { tone: 'default' });
        } catch (err) {
          console.warn('Speech recognition start failed', err);
        }
      });
      rec.onresult = (e) => {
        const transcript = Array.from(e.results).map((r) => r[0].transcript).join('');
        const input = $('#chat-input');
        if (input) input.value = transcript;
      };
      rec.onend = () => {
        listening = false;
        micBtn.classList.remove('composer__mic--active');
        micBtn.setAttribute('title', 'Voice input (speak to ShopPilot)');
        const input = $('#chat-input');
        if (input && input.value.trim()) input.focus();
      };
      rec.onerror = () => {
        listening = false;
        micBtn.classList.remove('composer__mic--active');
        micBtn.setAttribute('title', 'Voice input (speak to ShopPilot)');
      };
    } else {
      micBtn.hidden = true;
    }
  }
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
    updateNavForRole();
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
    updateNavForRole();
    await fetchCategories();
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
      if (pill) {
        if (paypalDown) {
          pill.textContent = '● Payments Degraded';
          pill.title = 'PayPal API is temporarily paused.';
          pill.classList.add('pill--warning');
          pill.style.display = 'inline-flex';
        } else {
          pill.textContent = isSandbox ? '● PayPal Sandbox' : '● Simulator';
          pill.title = `PayPal Mode: ${version.paypalMode} · AI Model: ${version.llm?.model ?? 'active'}`;
          pill.classList.remove('pill--warning');
          pill.style.display = 'inline-flex';
        }
      }
      $('#build-info').textContent = `v${version.version} · node ${version.node} · PayPal ${version.paypalMode} · ${version.llm?.model ?? 'deterministic'} · ${tests}`;
    } catch {
      /* version is best-effort */
    }
    $('#planner-hint').textContent = 'Ask about products, compare specs, or check your cart.';
    $('#chat-log').replaceChildren();
    await restoreConversation();
    $('#assistant-mode').textContent = state.env?.llm?.live ? 'Live AI Shopping Companion' : 'AI Shopping Companion';
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

export { navigate };
