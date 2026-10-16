/**
 * Rendering helpers shared by every view: DOM building, escaping, product art, toasts, modals,
 * price/stock formatting. Everything is inline-safe (no external assets, no CDN) so the storefront
 * works offline and inside sandboxed previews.
 */
import { money } from './api.js';

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

export const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);

/** Small hyperscript: h('div', { className, onclick }, [children]) */
export function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/* ── Product art: deterministic gradients + category glyphs (no image files to ship) ─────────── */
const CATEGORY_GLYPH = {
  laptops: 'M4 6h16v9H4zM3 17h18v2H3z',
  phones: 'M8 3h8v18H8zM11 18.5h2',
  headphones: 'M5 14v-2a7 7 0 0 1 14 0v2M5 14h3v5H6a1 1 0 0 1-1-1zM16 14h3v4a1 1 0 0 1-1 1h-2z',
  monitors: 'M3 4h18v12H3zM9 20h6M12 16v4',
  default: 'M4 5h16v14H4z'
};

const hashOf = (value) => {
  let hash = 2166136261;
  for (let index = 0; index < String(value).length; index += 1) {
    hash ^= String(value).charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
};

/** Composition per size: glyph anchored left, oversized initials watermark right, no collisions. */
const ART_SPECS = {
  rail:   { w: 120, h: 120, glyphScale: 2.7, glyphX: 0,    glyphOpacity: 0.9,  initials: null },
  card:   { w: 320, h: 150, glyphScale: 4.2, glyphX: -62,  glyphOpacity: 0.85, initials: { size: 62, x: 300, y: 118, opacity: 0.16 } },
  detail: { w: 640, h: 300, glyphScale: 8.0, glyphX: -140, glyphOpacity: 0.85, initials: { size: 120, x: 598, y: 236, opacity: 0.15 } }
};

/**
 * Deterministic product artwork. No binary assets ship with the repo: the art is generated from the
 * product slug so every item has a stable, on-brand image (see docs/design_system.md §6).
 */
export function renderProductArt(product, { size = 'card' } = {}) {
  const seed = hashOf(product.slug ?? product.title ?? product.id);
  const hue = seed % 360;
  const hue2 = (hue + 38) % 360;
  const spec = ART_SPECS[size] ?? ART_SPECS.card;
  const { w, h: artH, glyphScale, glyphX, glyphOpacity, initials } = spec;
  const glyph = CATEGORY_GLYPH[product.categorySlug] ?? CATEGORY_GLYPH.default;
  const productInitials = String(product.title ?? '')
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
  const cx = w / 2;
  const cy = artH / 2;

  const svg = `
    <svg viewBox="0 0 ${w} ${artH}" role="img" aria-label="${escapeHtml(product.title)}" preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id="bg${seed}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="hsl(${hue} 72% 90%)" />
          <stop offset="58%" stop-color="hsl(${(hue + 18) % 360} 68% 82%)" />
          <stop offset="100%" stop-color="hsl(${hue2} 64% 72%)" />
        </linearGradient>
        <radialGradient id="glow${seed}" cx="26%" cy="18%" r="72%">
          <stop offset="0%" stop-color="#ffffff" stop-opacity="0.72" />
          <stop offset="100%" stop-color="#ffffff" stop-opacity="0" />
        </radialGradient>
      </defs>

      <rect width="${w}" height="${artH}" fill="url(#bg${seed})" />
      <rect width="${w}" height="${artH}" fill="url(#glow${seed})" />

      <!-- soft rings anchored bottom-right, keeps large flat areas from looking empty -->
      <g fill="none" stroke="hsl(${hue2} 60% 40%)" stroke-opacity="0.16">
        <circle cx="${w * 0.86}" cy="${artH * 0.9}" r="${Math.min(w, artH) * 0.34}" stroke-width="1.4" />
        <circle cx="${w * 0.86}" cy="${artH * 0.9}" r="${Math.min(w, artH) * 0.52}" stroke-width="1.2" />
        <circle cx="${w * 0.86}" cy="${artH * 0.9}" r="${Math.min(w, artH) * 0.7}" stroke-width="1" />
      </g>

      <!-- category glyph: filled halo + crisp stroke, so it reads at every size -->
      <g transform="translate(${cx + glyphX} ${cy}) scale(${glyphScale}) translate(-12 -12)">
        <path d="${glyph}" fill="hsl(${hue} 60% 34%)" fill-opacity="0.16" stroke="none" transform="scale(1.06) translate(-0.7 -0.7)" />
        <path d="${glyph}" fill="none" stroke="hsl(${hue} 62% 26%)" stroke-opacity="${glyphOpacity}"
              stroke-width="${1.7 / glyphScale * 2.4}" stroke-linecap="round" stroke-linejoin="round" />
      </g>

      ${
        initials
          ? `<text x="${initials.x}" y="${initials.y}" text-anchor="end" font-family="Inter, system-ui, sans-serif"
                   font-size="${initials.size}" font-weight="800" letter-spacing="-0.05em"
                   fill="hsl(${hue2} 52% 26%)" fill-opacity="${initials.opacity}">${escapeHtml(productInitials)}</text>`
          : ''
      }
    </svg>`;
  return h('div', { class: `product-art product-art--${size}`, html: svg });
}

/* ── Status + formatting ────────────────────────────────────────────────── */
export const statusTone = (status) =>
  ({
    paid: 'success',
    processing: 'success',
    shipped: 'success',
    delivered: 'success',
    in_stock: 'success',
    awaiting_payment: 'warning',
    payment_processing: 'warning',
    pending: 'warning',
    low_stock: 'warning',
    draft: 'muted',
    payment_failed: 'danger',
    failed: 'danger',
    cancelled: 'danger',
    expired: 'danger',
    out_of_stock: 'danger',
    refunded: 'danger'
  })[status] ?? 'muted';

export const humanStatus = (status) => String(status ?? '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export const priceText = (price, minor) => price?.display ?? money(minor ?? price?.amountMinor ?? 0);

export function stockBadge(product) {
  const available = product?.stock?.available ?? product?.stock;
  const state = product?.availability ?? product?.stock?.state;
  const tone = statusTone(state ?? (available > 3 ? 'in_stock' : available > 0 ? 'low_stock' : 'out_of_stock'));
  const label = state === 'out_of_stock' || available <= 0 ? 'Out of stock' : state === 'low_stock' ? `Only ${available} left` : `${available} in stock`;
  return h('span', { class: `badge badge--${tone}`, text: label });
}

export const specChips = (attributes = {}, limit = 5) =>
  h(
    'div',
    { class: 'spec-row' },
    Object.entries(attributes ?? {})
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .slice(0, limit)
      .map(([key, value]) => h('span', { class: 'spec-chip', title: key, text: `${labelFor(key)}: ${formatSpecValue(key, value)}` }))
  );

const LABELS = {
  ramGb: 'RAM',
  storageGb: 'Storage',
  screenIn: 'Screen',
  weightG: 'Weight',
  batteryWh: 'Battery',
  cpu: 'CPU',
  gpu: 'GPU',
  backlitKeyboard: 'Backlit keys',
  upgradeableRam: 'RAM upgrade',
  cameraMp: 'Camera',
  batteryMah: 'Battery',
  has5g: '5G',
  noiseCancelling: 'ANC',
  batteryH: 'Battery life',
  driverMm: 'Drivers',
  wireless: 'Wireless',
  resolution: 'Resolution',
  refreshHz: 'Refresh',
  panel: 'Panel',
  hdr: 'HDR',
  usbC: 'USB-C',
  ports: 'Ports'
};
const labelFor = (key) => LABELS[key] ?? key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

export function formatSpecValue(key, value) {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (key === 'weightG') return `${(value / 1000).toFixed(2)} kg`;
  if (key === 'storageGb') return value >= 1024 ? `${value / 1024} TB` : `${value} GB`;
  if (key === 'ramGb') return `${value} GB`;
  if (key === 'batteryWh') return `${value} Wh`;
  if (key === 'batteryH') return `${value} h`;
  if (key === 'screenIn') return `${value}"`;
  if (key === 'refreshHz') return `${value} Hz`;
  if (key === 'batteryMah') return `${value} mAh`;
  return String(value);
}

/* ── Toasts ─────────────────────────────────────────────────────────────── */
export function toast(message, { tone = 'info', timeout = 4200 } = {}) {
  const host = $('#toasts');
  if (!host) return;
  const node = h('div', { class: `toast toast--${tone}`, role: 'status', text: message });
  host.append(node);
  setTimeout(() => {
    node.classList.add('toast--leaving');
    setTimeout(() => node.remove(), 200);
  }, timeout);
}

/* ── Modal ──────────────────────────────────────────────────────────────── */
export function openModal({ title, body, actions = [], size = '' }) {
  closeModal();
  const overlay = h('div', { class: 'modal-overlay', id: 'modal-overlay', onclick: (event) => { if (event.target === overlay) closeModal(); } }, [
    h('div', { class: `modal ${size}` , role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
      h('header', { class: 'modal__head' }, [h('h2', { text: title }), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', text: '✕', onclick: closeModal })]),
      h('div', { class: 'modal__body' }, [body]),
      actions.length ? h('footer', { class: 'modal__foot' }, actions) : null
    ])
  ]);
  document.body.append(overlay);
  document.addEventListener('keydown', escClose);
  overlay.querySelector('button, input, select, textarea')?.focus();
  return overlay;
}
const escClose = (event) => {
  if (event.key === 'Escape') closeModal();
};
export function closeModal() {
  document.removeEventListener('keydown', escClose);
  $('#modal-overlay')?.remove();
}

export const skeleton = (rows = 3) => h('div', { class: 'skeleton-stack' }, Array.from({ length: rows }, () => h('div', { class: 'skeleton' })));

export const emptyState = (title, body, action) =>
  h('div', { class: 'empty-state' }, [h('h3', { text: title }), body ? h('p', { text: body }) : null, action ?? null]);
