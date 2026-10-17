/**
 * The conversation pane: sends messages, renders SSE frames (tool activity, ui components, deltas),
 * keeps the requirement chips + quick replies in sync, and owns the product detail modal.
 */
import { fetchPriceHistory, fetchProduct, state, streamChat, track, event, retryPayment } from './api.js';
import { $, h, openModal, renderProductArt, specChips, toast, humanStatus, statusTone, escapeHtml, closeModal } from './ui.js';
import { checkoutCard, clarification, comparison, orderStatusCard, productCards } from './cards.js';

const log = () => $('#chat-log');

const messages = new Map(); // messageId → { body, bubble }

function scroller() {
  const node = log();
  node.scrollTop = node.scrollHeight;
}

function addMessage(role, { messageId } = {}) {
  const isUser = role === 'user';
  const bubble = h('div', { class: 'bubble' });
  const body = h('div', { class: 'msg__body' }, [bubble]);
  const node = h('li', { class: `msg msg--${isUser ? 'user' : 'agent'}`, dataset: { messageId: messageId ?? '' } }, [
    h('div', { class: 'msg__avatar', 'aria-hidden': 'true', text: isUser ? 'You' : 'SP' }),
    body
  ]);
  log().append(node);
  scroller();
  if (messageId) messages.set(messageId, { node, body, bubble });
  return { node, body, bubble };
}

const requirementChipRow = (chips = []) =>
  h(
    'div',
    { class: 'row' },
    chips.map((chip) =>
      h('span', {
        class: `pill${chip.kind === 'assumption' ? ' pill--muted' : ''}`,
        title: chip.kind,
        text: chip.label
      })
    )
  );

function toolRow(body, { id, tool, label, status, durationMs, resultSummary }) {
  let trail = body.querySelector('.tool-trail');
  if (!trail) {
    trail = h('div', { class: 'tool-trail' });
    body.append(trail);
  }
  let row = trail.querySelector(`[data-tool-id="${id}"]`);
  const text = label ?? tool;
  if (!row) {
    row = h('div', {
      class: `tool-row tool-row--${status}`,
      dataset: { toolId: id },
      // 'refused' is a first-class outcome: the agent asked for a capability it does not have.
      title: status === 'refused' ? 'Blocked by the tool registry — this capability does not exist for the agent.' : undefined
    }, [h('span', { class: 'tool-row__dot' }), h('span', { class: 'tool-row__text' })]);
    trail.append(row);
  }
  row.className = `tool-row tool-row--${status}`;
  const count = resultSummary?.count ?? resultSummary?.products ?? resultSummary?.itemCount;
  row.querySelector('.tool-row__text').textContent = `${text}${status === 'running' ? '…' : ''}${status === 'done' && durationMs ? ` · ${durationMs} ms` : ''}${count !== undefined && status === 'done' ? ` · ${count} result${count === 1 ? '' : 's'}` : ''}${status === 'error' ? ' · failed' : ''}${status === 'refused' ? ' · blocked' : ''}`;
  scroller();
}

function thinking(body) {
  const node = h('div', { class: 'thinking' }, [h('i', {}), h('i', {}), h('i', {}), h('span', { text: 'thinking' })]);
  body.append(node);
  return () => node.remove();
}

function renderComponent(component, body) {
  const host = h('div', { class: 'stack' });
  switch (component.type) {
    case 'product_cards':
      host.append(
        productCards(component, {
          onDetails: (productId) => openProduct(productId),
          onCompare: (productId) => send(`compare ${productId} with the others`)
        })
      );
      break;
    case 'comparison':
      host.append(comparison(component));
      break;
    case 'cart_summary':
      host.append(
        h('div', { class: 'callout' }, [
          h('strong', { text: `Cart · ${component.payload.itemCount} item(s) · ${component.payload.display}` }),
          h('button', { class: 'btn btn--secondary btn--sm', type: 'button', text: 'Open cart', onclick: () => document.getElementById('cart-button')?.click() })
        ])
      );
      break;
    case 'checkout_card':
      host.append(
        checkoutCard(component, {
          onApprove: (orderId) => {
            document.getElementById('cart-button')?.blur();
            location.assign(`/checkout/${orderId}`);
          }
        })
      );
      break;
    case 'order_status':
      host.append(
        orderStatusCard(component, {
          onRetry: async (orderId) => {
            try {
              const result = await retryPayment(orderId);
              toast(`New payment attempt #${result.payment?.attemptNo} — approve it in checkout`, { tone: 'success' });
              location.assign(`/checkout/${orderId}`);
            } catch (error) {
              toast(error.message, { tone: 'danger' });
            }
          },
          onOpen: (orderId) => location.assign(`/orders/${orderId}`)
        })
      );
      break;
    case 'clarification':
      host.append(clarification(component, { onAnswer: (answer) => send(answer) }));
      break;
    default:
      host.append(h('div', { class: 'note', text: `Component “${component.type}” is not rendered by this client.` }));
  }
  body.append(host);
  scroller();
}

function setQuickReplies(replies = []) {
  const host = $('#quick-replies');
  host.innerHTML = '';
  for (const reply of replies.slice(0, 4)) {
    host.append(h('button', { class: 'quick-reply', type: 'button', text: reply, onclick: () => send(reply) }));
  }
}

function setComposerBusy(busy, label) {
  const input = $('#chat-input');
  const button = $('#chat-send');
  input.disabled = busy;
  button.disabled = busy;
  button.textContent = busy ? label ?? 'Working…' : 'Send';
}

export async function send(rawMessage) {
  const message = String(rawMessage ?? '').trim();
  if (!message) return;
  const input = $('#chat-input');
  input.value = '';
  setComposerBusy(true, 'Working…');
  setQuickReplies([]);
  addMessage('user').bubble.textContent = message;

  const agent = addMessage('agent');
  const stopThinking = thinking(agent.body);
  let streamed = '';
  const toolCalls = [];
  track([event('chat_message_sent', { turnIndex: state.chat?.messageCount ?? 0, textLength: message.length, entryPoint: 'chat' })]);

  try {
    const end = await streamChat(message, {
      onFrame: async (frame) => {
        if (frame.event === 'message.start') stopThinking();
        if (frame.event === 'tool.activity') {
          toolRow(agent.body, frame.data);
          if (frame.data.status !== 'running') toolCalls.push(frame.data.tool);
        }
        if (frame.event === 'message.delta') {
          streamed += frame.data.text;
          agent.bubble.textContent = streamed;
          scroller();
        }
        if (frame.event === 'ui.component') renderComponent(frame.data.component, agent.body);
        if (frame.event === 'cart.updated') {
          // cart.updated carries the cart only; merge it so the badge updates mid-stream.
          state.cart = frame.data.cart;
          document.dispatchEvent(new CustomEvent('sp:cart', { detail: frame.data.cart }));
        }
        if (frame.event === 'message.end') {
          if (!streamed && frame.data.text) agent.bubble.textContent = frame.data.text;
          setQuickReplies(frame.data.quickReplies ?? []);
          if (frame.data.requirementChips?.length) {
            agent.body.append(requirementChipRow(frame.data.requirementChips));
          } else if (state.chat?.requirementChips?.length) {
            agent.body.append(requirementChipRow(state.chat.requirementChips));
          }
          const meta = [];
          if (frame.data.requirementRevision) meta.push(`requirement rev ${frame.data.requirementRevision}`);
          if (toolCalls.length) meta.push(`${toolCalls.length} tool call${toolCalls.length === 1 ? '' : 's'}`);
          if (frame.data.usage?.profile) meta.push(`planner: ${frame.data.usage.profile}`);
          if (frame.data.assumptions?.length) meta.push(`assumptions: ${frame.data.assumptions.join(' · ')}`);
          if (meta.length) agent.body.append(h('div', { class: 'msg__meta' }, meta.map((text) => h('span', { text }))));
          scroller();
        }
      }
    });
    if (end?.quickReplies) setQuickReplies(end.quickReplies);
  } catch (error) {
    stopThinking();
    agent.bubble.textContent = error.code === 'RATE_LIMITED' ? error.message : `I could not answer that just now (${error.code}). ${error.message}`;
    toast(error.message, { tone: 'danger' });
  } finally {
    stopThinking();
    setComposerBusy(false);
    input.focus();
  }
}

/* ── Product detail modal (with real price history from the catalogue) ───────────────────────── */
export async function openProduct(slugOrId) {
  const modal = openModal({ title: 'Product', body: h('div', { class: 'stack' }, [h('div', { class: 'skeleton' })]) });
  try {
    const { product } = await fetchProduct(slugOrId);
    // Price history is a merchant/admin endpoint. A shopper viewing a product should not ask for it
    // and get a 403 in the console; only fetch it for the roles that are allowed to see it.
    const canSeeHistory = ['merchant', 'admin'].includes(state.user?.role);
    const history = canSeeHistory ? await fetchPriceHistory(product.id).catch(() => ({ items: [] })) : { items: [] };
    modal.querySelector('.modal__head h2').textContent = product.title;
    modal.querySelector('.modal__body').replaceChildren(
      h('div', { class: 'checkout-grid' }, [
        h('div', { class: 'stack' }, [
          renderProductArt(product, { size: 'detail' }),
          h('p', { text: product.description ?? '' }),
          specChips(product.attributes, 12),
          product.pros?.length ? h('div', {}, [h('h3', { text: 'Pros' }), h('ul', {}, product.pros.map((pro) => h('li', { text: pro })))]) : null,
          product.cons?.length ? h('div', {}, [h('h3', { text: 'Cons' }), h('ul', {}, product.cons.map((con) => h('li', { text: con })))]) : null
        ]),
        h('div', { class: 'stack' }, [
          h('div', { class: 'card__price', text: product.price?.display }),
          h('div', { class: 'row' }, [h('span', { class: `badge badge--${statusTone(product.availability)}`, text: humanStatus(product.availability) })]),
          h('div', { class: 'note', text: `${product.merchant?.name ?? ''} · ${product.warrantyMonths ?? '—'} month warranty · ${product.returnDays ?? '—'} day returns · ★ ${product.rating?.avg ?? '—'} (${product.rating?.count ?? 0})` }),
          h('div', { class: 'divider' }),
          h('h3', { text: 'Price history' }),
          history.items?.length
            ? h('ul', { class: 'note' }, history.items.slice(0, 5).map((entry) => h('li', { text: `${new Date(entry.at).toLocaleDateString()} · ${entry.display ?? `$${(entry.priceMinor / 100).toFixed(2)}`} · ${entry.reason ?? 'update'}` })))
            : h('p', { class: 'note', text: 'No price change recorded for this product.' }),
          h('div', { class: 'divider' }),
          h('button', {
            class: 'btn btn--primary btn--block',
            type: 'button',
            text: 'Ask the agent about this',
            onclick: async () => {
              closeModal();
              await send(`is the ${product.title} right for me?`);
            }
          })
        ])
      ])
    );
  } catch (error) {
    modal.querySelector('.modal__body').replaceChildren(h('div', { class: 'callout callout--danger', text: error.message }));
  }
}

export function resetConversation() {
  log().innerHTML = '';
  messages.clear();
  start();
}

export function start() {
  // route() re-enters this view every time the shopper comes back to Shop. The greeting marks the
  // start of a conversation, not the arrival at a tab, so it is only rendered into an empty log.
  const log = document.getElementById('chat-log');
  if (log && log.childElementCount > 0) return '';

  const requirement = state.chat?.requirement;
  const greeting = requirement
    ? `Welcome back. I still have your requirement (${humanStatus(requirement.categorySlug ?? 'anything')}). Want me to keep going from there, or start something new?`
    : 'Hi, I am ShopPilot. Tell me what you need — the product, a budget and anything that matters (battery life, weight, camera). I search this store’s real catalogue, compare real prices, and prepare a checkout that only you can approve.';
  const agent = addMessage('agent');
  agent.bubble.textContent = greeting;
  if (requirement) agent.body.append(requirementChipRow(state.chat.requirementChips ?? []));
  setQuickReplies(
    requirement
      ? ['show me more options', 'compare the top 2', 'what is in my cart']
      : ['laptop for full-stack development under $900', 'phone for photography under $800', 'headphones for flights under $350']
  );
  return escapeHtml(greeting);
}
