/**
 * Restricted-items checker island. POST /v1/restricted/check; offline fallback = classifyOffline() over the
 * static seed snapshot (src/data/restricted-items.generated.json).
 */
import { api, ApiError, escapeHtml } from '../lib/api.ts';
import { classifyOffline, type Classification, type RestrictedRule } from '../lib/restricted.ts';

const lang: 'id' | 'en' = document.documentElement.lang === 'en' ? 'en' : 'id';
const T = (id: string, en: string) => (lang === 'id' ? id : en);
const form = document.querySelector<HTMLFormElement>('#rc-form');
const out = document.querySelector<HTMLDivElement>('#rc-output');
const status = document.querySelector<HTMLSpanElement>('#rc-status');
const errBox = document.querySelector<HTMLDivElement>('#rc-error');

const LABEL: Record<Classification, [string, string, string, string]> = {
  ALLOWED: ['Diizinkan', 'Allowed', 'Tidak ada aturan khusus yang cocok. Tetap patuhi batas bagasi & deklarasi.', 'No specific rule matched. Baggage limits and declaration duties still apply.'],
  DECLARATION_REQUIRED: ['Wajib dideklarasikan', 'Declaration required', 'Boleh dititip, wajib dideklarasikan ke Bea Cukai.', 'Allowed, but must be declared to Customs.'],
  RESTRICTED: ['Barang terbatas', 'Restricted item', 'Boleh dititip dengan batas & persetujuan sebelum membayar.', 'Allowed within limits, after you acknowledge the warning.'],
  PERMIT_REQUIRED: ['Butuh izin', 'Permit required', 'Butuh izin instansi; kamu wajib menyetujui risikonya sebelum membayar.', 'Needs an agency permit; you must acknowledge the risk before paying.'],
  PROHIBITED: ['Dilarang', 'Prohibited', 'Tidak bisa dititipkan — checkout diblokir.', 'Cannot be ordered — checkout is blocked.'],
};
const ICON: Record<Classification, string> = {
  ALLOWED: '<path d="M21.8 10A10 10 0 1 1 17 3.3"/><path d="m9 11 3 3L22 4"/>',
  DECLARATION_REQUIRED: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  RESTRICTED: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  PERMIT_REQUIRED: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="m9 15 2 2 4-4"/>',
  PROHIBITED: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
};

function banner(cls: Classification): string {
  const [id, en, descId, descEn] = LABEL[cls];
  return `<div class="class-banner class-${cls}" role="${cls === 'PROHIBITED' ? 'alert' : 'status'}">
    <span class="ic"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[cls]}</svg></span>
    <div><div class="tt" style="font-weight:600">${escapeHtml(T(id, en))}</div><div class="small">${escapeHtml(T(descId, descEn))}</div></div></div>`;
}

function setStatus(state: string, label: string) {
  if (!status) return;
  status.dataset.state = state;
  const l = status.querySelector('.lbl');
  if (l) l.textContent = label;
}

interface ApiResult {
  classification: Classification; blocksCheckout: boolean; requiresAcknowledgement: boolean; messages: string[];
  permitAuthorities: string[]; airlineDg: boolean; ruleRef: string | null; disclaimer: string;
}

function render(cls: Classification, messages: string[], extra: string[], foot: string) {
  if (!out) return;
  out.innerHTML = `${banner(cls)}
    ${messages.length ? `<ul class="rc-msgs">${messages.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ul>` : ''}
    ${extra.length ? `<p class="xsmall muted" style="margin-top:10px">${extra.map(escapeHtml).join(' · ')}</p>` : ''}
    <p class="xsmall muted" style="margin-top:12px">${escapeHtml(foot)}</p>`;
}

form?.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const fd = new FormData(form);
  const productName = String(fd.get('productName') ?? '').trim();
  const origin = String(fd.get('origin') ?? 'JP');
  const categoryCode = String(fd.get('category') ?? 'OTHER');
  const quantity = Math.max(1, Math.min(999, Number(fd.get('quantity') ?? 1) || 1));
  if (productName.length < 2) {
    if (errBox) { errBox.hidden = false; errBox.textContent = T('Isi nama barang (min. 2 karakter).', 'Enter a product name (min. 2 characters).'); }
    document.querySelector<HTMLInputElement>('#rc-name')?.focus();
    return;
  }
  if (errBox) errBox.hidden = true;
  setStatus('loading', T('Memeriksa…', 'Checking…'));
  try {
    const r = await api<ApiResult>('/v1/restricted/check', {
      body: { originCountry: origin, destinationCountry: 'ID', categoryCode, productName, quantity, locale: lang },
      timeoutMs: 6000,
    });
    setStatus('online', T('Dari API JastipKita', 'From the JastipKita API'));
    const extra = [
      ...(r.permitAuthorities.length ? [`${T('Instansi', 'Authority')}: ${r.permitAuthorities.join(', ')}`] : []),
      ...(r.airlineDg ? [T('Ada batasan barang berbahaya penerbangan', 'Aviation dangerous-goods limits apply')] : []),
    ];
    render(r.classification, r.messages, extra, `${r.disclaimer}${r.ruleRef ? ` (${r.ruleRef})` : ''}`);
  } catch (e) {
    if (e instanceof ApiError && e.kind === 'http' && e.status < 500) {
      setStatus('online', T('Dari API JastipKita', 'From the JastipKita API'));
      if (out) out.innerHTML = `<div class="note note-error"><p>${escapeHtml(e.message)}</p></div>`;
      return;
    }
    // The static rule snapshot (~40 kB) is only downloaded when the API is unreachable.
    const { default: data } = await import('../data/restricted-items.generated.json');
    const res = classifyOffline({ origin, categoryCode, productName, quantity }, data.rules as unknown as RestrictedRule[]);
    setStatus('offline', T('Mode offline · daftar statis', 'Offline · static list'));
    const msgs = res.matches.map((m) => {
      const base = lang === 'id' ? m.messageId : m.messageEn;
      return m.quantityExceeded ? `${base} ${T('(Melebihi batas', '(Limit exceeded')}: ${m.quantityExceeded.actual} > ${m.quantityExceeded.limit}.)` : base;
    });
    const extra = [
      ...(res.permitAuthorities.length ? [`${T('Instansi', 'Authority')}: ${res.permitAuthorities.join(', ')}`] : []),
      ...(res.airlineDg ? [T('Ada batasan barang berbahaya penerbangan', 'Aviation dangerous-goods limits apply')] : []),
      ...(res.matches.some((m) => m.valueCheckSkipped) ? [T('Batas nilai tidak diperiksa di mode offline', 'Value limits not checked offline')] : []),
    ];
    render(res.classification, msgs, extra, T(
      `API belum dapat dihubungi; diperiksa dengan daftar aturan per ${data.lastVerifiedAt}. Pemeriksaan kata kunci bisa terlewat — pilih kategori yang tepat. Keputusan akhir ada pada Bea Cukai.`,
      `API not reachable; checked against the rule list as of ${data.lastVerifiedAt}. Keyword matching can miss items — pick the right category. Customs has the final say.`,
    ));
  }
});

const params = new URLSearchParams(location.search);
const o = params.get('origin')?.toUpperCase();
const sel = document.querySelector<HTMLSelectElement>('#rc-origin');
if (o && sel && [...sel.options].some((x) => x.value === o)) sel.value = o;
