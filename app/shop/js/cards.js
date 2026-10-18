/**
 * Renderers for the agent's UI components and the catalogue cards.
 * Every renderer takes the component payload exactly as the server shaped it (docs/api_spec.md §7).
 */
import { addToCart, money, state } from './api.js';
import { h, renderProductArt, specChips, stockBadge, priceText, toast, humanStatus, statusTone } from './ui.js';

const addButton = (productId, quantity = 1, label = 'Add to cart', { tone = 'primary' } = {}) =>
  h('button', {
    class: `btn btn--${tone} btn--sm`,
    type: 'button',
    text: label,
    onclick: async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = 'Adding…';
      try {
        const cart = await addToCart(productId, quantity);
        toast(`Added to cart · ${cart.itemCount} item${cart.itemCount === 1 ? '' : 's'}`, { tone: 'success' });
        button.textContent = 'Added ✓';
        setTimeout(() => {
          button.disabled = false;
          button.textContent = label;
        }, 1200);
      } catch (error) {
        toast(error.code === 'INSUFFICIENT_STOCK' ? error.message : `Could not add: ${error.message}`, { tone: 'danger' });
        button.disabled = false;
        button.textContent = label;
      }
    }
  });

export function productCard(card, { revision, superseded = false, onDetails, onCompare, onAsk } = {}) {
  const stock = card.stock?.state === 'in_stock' ? 'in_stock' : card.stock?.state;
  const rating = card.rating?.avg ?? (typeof card.rating === 'number' ? card.rating : null);
  const ratingCount = card.rating?.count ?? null;
  const compareAt = card.price?.compareAtDisplay ?? null;
  const savingPct =
    card.price?.compareAtMinor && card.price?.amountMinor && card.price.compareAtMinor > card.price.amountMinor
      ? Math.round((1 - card.price.amountMinor / card.price.compareAtMinor) * 100)
      : null;

  return h('article', { class: `card${superseded ? ' card--superseded' : ''}`, dataset: { productId: card.productId, revision: String(revision ?? 0) } }, [
    renderProductArt({ ...card, slug: card.slug ?? card.productId }),
    h('div', { class: 'card__body' }, [
      h('div', { class: 'card__head' }, [
        h('div', {}, [
          h('div', { class: 'card__title', text: card.title }),
          h('div', {
            class: 'card__merchant',
            text: [...new Set([card.brand, card.merchant?.name].filter(Boolean))].join(' · ')
          })
        ]),
        h('span', { class: `badge badge--${statusTone(stock)}`, text: card.stock?.state === 'in_stock' ? `${card.stock.available} in stock` : humanStatus(stock ?? 'unknown') })
      ]),
      rating
        ? h('div', { class: 'card__rating' }, [
            h('span', { class: 'stars', text: '★★★★★' }),
            h('span', { class: 'card__rating-value', text: rating.toFixed(1) }),
            ratingCount ? h('span', { class: 'card__rating-count', text: `(${ratingCount})` }) : null
          ])
        : null,
      h('div', { class: 'card__price-row' }, [
        h('div', { class: 'card__price', text: priceText(card.price) }),
        compareAt ? h('div', { class: 'card__compare', text: compareAt }) : null,
        savingPct ? h('span', { class: 'card__saving', text: `−${savingPct}%` }) : null
      ]),
      card.whyItFits
        ? h('p', { class: 'card__why', text: card.whyItFits })
        : card.description
          ? h('p', { class: 'card__desc', text: card.description })
          : null,
      specChips(card.attrs, 4),
      card.slightlyOverBudget ? h('div', { class: 'callout callout--warning', text: 'This one is slightly over the budget you set — say the word if you want it anyway.' }) : null,
      h('div', { class: 'card__foot' }, [
        addButton(card.productId, 1, 'Add to cart'),
        h('button', {
          class: `btn btn--secondary btn--sm${onCompare ? '' : ' card__foot-wide'}`,
          type: 'button',
          text: 'Details',
          onclick: () => onDetails?.(card.productId)
        }),
        onAsk ? h('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: '✦ Ask AI', onclick: onAsk }) : null,
        // Compare only exists inside a conversation, where the agent holds the shortlist. On the
        // catalogue page there is no shortlist yet, so the button is omitted rather than inert.
        onCompare ? h('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: 'Compare', onclick: () => onCompare(card.productId) }) : null
      ])
    ])
  ]);
}

export function productCards(component, handlers = {}) {
  const { cards = [], revision = 0, relaxed = [], assumptions = [] } = component.payload;
  const currentRevision = state.chat?.requirementRevision ?? revision;
  const superseded = revision < currentRevision;
  const wrapper = h('div', { class: 'stack' }, [
    h('div', { class: 'card-grid' }, cards.map((card) => productCard(card, { revision, superseded, ...handlers }))),
    relaxed?.length ? h('div', { class: 'callout callout--warning', text: `Relaxed to find matches: ${relaxed.join('; ')}` }) : null,
    assumptions?.length ? h('div', { class: 'note', text: `Assumptions: ${assumptions.join(' · ')}` }) : null
  ]);
  return wrapper;
}

export function comparison(component, handlers = {}) {
  const { products = [], rows = [], summary, winnerProductId, caveats = [] } = component.payload;
  const table = h('table', {}, [
    h('thead', {}, [
      h('tr', {}, [
        h('th', { text: 'Attribute' }),
        ...products.map((product) =>
          h('th', {}, [
            h('div', { text: product.title }),
            h('div', { class: 'card__merchant', text: priceText(product.price) }),
            product.productId === winnerProductId ? h('span', { class: 'badge badge--brand', text: 'Best overall' }) : null
          ])
        )
      ])
    ]),
    h('tbody', {}, [
      ...rows.map((row) =>
        h('tr', {}, [
          h('th', { text: row.label }),
          ...row.values.map((value) =>
            h('td', { class: value.better ? 'win' : '' }, [
              h('span', { text: value.display ?? String(value.value ?? '—') }),
              value.better ? h('span', { class: 'badge badge--success', text: ' best' }) : null
            ])
          )
        ])
      ),
      h('tr', {}, [
        h('th', { text: 'Add' }),
        ...products.map((product) => h('td', {}, [addButton(product.productId, 1, 'Add', { tone: 'secondary' })]))
      ])
    ])
  ]);

  return h('div', { class: 'stack' }, [
    h('div', { class: 'table-wrap' }, [table]),
    summary ? h('p', { class: 'note', text: summary }) : null,
    caveats?.length ? h('div', { class: 'callout', text: `Caveats: ${caveats.join(' · ')}` }) : null
  ]);
}

export function cartSummary(component, { compact = false } = {}) {
  const { items = [], display } = component.payload;
  if (compact) {
    return h('div', { class: 'stack' }, items.map((item) =>
      h('div', { class: 'row row--between' }, [
        h('span', { text: `${item.quantity} × ${item.title}` }),
        h('span', { class: 'mono', text: money(item.lineTotalMinor) })
      ])
    ));
  }
  return h('div', { class: 'stack' }, [
    h('div', { class: 'table-wrap' }, [
      h('table', {}, [
        h('thead', {}, [h('tr', {}, [h('th', { text: 'Item' }), h('th', { class: 'num', text: 'Qty' }), h('th', { class: 'num', text: 'Line total' })])]),
        h('tbody', {}, items.map((item) =>
          h('tr', {}, [
            h('td', { text: item.title }),
            h('td', { class: 'num', text: String(item.quantity) }),
            h('td', { class: 'num', text: item.display ?? money(item.lineTotalMinor) })
          ])
        ))
      ])
    ]),
    h('div', { class: 'note', text: `Subtotal ${display ?? ''} — shipping and tax are calculated at checkout.` })
  ]);
}

export function checkoutCard(component, { onApprove } = {}) {
  const payload = component.payload;
  return h('div', { class: 'stack' }, [
    h('div', { class: 'callout callout--agent' }, [
      h('strong', { text: `Order ${payload.orderNumber} ready for your approval` }),
      h('p', { class: 'note', text: 'Nothing has been charged. Press Approve & Pay to finish checkout; PayPal captures the money, our backend verifies it, and only then is the order marked paid.' })
    ]),
    amountBreakdown(payload.amounts),
    h('button', { class: 'btn btn--primary btn--block', type: 'button', text: 'Approve & Pay →', onclick: () => onApprove?.(payload.orderId) }),
    payload.warnings?.length ? h('div', { class: 'note', text: payload.warnings.map((w) => w.message).join(' ') }) : null
  ]);
}

export function orderStatusCard(component, { onRetry, onOpen } = {}) {
  const payload = component.payload;
  return h('div', { class: 'callout' }, [
    h('div', { class: 'row row--between' }, [
      h('strong', { text: `Order ${payload.orderNumber}` }),
      h('span', { class: `badge badge--${statusTone(payload.status)}`, text: humanStatus(payload.status) })
    ]),
    h('p', { class: 'note', text: `Payment: ${humanStatus(payload.paymentStatus ?? 'none')} · attempts ${payload.attemptNo} · total ${payload.display ?? money(payload.totalMinor)}` }),
    h('div', { class: 'row' }, [
      h('button', { class: 'btn btn--secondary btn--sm', type: 'button', text: 'Open order', onclick: () => onOpen?.(payload.orderId) }),
      payload.requiresApproval ? h('button', { class: 'btn btn--primary btn--sm', type: 'button', text: 'Retry payment', onclick: () => onRetry?.(payload.orderId) }) : null
    ])
  ]);
}

export function clarification(component, { onAnswer } = {}) {
  return h('div', { class: 'row' }, (component.payload.options ?? []).map((option) =>
    h('button', { class: 'quick-reply', type: 'button', text: option, onclick: () => onAnswer?.(option) })
  ));
}

export function amountBreakdown(amounts) {
  const display = amounts?.display ?? {};
  const rows = [
    ['Subtotal', display.subtotal ?? money(amounts?.subtotalMinor)],
    ['Shipping', display.shipping ?? money(amounts?.shippingMinor)],
    [`Tax (${((amounts?.taxRateBps ?? 825) / 100).toFixed(2)}%)`, display.tax ?? money(amounts?.taxMinor)]
  ];
  return h('div', { class: 'totals' }, [
    ...rows.map(([label, value]) => h('div', { class: 'totals__row' }, [h('span', { class: 'muted', text: label }), h('span', { text: value })])),
    h('div', { class: 'totals__row totals__row--grand' }, [h('span', { text: 'Total' }), h('span', { text: display.total ?? money(amounts?.totalMinor) })])
  ]);
}

export function railItem(product, { onDetails } = {}) {
  const available = product.stock?.available ?? product.stock;
  return h('div', { class: 'rail-item' }, [
    renderProductArt({ ...product, slug: product.slug ?? product.id }, { size: 'rail' }),
    h('div', { class: 'rail-item__body' }, [
      h('div', { class: 'rail-item__title', text: product.title }),
      h('div', { class: 'rail-item__meta', text: `${priceText(product.price)} · ${product.merchant?.name ?? ''}` }),
      h('div', { class: 'row' }, [stockBadge({ ...product, stock: { available, state: product.availability } })]),
      h('div', { class: 'row' }, [
        addButton(product.id, 1, 'Add', { tone: 'secondary' }),
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: 'Open', onclick: () => onDetails?.(product.slug ?? product.id) })
      ])
    ])
  ]);
}
