/**
 * Canonical store policy copy. The agent must answer policy questions from here (never from model
 * memory). Docs: ../docs/ai_agent_spec.md §4.9, ../prd.md §10.7
 */
export const POLICIES = {
  shipping: {
    text:
      'Shipping is free on orders of $500 or more. Orders between $200 and $500 ship for $9.99, and orders under $200 ship for $14.99. ' +
      'Oversized items add $19.99. Delivery is typically 2–5 business days within the demo region. The exact fee is always shown on the checkout page before you approve.',
    updatedAt: '2026-10-16T00:00:00.000Z'
  },
  returns: {
    text:
      'Return windows are set by the merchant and shown on each product page — 14 or 30 days from delivery depending on the seller. ' +
      'Items must be in original condition with all accessories. Refunds are issued to the original PayPal funding source after inspection.',
    updatedAt: '2026-10-16T00:00:00.000Z'
  },
  warranty: {
    text:
      'Warranty length is listed per product (12, 24 or 36 months). Warranty service is handled by the manufacturer through the merchant, ' +
      'and proof of purchase is the order number from your confirmation page.',
    updatedAt: '2026-10-16T00:00:00.000Z'
  },
  tax: {
    text:
      'Tax is charged at a flat demo rate of 8.25% on the item subtotal (shipping is not taxed in this demo). The tax amount is calculated server-side and shown on the checkout page before you approve.',
    updatedAt: '2026-10-16T00:00:00.000Z'
  },
  payment: {
    text:
      'Payment runs through PayPal. Nothing is charged until you press "Approve & Pay" and then authorise the payment in PayPal. ' +
      'If a payment fails, your order is not confirmed, no money leaves your account, and you can retry with a different funding source. ' +
      'This is a sandbox environment — no real money moves.',
    updatedAt: '2026-10-16T00:00:00.000Z'
  },
  privacy: {
    text:
      'We store your email and order details to fulfil the order and show your history. Card details are never handled by this site — they stay inside PayPal. ' +
      'Chat transcripts are used to answer your request and are not sold or shared. You can ask us to delete your account data at any time.',
    updatedAt: '2026-10-16T00:00:00.000Z'
  },
  demo: {
    text:
      'This is a demonstration environment. Payments are processed through the PayPal sandbox and no real money is charged. ' +
      'Product data, merchants and analytics are seeded demo data.',
    updatedAt: '2026-10-16T00:00:00.000Z'
  }
};

export const policyFor = (topic) => POLICIES[topic] ?? null;
