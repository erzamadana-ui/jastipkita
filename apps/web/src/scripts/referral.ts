/** Referral landing: reads the code from ?code=, /r/<code> (via the root 404 redirect) or #<code>. Not stored anywhere. */
const params = new URLSearchParams(location.search);
const fromPath = /\/r\/([^/?#]+)/.exec(location.pathname)?.[1];
const raw = (params.get('code') ?? (fromPath ? decodeURIComponent(fromPath) : null) ?? (location.hash ? location.hash.slice(1) : '')).trim().toUpperCase();
const valid = /^[A-Z0-9-]{4,20}$/.test(raw);
const box = document.querySelector<HTMLElement>('#ref-box');
const codeEl = document.querySelector<HTMLElement>('#ref-code');
if (valid && box && codeEl) {
  codeEl.textContent = raw;
  box.hidden = false;
  document.querySelector('#ref-copy')?.addEventListener('click', async () => {
    const msg = document.querySelector('#ref-copied');
    try {
      await navigator.clipboard.writeText(raw);
      if (msg) msg.textContent = 'Kode disalin.';
    } catch {
      if (msg) msg.textContent = 'Tidak bisa menyalin otomatis — salin manual.';
    }
  });
} else if (raw) {
  const inv = document.querySelector<HTMLElement>('#ref-invalid');
  if (inv) inv.hidden = false;
}

export {};
