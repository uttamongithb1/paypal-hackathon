/**
 * Renderers for the agent's UI components (docs/ai_agent_spec.md §6) and the storefront widgets.
 * Every renderer returns a detached DOM node; nothing here fetches data.
 */
import { $, el, esc, productArt, statusDot, titleCase } from './dom.js';
import { money, moneyFull, state } from './api.js';

const SPEC_KEYS = {
  laptops: ['ramGb', 'storageGb', 'cpu', 'gpu', 'batteryWh', 'weightG', 'screenIn', 'backlitKeyboard'],
  phones: ['ramGb', 'storageGb', 'cameraMp', 'batteryMah', 'screenIn', 'has5g'],
  headphones: ['noiseCancelling', 'batteryH', 'weightG', 'driverMm', 'wireless'],
  monitors: ['screenIn', 'resolution', 'refreshHz', 'panel', 'hdr', 'usbC']
};

const formatAttr = (key, value) => {
  if (typeof value === 'boolean') return value ? titleCase(key) : `No ${titleCase(key)}`;
  if (value === null || value === undefined) return null;
  const units = { ramGb: ' GB RAM', storageGb: ' GB', batteryWh: ' Wh', weightG: ' g', screenIn: '"', cameraMp: ' MP', batteryH: ' h', refreshHz: ' Hz', driverMm: ' mm', batteryMah: ' mAh' };
  const label = { ramGb: 'RAM', storageGb: 'Storage', batteryWh: 'Battery', weightG: 'Weight', screenIn: 'Screen', cameraMp: 'Camera', noiseCancelling: 'ANC', has5g: '5G', refreshHz: 'Refresh', resolution: 'Resolution', panel: 'Panel', hdr: 'HDR', usbC: 'USB-C', driverMm: 'Driver', wireless: 'Wireless', backlitKeyboard: 'Backlit keys', cpu: 'CPU', gpu: 'GPU', upgradeableRam: 'Upgradeable RAM', batteryMah: 'Battery' }[key] ?? titleCase(key);
  const unit = units[key] ?? '';
  const shown = key === 'weightG' ? (Number(value) / 1000).toFixed(2) + ' kg' : `${value}${unit}`;
  return `${label}: ${shown}`;
};

export const specChips = (attributes = {}, categorySlug, limit = 5) => {
  const preferred = SPEC_KEYS[categorySlug] ?? Object.keys(attributes ?? {});
  const seen = new Set();
  const chips = [];
  for (const key of [...preferred, ...Object.keys(attributes ?? {})]) {
    if (seen.has(key)) continue;
    seen.add(key);
    const text = formatAttr(key, attributes?.[key]);
    if (!text) continue;
    chips.push(el('span', { class: 'spec', text }));
    if (chips.length >= limit) break;
  }
  return el('div', { class: 'specs' }, chips);
};

/** product_cards component (≤ 5 cards, never a price the tool did not return). */
export function productCards(component, { categorySlug, onAdd, onDetails, onCompare } = {}) {
  const { cards = [], relaxed = [], assumptions = [], revision = 0 } = component.payload;
  const wrap = el('div', { class: 'cards' });
  const supersededEverywhere = revision < state.lastRevision;
  cards.forEach((card, index) => {
    const superseded = supersededEverywhere || revision < state.lastRevision;
    const node = el('article', {
      class: `card${index === 0 ? ' card--best' : ''}${superseded ? ' card--superseded' : ''}`,
      dataset: { productId: card.productId }
    });
    node.append(productArt(card, { height: 140 }));
    const tags = el('div', { class: 'card__tags' }, [
      index === 0 ? el('span', { class: 'tag tag--brand', text: 'Best fit' }) : null,
      superseded ? el('span', { class: 'tag', text: 'Superseded' }) : null,
      card.slightlyOverBudget ? el('span', { class: 'tag tag--warning', text: 'Slightly over' }) : null,
      card.stock?.state === 'in_stock' ? el('span', { class: 'tag tag--success', text: `${card.stock.available} in stock` }) : null,
      card.stock?.state === 'low_stock' ? el('span', { class: 'tag tag--warning', text: `Only ${card.stock.available} left` }) : null,
      card.stock?.state === 'out_of_stock' ? el('span', { class: 'tag tag--danger', text: 'Out of stock' }) : null
    ]);
    node.querySelector('.card__media').append(tags);

    node.append(
      el('div', { class: 'card__body' }, [
        el('span', { class: 'card__merchant', text: card.merchant?.name ?? card.brand ?? '' }),
        el('h3', { class: 'card__title', text: card.title }),
        el('div', {}, [
          el('span', { class: 'price', text: card.price?.display ?? money(card.price?.amountMinor) }),
          card.slightlyOverBudget ? el('span', { class: 'price--was', text: '' }) : null
        ]),
        card.whyItFits ? el('p', { class: 'card__why', text: card.whyItFits }) : null,
        specChips(card.attrs, categorySlug ?? state.chat?.requirement?.categorySlug),
        el('div', { class: 'card__actions' }, [
          el('button', { class: 'btn btn--primary btn--sm', type: 'button', text: 'Add to cart', onclick: () => onAdd?.(card.productId, 1, card.title) }),
          el('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: 'Details', onclick: () => onDetails?.(card.productId) }),
          card.actions?.includes('compare') ? el('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: '⇄', title: 'Compare', onclick: () => onCompare?.([card.productId]) }) : null
        ])
      ])
    );
    wrap.append(node);
  });

  const notes = [];
  if (relaxed?.length) notes.push(el('p', { class: 'card__why', text: `Relaxed to find these: ${relaxed.join('; ')}` }));
  if (assumptions?.length) notes.push(el('p', { class: 'card__why' }, [el('em', { text: `Assumptions: ${assumptions.join(' · ')}` })]));
  if (notes.length) wrap.append(el('div', { class: 'notice' }, notes));
  return wrap;
}

/** comparison component — union of attribute rows with the winner marked per row. */
export function comparison(component) {
  const { products = [], rows = [], summary, winnerProductId, caveats = [] } = component.payload;
  const wrap = el('div', { class: 'stack' });
  const head = el('tr', {}, [el('th', { text: 'Attribute' }), ...products.map((p) => el('th', {}, [el('span', { text: p.title }), el('div', { class: 'card__why', text: p.price?.display ?? money(p.price?.amountMinor) })]))]);
  const body = rows.map((row) =>
    el('tr', {}, [
      el('th', { text: row.label ?? titleCase(row.key) }),
      ...row.values.map((value) => {
        const isWin = value.better;
        return el('td', { class: isWin ? 'win' : '' }, [`${value.display ?? value.value ?? '—'}${isWin ? ' ✓' : ''}`]);
      })
    ])
  );
  wrap.append(el('div', { class: 'table-wrap' }, [el('table', {}, [el('thead', {}, [head]), el('tbody', {}, body)])]));
  if (summary) wrap.append(el('p', { class: 'card__why', text: summary }));
  if (winnerProductId) {
    const winner = products.find((p) => p.productId === winnerProductId);
    if (winner) wrap.append(el('p', { class: 'notice notice--success', text: `${winner.title} wins the most rows (${winner.wins} of ${rows.length}) — but the "best" depends on what you value most.` }));
  }
  if (caveats?.length) wrap.append(el('p', { class: 'card__why', text: `Caveats: ${caveats.join(' · ')}` }));
  return wrap;
}

/** cart_summary component (also used by agent turns). */
export function cartSummary(component, { onQuantity, onRemove } = {}) {
  const cart = component.payload;
  const wrap = el('div', { class: 'stack' });
  if (!cart.items?.length) {
    wrap.append(el('p', { class: 'card__why', text: 'Your cart is empty. Ask the agent for options or add a product from the catalogue.' }));
    return wrap;
  }
  for (const item of cart.items) {
    const line = el('div', { class: 'cart-line' }, [
      el('div', {}, [
        el('strong', { text: item.title }),
        el('div', { class: 'cart-line__meta', text: `${item.display} each${item.unavailable ? ' · unavailable' : ''}` })
      ]),
      item.unavailable
        ? el('button', { class: 'btn btn--danger btn--sm', type: 'button', text: 'Remove', onclick: () => onRemove?.(item.productId) })
        : el('div', { class: 'qty' }, [
            el('button', { type: 'button', text: '−', 'aria-label': `Decrease ${item.title}`, onclick: () => onQuantity?.(item.productId, Math.max(1, item.quantity - 1)) }),
            el('span', { text: String(item.quantity) }),
            el('button', { type: 'button', text: '+', 'aria-label': `Increase ${item.title}`, onclick: () => onQuantity?.(item.productId, Math.min(10, item.quantity + 1)) }),
            el('button', { type: 'button', text: '🗑', 'aria-label': `Remove ${item.title}`, onclick: () => onRemove?.(item.productId) })
          ])
    ]);
    wrap.append(line);
  }
  if (cart.warnings?.length) {
    wrap.append(el('div', { class: 'notice notice--warning' }, cart.warnings.map((w) => el('p', { text: w.message }))));
  }
  return wrap;
}

/** checkout_card component: the explicit approval surface — no payment exists yet. */
export function checkoutCard(component, { onApprove } = {}) {
  const payload = component.payload;
  return el('div', { class: 'stack' }, [
    el('div', { class: 'notice' }, [
      el('strong', { text: `Order ${payload.orderNumber} is ready for your approval.` }),
      el('p', { text: 'Nothing has been charged. Review the amounts and press Approve & Pay to open PayPal.' })
    ]),
    totalsBlock(payload.amounts),
    payload.lines?.length ? el('ul', { class: 'card__why' }, payload.lines.map((l) => el('li', { text: `${l.quantity} × ${l.title} — ${money(l.lineTotalMinor)}` }))) : null,
    el('button', { class: 'btn btn--primary', type: 'button', text: 'Approve & Pay', onclick: () => onApprove?.(payload.orderId) })
  ]);
}

export function totalsBlock(amounts) {
  const d = amounts?.display ?? {};
  return el('div', { class: 'totals' }, [
    el('div', { class: 'totals__row' }, [el('span', { text: 'Subtotal' }), el('span', { text: d.subtotal ?? money(amounts?.subtotalMinor) })]),
    el('div', { class: 'totals__row' }, [el('span', { text: `Shipping${amounts?.shippingMinor === 0 ? ' (free)' : ''}` }), el('span', { text: d.shipping ?? money(amounts?.shippingMinor) })]),
    el('div', { class: 'totals__row' }, [el('span', { text: `Tax (${((amounts?.taxRateBps ?? 825) / 100).toFixed(2)}%)` }), el('span', { text: d.tax ?? money(amounts?.taxMinor) })]),
    el('div', { class: 'totals__row totals__row--grand' }, [el('span', { text: 'Total' }), el('span', { text: d.total ?? money(amounts?.totalMinor) })])
  ]);
}

/** order_status component. */
export function orderStatus(component, { onRetry, onOpen } = {}) {
  const p = component.payload;
  return el('div', { class: 'stack' }, [
    el('div', { class: 'notice' }, [
      el('strong', {}, [statusDot(p.status), ` Order ${p.orderNumber} · ${titleCase(p.status)}`]),
      el('p', { text: `Total ${p.display ?? money(p.totalMinor)} · payment ${titleCase(p.paymentStatus ?? 'none')} · attempts ${p.attemptNo}` })
    ]),
    el('div', { class: 'card__actions' }, [
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: 'Open order', onclick: () => onOpen?.(p.orderId) }),
      p.requiresApproval ? el('button', { class: 'btn btn--primary btn--sm', type: 'button', text: 'Retry payment', onclick: () => onRetry?.(p.orderId) }) : null
    ])
  ]);
}

export function clarification(component, { onOption } = {}) {
  const p = component.payload;
  return el('div', { class: 'chips' }, (p.options ?? []).map((option) => el('button', { class: 'chip', type: 'button', text: option, onclick: () => onOption?.(option) })));
}

export const requirementChips = (chips = []) =>
  el(
    'div',
    { class: 'chips' },
    chips.map((chip) => el('span', { class: `chip chip--static${chip.kind === 'assumption' ? ' chip--assumption' : ''}`, title: chip.kind, text: chip.label }))
  );

export const productTile = (product, { onAdd, onDetails } = {}) => {
  const node = el('article', { class: 'card' });
  node.append(productArt(product, { height: 110 }));
  node.append(
    el('div', { class: 'card__body' }, [
      el('span', { class: 'card__merchant', text: product.merchant?.name ?? '' }),
      el('h3', { class: 'card__title', text: product.title }),
      el('div', { class: 'price', text: product.price?.display ?? money(product.price?.amountMinor) }),
      specChips(product.attributes, product.categorySlug, 3),
      el('div', { class: 'card__actions' }, [
        el('button', { class: 'btn btn--primary btn--sm', type: 'button', text: 'Add', onclick: () => onAdd?.(product.id ?? product.productId) }),
        el('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: 'Open', onclick: () => onDetails?.(product.slug ?? product.id) })
      ])
    ])
  );
  return node;
};

export const orderRow = (order, { onOpen } = {}) =>
  el('div', { class: 'cart-line' }, [
    el('div', {}, [
      el('strong', {}, [statusDot(order.status), ` ${order.orderNumber}`]),
      el('div', { class: 'cart-line__meta', text: `${order.lines?.map((l) => `${l.quantity}× ${l.title}`).join(', ')}` })
    ]),
    el('div', { style: 'text-align:right' }, [
      el('div', { class: 'price', text: order.amounts?.display?.total ?? money(order.amounts?.totalMinor) }),
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: 'Details', onclick: () => onOpen?.(order.id) })
    ])
  ]);

export const kpi = (label, value, hint) =>
  el('div', { class: 'kpi' }, [el('div', { class: 'kpi__label', text: label }), el('div', { class: 'kpi__value', text: value }), hint ? el('div', { class: 'card__why', text: hint }) : null]);

export const funnelBlock = (funnel) => {
  const stages = [
    ['Product views', funnel.views],
    ['Cart adds', funnel.cartAdds],
    ['Checkout attempts', funnel.checkoutAttempts],
    ['Completed purchases', funnel.purchases]
  ];
  const max = Math.max(1, ...stages.map(([, value]) => value));
  return el(
    'div',
    { class: 'funnel' },
    stages.map(([label, value]) =>
      el('div', { class: 'funnel__row' }, [
        el('span', { text: label }),
        el('div', { class: 'funnel__track' }, [el('div', { class: 'funnel__bar', style: `width:${Math.round((value / max) * 100)}%` })]),
        el('span', { style: 'text-align:right;font-variant-numeric:tabular-nums', text: String(value) })
      ])
    )
  );
};

export const sparkline = (series = [], key = 'purchases') => {
  const max = Math.max(1, ...series.map((point) => point[key] ?? 0));
  return el(
    'div',
    { class: 'spark', title: `${series.length} days` },
    series.map((point) => el('div', { class: 'spark__bar', style: `height:${Math.max(2, Math.round(((point[key] ?? 0) / max) * 64))}px`, title: `${point.date}: ${point[key] ?? 0}` }))
  );
};

export const emptyState = (text) => el('div', { class: 'notice' }, [el('p', { text })]);
export const moneyText = (minor) => moneyFull(minor);
