/**
 * Where PayPal sends the buyer after they approve (or cancel) an order.
 *
 * The PayPal order has to carry a `return_url` and a `cancel_url`, otherwise the hosted checkout
 * page has nowhere to send the shopper back to and the approval ends on a PayPal error page
 * instead of on our order. The URLs are derived from the request that created the order, so the
 * same code is correct in local development and behind Render's proxy.
 */

/**
 * The public origin of the current request, e.g. `https://paypal-hackathon.onrender.com`.
 * Falls back to `WEB_ORIGIN` when the request carries no usable Host header.
 */
export function requestOrigin(req, fallback) {
  // Render (and every other reverse proxy) forwards the public host in `X-Forwarded-Host`; the
  // `Host` header can be the proxy's own internal address. Getting this wrong would point the
  // buyer's return URL at something the browser cannot reach, so the forwarded header wins.
  const forwardedHost = (req?.get?.('x-forwarded-host') ?? '').split(',')[0].trim();
  const host = forwardedHost || (req?.get?.('host') ?? '').trim();
  if (!host || host.includes(' ')) return fallback;
  const forwardedProto = (req?.get?.('x-forwarded-proto') ?? '').split(',')[0].trim();
  const protocol = (forwardedProto || req.protocol) === 'https' ? 'https' : 'http';
  return `${protocol}://${host}`;
}

/**
 * The return/cancel pair for a given order. Both point at the order's checkout page so the buyer
 * lands back on the order they were paying for, whichever way the flow ended.
 */
export function checkoutReturnUrls(origin, order) {
  const base = `${String(origin).replace(/\/+$/, '')}/checkout/${order._id}`;
  return {
    returnUrl: `${base}?from=paypal`,
    cancelUrl: `${base}?from=paypal&cancelled=1`
  };
}
