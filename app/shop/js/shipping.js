/**
 * Delivery address — collected before the order is created.
 *
 * Everything in the catalogue is a physical good, so a checkout without an address is a checkout
 * that cannot ship. PayPal needs the address to build its review page, and our own order record
 * needs it to make the fulfilment story real.
 *
 * The cart drawer re-renders whenever the cart changes — a background refresh used to wipe what
 * the shopper had typed — so the form keeps a draft: every keystroke is saved, and a re-render
 * puts the draft back. The shopper should never have to type an address twice.
 */
import { h } from './ui.js';

const STORAGE_KEY = 'shoppilot_delivery_address';

const FIELDS = [
  { key: 'name', label: 'Full name', placeholder: 'Aarav Sharma', autocomplete: 'name', width: 'full' },
  { key: 'line1', label: 'Street address', placeholder: '12 Brigade Road', autocomplete: 'address-line1', width: 'full' },
  { key: 'line2', label: 'Apartment, suite (optional)', placeholder: 'Flat 402', autocomplete: 'address-line2', width: 'full' },
  { key: 'city', label: 'City', placeholder: 'Gorakhpur', autocomplete: 'address-level2', width: 'half' },
  { key: 'state', label: 'State / region', placeholder: 'Uttar Pradesh', autocomplete: 'address-level1', width: 'half' },
  { key: 'postalCode', label: 'Postal code', placeholder: '273001', autocomplete: 'postal-code', width: 'half' },
  { key: 'countryCode', label: 'Country', placeholder: 'IN', autocomplete: 'country', width: 'half' }
];

const blank = () => ({ name: '', line1: '', line2: '', city: '', state: '', postalCode: '', countryCode: 'IN' });

export const savedDeliveryAddress = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...blank(), ...JSON.parse(raw) } : blank();
  } catch {
    return blank();
  }
};

export const saveDeliveryAddress = (address) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(address));
  } catch {
    // A browser with storage disabled still gets a working checkout; the address just is not kept.
  }
};

/**
 * The raw values in the form, exactly as typed. A partial draft is a valid draft.
 */
export function readAddressForm(root = document) {
  const value = (key) => root.querySelector(`#addr-${key}`)?.value ?? '';
  return {
    name: value('name'),
    line1: value('line1'),
    line2: value('line2'),
    city: value('city'),
    state: value('state'),
    postalCode: value('postalCode'),
    countryCode: value('countryCode') || 'IN'
  };
}

/**
 * The address form, rendered into the cart drawer.
 */
export function deliveryAddressField(initial = null) {
  const values = initial ? { ...blank(), ...initial } : savedDeliveryAddress();
  const wrap = h('fieldset', { class: 'field address-field' }, [
    h('legend', { class: 'label', text: 'Delivery address' }),
    h('p', { class: 'note', text: 'Physical goods — this is where the parcel goes.' })
  ]);
  for (const field of FIELDS) {
    const id = `addr-${field.key}`;
    wrap.appendChild(
      h('div', { class: `field address-field__row address-field__row--${field.width}` }, [
        h('label', { for: id, class: 'label', text: field.label }),
        h('input', {
          id,
          class: 'input',
          name: field.key,
          placeholder: field.placeholder,
          autocomplete: field.autocomplete,
          value: values[field.key] ?? ''
        })
      ])
    );
  }
  // Keep the draft as it is typed, so a cart refresh cannot lose it.
  wrap.addEventListener('input', () => saveDeliveryAddress(readAddressForm(wrap)));
  return wrap;
}

/**
 * Read the address out of the form. Returns `null` when the shopper left it empty — a null
 * address is valid; PayPal then falls back to the buyer's own wallet address.
 */
export function readDeliveryAddress(root = document) {
  const raw = readAddressForm(root);
  const name = raw.name.trim();
  const line1 = raw.line1.trim();
  const city = raw.city.trim();
  const state = raw.state.trim();
  const postalCode = raw.postalCode.trim();
  const countryCode = raw.countryCode.trim().toUpperCase();
  if (!name && !line1 && !city && !state && !postalCode) return null;
  if (!name || !line1 || !city || !state || !postalCode || countryCode.length !== 2) {
    throw Object.assign(new Error('Enter a full delivery address — name, street, city, state, postal code and a 2-letter country code.'), { code: 'VALIDATION_ERROR' });
  }
  const address = { name, line1, line2: raw.line2.trim(), city, state, postalCode, countryCode };
  saveDeliveryAddress(address);
  return address;
}

/** One line, for showing where an order is going. */
export const formatAddress = (address) =>
  address ? [address.line1, address.line2, address.city, address.state, address.postalCode, address.countryCode].filter(Boolean).join(', ') : '';
