/**
 * Component builders: pure functions that turn tool results into UI payloads.
 * The model never emits UI JSON — it calls tools and these functions shape what the client renders.
 * Docs: ../docs/ai_agent_spec.md §6, ../docs/api_spec.md §7
 */

export function productCards({ products, revision, relaxed = [], assumptions = [] }) {
  return {
    type: 'product_cards',
    payload: {
      revision,
      relaxed,
      assumptions,
      requiresApproval: false,
      cards: products.slice(0, 5).map((product) => ({
        productId: product.id ?? product.productId,
        slug: product.slug,
        title: product.title,
        brand: product.brand,
        merchant: product.merchant ? { id: product.merchant.id, name: product.merchant.name } : null,
        price: product.price,
        stock: { available: product.stock, state: product.availability },
        whyItFits: product.whyItFits,
        pros: (product.pros ?? []).slice(0, 4),
        cons: (product.cons ?? []).slice(0, 2),
        rating: product.rating,
        attrs: product.attributes,
        slightlyOverBudget: Boolean(product.slightlyOverBudget),
        actions: ['add_to_cart', 'compare', 'details']
      }))
    }
  };
}

export function comparison({ comparison: result, revision }) {
  const winners = new Map();
  for (const row of result.rows) {
    const better = row.values.filter((v) => v.better);
    if (better.length === 1) winners.set(better[0].productId, (winners.get(better[0].productId) ?? 0) + 1);
  }
  return {
    type: 'comparison',
    payload: {
      revision,
      products: result.products.map((p) => ({
        productId: p.id,
        title: p.title,
        brand: p.brand,
        price: p.price,
        stock: { available: p.stock, state: p.availability },
        wins: winners.get(p.id) ?? 0
      })),
      rows: result.rows,
      summary: result.summary,
      caveats: result.caveats,
      winnerProductId: result.winnerProductId
    }
  };
}

export function cartSummary({ cart }) {
  return {
    type: 'cart_summary',
    payload: {
      itemCount: cart.itemCount,
      subtotalMinor: cart.subtotalMinor,
      currency: cart.currency,
      display: cart.display,
      items: cart.items.map((i) => ({
        productId: i.productId,
        title: i.title,
        quantity: i.quantity,
        unitPriceMinor: i.unitPriceMinor,
        lineTotalMinor: i.lineTotalMinor,
        display: i.lineTotalDisplay,
        unavailable: Boolean(i.unavailable)
      })),
      warnings: cart.warnings
    }
  };
}

export function checkoutCard({ order, quote, approvalsRequired = true }) {
  return {
    type: 'checkout_card',
    payload: {
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      requiresApproval: approvalsRequired,
      approvalUrl: `/checkout/${order.id}`,
      expiresAt: order.expiresAt,
      amounts: {
        ...order.amounts,
        display: {
          subtotal: order.amounts.display?.subtotal,
          shipping: order.amounts.display?.shipping,
          tax: order.amounts.display?.tax,
          total: order.amounts.display?.total
        }
      },
      lines: order.lines.map((l) => ({ productId: l.productId, title: l.title, quantity: l.quantity, lineTotalMinor: l.lineTotalMinor })),
      warnings: quote?.warnings ?? []
    }
  };
}

export function clarification({ kind, question, options, revision }) {
  return { type: 'clarification', payload: { kind, question, options, revision } };
}

export function orderStatusCard({ order, status }) {
  return {
    type: 'order_status',
    payload: {
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      paymentStatus: status?.paymentStatus ?? order.payment?.status,
      attemptNo: status?.attemptNo ?? order.payment?.lastAttemptNo ?? 0,
      totalMinor: order.amounts.totalMinor,
      display: order.amounts.display?.total,
      requiresApproval: order.status !== 'paid'
    }
  };
}
