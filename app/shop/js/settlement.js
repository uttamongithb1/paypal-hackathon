/**
 * Multi-seller settlement, rendered honestly.
 *
 * One PayPal order can pay several sellers in a single approval (Orders v2 multi-seller): each
 * seller gets a `purchase_unit` with its own `payee` and the platform keeps a `platform_fees`
 * commission. When the account is not enabled for that capability the app falls back to one
 * unit — and this module says so, on screen, instead of implying a split that never happened.
 *
 * Docs: docs/payments_paypal.md · WIN_PLAN.md §4 F1
 */
import { h } from './ui.js';
import { money } from './api.js';

const short = (text, n = 10) => (text && text.length > n ? `${text.slice(0, n)}…` : text ?? '—');

/** The capture that corresponds to a seller's unit, matched by index — captures come back in unit order. */
function captureFor(order, index) {
  return (order?.payment?.captures ?? [])[index] ?? null;
}

/**
 * @param {object} order   order DTO
 * @param {object} [opts]
 * @param {string} [opts.merchantId]  when set, highlight this seller's own row (merchant view)
 */
export function settlementPanel(order, { merchantId = null } = {}) {
  const settlement = order?.payment?.settlement;
  if (!settlement) return null;

  const units = settlement.units ?? [];

  // ── Split: every seller was paid separately. Show who got what. ──
  if (settlement.mode === 'split' && units.length > 1) {
    const total = order.amounts?.totalMinor ?? 0;
    const sum = units.reduce((acc, unit) => acc + unit.amountMinor, 0);
    const reconciles = sum === total;
    const mine = merchantId ? units.find((unit) => unit.merchantId === merchantId) : null;
    const commission = settlement.totals?.platformFeeMinor ?? units.reduce((acc, u) => acc + (u.platformFeeMinor ?? 0), 0);

    return h('div', { class: 'settlement' }, [
      h('div', { class: 'row row--between' }, [
        h('strong', { text: `Split settlement · ${units.length} sellers paid in one approval` }),
        h('span', { class: 'badge badge--success', text: reconciles ? 'amounts reconcile' : 'CHECK AMOUNTS' })
      ]),
      mine
        ? h('div', { class: 'callout callout--success' }, [
            h('strong', { text: `Your share: ${money(mine.amountMinor)}` }),
            h('p', { class: 'note', text: `Paid directly to ${mine.payeeEmail ?? 'your account'}. ShopPilot commission on this sale: ${money(mine.platformFeeMinor ?? 0)}.` })
          ])
        : null,
      h('div', { class: 'table-wrap' }, [
        h('table', { class: 'settlement__table' }, [
          h('thead', {}, [h('tr', {}, [
            h('th', { text: 'Seller' }),
            h('th', { text: 'Amount' }),
            h('th', { text: 'Commission' }),
            h('th', { text: 'Paid to (PayPal capture)' })
          ])]),
          h('tbody', {}, units.map((unit, index) => {
            const capture = captureFor(order, index);
            return h('tr', { class: merchantId && unit.merchantId === merchantId ? 'settlement__row--mine' : '' }, [
              h('td', {}, [
                h('div', { text: unit.merchantName ?? short(unit.merchantId, 8) }),
                h('div', { class: 'note', text: unit.referenceId ? `unit ${unit.referenceId}` : '' })
              ]),
              h('td', { class: 'mono', text: money(unit.amountMinor) }),
              h('td', { class: 'mono', text: money(unit.platformFeeMinor ?? 0) }),
              // Payee and the capture that proves it, together — one column keeps the table readable
              // in the narrow checkout sidebar.
              h('td', {}, [
                h('div', { class: 'mono note', text: unit.payeeEmail ?? '—' }),
                h('div', { class: 'mono note', text: capture ? capture.id : (order.payment?.paypalCaptureId ?? '') })
              ])
            ]);
          }))
        ])
      ]),
      h('div', { class: 'note' }, [
        h('span', { text: `Seller amounts ${money(sum)} ${reconciles ? '=' : '≠'} order total ${money(total)}. ` }),
        h('span', { text: `Platform commission: ${money(commission)} (${(settlement.totals?.sellerCount ?? units.length)} sellers).` })
      ])
    ]);
  }

  // ── Single unit, but the cart had several sellers: say why, plainly. ──
  const reason = (settlement.reason ?? [])[0];
  const sellerCount = new Set((order.lines ?? []).map((line) => line.merchantId)).size;
  const multiSellerCart = sellerCount > 1;
  if (settlement.mode === 'single' && multiSellerCart) {
    return h('div', { class: 'callout callout--warning settlement' }, [
      h('strong', { text: 'Paid as a single payment (not split per seller)' }),
      h('p', { class: 'note', text: `${reason ? `Reason: ${reason}. ` : ''}This order covers items from more than one seller, so PayPal received one amount for the whole basket. ShopPilot records this openly rather than implying each seller was paid directly.` })
    ]);
  }

  return null;
}

/** One-line summary for tables and lists. */
export function settlementBadge(order) {
  const settlement = order?.payment?.settlement;
  if (!settlement) return null;
  if (settlement.mode === 'split' && (settlement.units?.length ?? 0) > 1) {
    return h('span', { class: 'badge badge--success', text: `split · ${settlement.units.length} sellers` });
  }
  // "Fallback" is only meaningful when the basket really did span several sellers. A one-seller
  // order is not a downgrade, so it gets no badge at all — the label must stay trustworthy.
  const sellerCount = new Set((order.lines ?? []).map((line) => line.merchantId)).size;
  return sellerCount > 1 ? h('span', { class: 'badge', text: 'single (fallback)' }) : null;
}
