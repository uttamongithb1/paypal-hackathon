/** Persistent, non-modal shopping assistant. The existing chat owns all tools and requests. */
import { $ } from './ui.js';
let returnFocus;
export function openAssistant({ expanded = false } = {}) {
  const panel = $('#view-shop');
  if (panel.hidden) returnFocus = document.activeElement;
  panel.hidden = false;
  if (expanded) panel.classList.add('assistant--expanded');
  $('#assistant-expand').setAttribute('aria-pressed', String(panel.classList.contains('assistant--expanded')));
  $('#assistant-launcher').setAttribute('aria-expanded', 'true');
  document.body.classList.add('assistant-open');
  $('#chat-input').focus({ preventScroll: true });
}
export function closeAssistant({ restoreFocus = true } = {}) {
  $('#view-shop').hidden = true;
  $('#assistant-launcher').setAttribute('aria-expanded', 'false');
  document.body.classList.remove('assistant-open');
  if (restoreFocus) (returnFocus?.isConnected ? returnFocus : $('#assistant-launcher')).focus({ preventScroll: true });
}
export function wireAssistant() {
  $('#assistant-launcher').addEventListener('click', () => $('#view-shop').hidden ? openAssistant() : closeAssistant());
  $('#assistant-close').addEventListener('click', () => closeAssistant());
  $('#assistant-expand').addEventListener('click', () => {
    const expanded = $('#view-shop').classList.toggle('assistant--expanded');
    $('#assistant-expand').setAttribute('aria-pressed', String(expanded));
    $('#assistant-expand').setAttribute('aria-label', expanded ? 'Reduce assistant' : 'Expand assistant');
  });
  document.addEventListener('sp:assistant-open', () => openAssistant());
  document.addEventListener('keydown', event => {
    if ($('#view-shop').hidden || $('#modal-overlay') || !$('#cart-drawer').hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); closeAssistant(); }
    // On phones the panel covers the screen: keep keyboard navigation inside it.
    if (event.key === 'Tab' && matchMedia('(max-width: 640px)').matches) {
      const nodes = [...$('#view-shop').querySelectorAll('button:not(:disabled), input:not(:disabled), a[href], select')].filter(n => n.getClientRects().length);
      const first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  // Follow the visual viewport when a phone keyboard opens.
  const viewport = () => {
    document.documentElement.style.setProperty('--assistant-vh', `${window.visualViewport?.height ?? innerHeight}px`);
    document.documentElement.style.setProperty('--assistant-top', `${window.visualViewport?.offsetTop ?? 0}px`);
  };
  window.visualViewport?.addEventListener('resize', viewport);
  window.visualViewport?.addEventListener('scroll', viewport);
  viewport();
}
