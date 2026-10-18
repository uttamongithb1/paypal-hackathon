/**
 * Catalogue view — the browsable storefront.
 *
 * The chat pane is the product; this page exists because people still want to *look* before they
 * talk, and because a shopper who arrives from a link deserves to see what the agent is choosing
 * from. It is deliberately the same card component the agent renders in conversation, fed from the
 * same `/products` endpoint, so the price, stock and photography cannot drift between the two.
 */
import { fetchProducts, state, track, event } from './api.js';
import { $, h, skeleton } from './ui.js';
import { productCard } from './cards.js';
import { openAssistant } from './assistant.js';
import { send } from './chat.js';
import { openProduct } from './chat.js';

/** Catalogue DTO -> the component payload shape productCard expects. One mapping, one source. */
const asCard = (product) => ({
  productId: product.id,
  slug: product.slug,
  title: product.title,
  brand: product.brand,
  merchant: product.merchant,
  price: product.price,
  stock: { available: product.stock, state: product.availability },
  rating: product.rating,
  attrs: product.attributes,
  description: product.shortDescription,
  imageUrl: product.images?.[0]?.url ?? null,
  imageAlt: product.images?.[0]?.alt ?? null
});

let filters = { category: '', q: '' };

export async function renderCatalogue() {
  const root = $('#catalogue-root');
  if (!root) return;
  root.replaceChildren(skeleton(6));

  const grid = h('div', { class: 'card-grid card-grid--catalogue' });
  const count = h('span', { class: 'catalogue__count', text: '' });

  const search = h('input', {
    type: 'search',
    placeholder: 'Search the catalogue…',
    'aria-label': 'Search the catalogue',
    value: filters.q,
    oninput: (inputEvent) => {
      filters.q = inputEvent.currentTarget.value;
      // Typing is lazy: one refetch per pause, not per keystroke.
      clearTimeout(search._timer);
      search._timer = setTimeout(load, 250);
    }
  });

  const category = h('select', {
    'aria-label': 'Filter by category',
    onchange: (changeEvent) => {
      filters.category = changeEvent.currentTarget.value;
      load();
    }
  }, [
    h('option', { value: '', text: 'All categories' }),
    ...(state.categories ?? []).map((entry) => h('option', { value: entry.slug, text: entry.name ?? entry.slug }))
  ]);
  category.value = filters.category;

  const header = h('div', { class: 'catalogue__head' }, [
    h('div', {}, [
      h('h2', { class: 'catalogue__title', text: 'Find your next everyday essential.' }),
      h('p', { class: 'catalogue__sub', text: 'Browse our demo catalogue. Compare your options. Check out as a guest.' })
    ]),
    h('div', { class: 'catalogue__filters' }, [category, search])
  ]);

  async function load() {
    grid.replaceChildren(...Array.from({ length: 6 }, () => h('div', { class: 'card card--skeleton', html: '' })));
    try {
      const result = await fetchProducts({ category: filters.category || undefined, q: filters.q || undefined, limit: 60 });
      const items = result.items ?? [];
      count.textContent = `${items.length} product${items.length === 1 ? '' : 's'}`;
      if (!items.length) {
        grid.replaceChildren(h('div', { class: 'empty' }, [
          h('strong', { text: 'Nothing matches that yet.' }),
          h('p', { class: 'note', text: 'Try a different category, or ask the agent in the chat — it can search by what you need rather than what you type.' })
        ]));
        return;
      }
      grid.replaceChildren(...items.map((product) => productCard(asCard(product), {
        onDetails: (id) => openProduct(id),
        onAsk: () => send(`Tell me about ${product.title}. What are its strengths and trade-offs?`, { attachedProductIds: [product.id] })
      })));
    } catch (error) {
      grid.replaceChildren(h('div', { class: 'callout callout--danger', text: `Could not load the catalogue: ${error.message}` }));
    }
  }

  root.replaceChildren(h('div', { class: 'catalogue' }, [
    h('section', { class: 'store-hero' }, [
      h('span', { class: 'store-hero__eyebrow', text: 'A little guidance. A better choice.' }),
      h('h1', { text: 'Good finds.\nYour final say.' }),
      h('p', { text: 'Shop laptops, audio and everyday tech. Need a second opinion? Your AI shopping companion is one click away.' }),
      h('div', { class: 'row' }, [
        h('button', { class: 'btn btn--primary', text: '✦ Find it with ShopPilot', onclick: () => openAssistant() }),
        h('a', { class: 'btn btn--secondary', href: '#products', text: 'Explore products' })
      ]),
      h('p', { class: 'note', text: 'No sign-up required · You approve every payment · Sandbox demo, no real money' }),
      h('div', { class: 'store-hero__art', 'aria-hidden': 'true' }, [h('img', { src: '/products/ascent-book-14.webp', alt: '' }), h('span', { text: 'Less searching. More finding.' })])
    ]),
    h('div', { id: 'products' }, [header]),
    h('div', { class: 'catalogue__meta' }, [count]),
    grid
  ]));
  await load();
  track([event('view_loaded', { surface: 'catalogue' })]);
}
