/**
 * Deep-link fallback for https://antarkitaindonesia.com/jastipkita/app/transactions/<id>.
 * When the app is installed, Android App Links / iOS Universal Links open it before this page loads.
 * Static hosting cannot serve /app/transactions/<id>/ directly, so the id is read from:
 *   ?id=<id>  (set by the root 404 redirect snippet — see apps/web/README.md)  or  the path  or  #<id>.
 * The id is validated and only ever written with textContent.
 */
const box = document.querySelector<HTMLElement>('.deeplink');
const params = new URLSearchParams(location.search);
const fromPath = /\/app\/transactions\/([^/?#]+)/.exec(location.pathname)?.[1];
const raw = params.get('id') ?? (fromPath ? decodeURIComponent(fromPath) : null) ?? (location.hash ? location.hash.slice(1) : null);
const VALID = /^(JK-\d{6}-[0-9A-HJKMNP-TV-Z]{6}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
if (box && raw) {
  if (VALID.test(raw)) {
    const idBox = document.querySelector<HTMLElement>('#dl-id');
    const strong = idBox?.querySelector('strong');
    if (idBox && strong) { strong.textContent = raw; idBox.hidden = false; }
    const scheme = box.dataset.scheme ?? 'jastipkita';
    const pkg = box.dataset.package ?? '';
    const path = `transactions/${encodeURIComponent(raw)}`;
    const isAndroid = /Android/i.test(navigator.userAgent);
    const open = document.querySelector<HTMLAnchorElement>('#dl-open');
    if (open) {
      open.href = isAndroid ? `intent://${path}#Intent;scheme=${scheme};package=${pkg};end` : `${scheme}://${path}`;
      open.hidden = false;
    }
  } else {
    const inv = document.querySelector<HTMLElement>('#dl-invalid');
    if (inv) inv.hidden = false;
  }
}

export {};
