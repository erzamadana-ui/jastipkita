/**
 * E-mail layout: table-based, inline CSS (Gmail/Outlook safe), dark-mode aware (color-scheme meta +
 * prefers-color-scheme overrides via classes), accessible (lang, alt text, role="presentation" on
 * layout tables, real <th> in the price table, WCAG AA colour pairs from packages/design-tokens).
 * Colours are brand tokens (CONVENTIONS.md) — no ad-hoc hex values.
 */
import { escapeHtml as e, formatIdr, type Locale } from './format';
import type { Copy, Highlight, QuoteLineView, Role, TxView } from './types';

export const EMAIL_COLORS = {
  bg: '#F7F8FB', // offwhite-50
  card: '#FFFFFF',
  border: '#E2E8F0', // slate-200
  heading: '#0B1E4A', // navy-900
  text: '#0F172A', // ink-900
  muted: '#475569', // slate-600 (AA on white & off-white)
  link: '#1E5BFF', // cobalt-500 (5.2:1 on white)
  button: '#1E5BFF',
  buttonText: '#FFFFFF',
  successBg: '#047857', // emerald-700: white text 5.48:1 (emerald-600 fails with white)
  successText: '#FFFFFF',
  warningBg: '#FFF7ED', // orange-50 + orange-500 border, ink text (white-on-orange fails)
  warningBorder: '#F97316',
  infoBg: '#EEF3FF', // cobalt-50
  infoBorder: '#1E5BFF',
  dangerBg: '#FEF2F2', // red-50
  dangerBorder: '#DC2626', // red-600
  dangerText: '#991B1B', // red-800
  // dark mode
  darkBg: '#070B19', // navy-950
  darkCard: '#0D1631', // navy-925
  darkBorder: '#294378', // navy-600
  darkText: '#F7F8FB',
  darkMuted: '#CBD5E1', // slate-300
  darkLink: '#8CA9FF', // cobalt-300
  darkButton: '#4D7DFF', // cobalt-400 with navy-950 label (5.32:1)
} as const;

const C = EMAIL_COLORS;
const FONT = "Poppins,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export interface LayoutLinks {
  webUrl: string;
  deepLink: string;
  receiptUrl: string | null;
  logoUrl: string;
  homeUrl: string;
  supportUrl: string;
  settingsUrl: string;
  termsUrl: string;
  privacyUrl: string;
}

export interface LayoutInput {
  locale: Locale;
  role: Role | undefined;
  name: string;
  copy: Copy;
  tx: TxView | undefined;
  statusLabel: string | null;
  lines: QuoteLineView[];
  links: LayoutLinks;
}

const T = {
  id: {
    hi: (n: string) => `Halo ${n},`,
    txNumber: 'No. transaksi',
    product: 'Produk',
    traveler: 'Traveler',
    buyer: 'Penitip',
    status: 'Status',
    breakdown: 'Rincian harga',
    breakdownTraveler: 'Rincian untuk traveler',
    item: 'Item',
    amount: 'Jumlah',
    estimate: 'estimasi',
    estimateNote: 'Bea masuk & pajak impor adalah estimasi; nilai final ditetapkan Bea Cukai.',
    openApp: 'Buka di aplikasi JastipKita',
    receipt: 'Lihat struk',
    auto: 'E-mail ini dikirim otomatis oleh JastipKita — mohon tidak membalas e-mail ini.',
    help: 'Butuh bantuan? Hubungi Pusat Bantuan',
    settings: 'Atur notifikasi',
    terms: 'Syarat & Ketentuan',
    privacy: 'Kebijakan Privasi',
    tagline: 'JastipKita — Titip Mudah, Aman, Terpercaya.',
    fallback: 'Jika tombol tidak berfungsi, buka tautan ini:',
  },
  en: {
    hi: (n: string) => `Hi ${n},`,
    txNumber: 'Transaction no.',
    product: 'Product',
    traveler: 'Traveler',
    buyer: 'Buyer',
    status: 'Status',
    breakdown: 'Price breakdown',
    breakdownTraveler: 'Breakdown for traveler',
    item: 'Item',
    amount: 'Amount',
    estimate: 'estimate',
    estimateNote: 'Customs duty & import tax are estimates; the final amount is set by Indonesian Customs.',
    openApp: 'Open in the JastipKita app',
    receipt: 'View receipt',
    auto: 'This e-mail was sent automatically by JastipKita — please do not reply.',
    help: 'Need help? Visit the Help Center',
    settings: 'Notification settings',
    terms: 'Terms & Conditions',
    privacy: 'Privacy Policy',
    tagline: 'JastipKita — Easy, Safe, Trusted shopping by travelers.',
    fallback: 'If the button does not work, open this link:',
  },
} as const;

function summaryRows(inp: LayoutInput): [string, string][] {
  const t = T[inp.locale];
  const rows: [string, string][] = [];
  if (inp.tx) {
    rows.push([t.txNumber, inp.tx.number]);
    rows.push([t.product, inp.tx.quantity > 1 ? `${inp.tx.productName} × ${inp.tx.quantity}` : inp.tx.productName]);
    if (inp.role === 'TRAVELER') rows.push([t.buyer, inp.tx.buyerPublicName]);
    else if (inp.tx.travelerId) rows.push([t.traveler, inp.tx.travelerPublicName]);
    if (inp.statusLabel) rows.push([t.status, inp.statusLabel]);
  }
  for (const d of inp.copy.details ?? []) rows.push(d);
  return rows;
}

function lineLabel(l: QuoteLineView, locale: Locale): string {
  const base = locale === 'en' ? l.labelEn : l.labelId;
  return l.isEstimate && l.type !== 'TOTAL' ? `${base} (${T[locale].estimate})` : base;
}

function highlightStyle(h: Highlight): { bg: string; border: string; color: string; cls: string } {
  switch (h.tone) {
    case 'success':
      return { bg: C.successBg, border: C.successBg, color: C.successText, cls: 'jk-hl-success' };
    case 'warning':
      return { bg: C.warningBg, border: C.warningBorder, color: C.text, cls: 'jk-hl-warning' };
    case 'danger':
      return { bg: C.dangerBg, border: C.dangerBorder, color: C.dangerText, cls: 'jk-hl-danger' };
    default:
      return { bg: C.infoBg, border: C.infoBorder, color: C.heading, cls: 'jk-hl-info' };
  }
}

export function renderEmailHtml(inp: LayoutInput): string {
  const t = T[inp.locale];
  const { copy, links } = inp;
  const p = (text: string) =>
    `<p class="jk-text" style="margin:0 0 14px;font:400 15px/1.6 ${FONT};color:${C.text};">${e(text)}</p>`;

  const hl = copy.highlight
    ? (() => {
        const s = highlightStyle(copy.highlight);
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 18px;border-collapse:separate;">
<tr><td class="${s.cls}" style="background:${s.bg};border-left:4px solid ${s.border};border-radius:10px;padding:14px 16px;font:600 14px/1.5 ${FONT};color:${s.color};">${e(copy.highlight.text)}</td></tr></table>`;
      })()
    : '';

  const rows = summaryRows(inp);
  const summary = rows.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="jk-line" style="margin:6px 0 20px;border:1px solid ${C.border};border-radius:12px;border-collapse:separate;">
${rows
  .map(
    ([k, v], i) =>
      `<tr><td class="jk-muted jk-line" style="padding:10px 14px;font:400 13px/1.4 ${FONT};color:${C.muted};${i ? `border-top:1px solid ${C.border};` : ''}width:38%;">${e(k)}</td><td class="jk-text jk-line" style="padding:10px 14px;font:600 13px/1.4 ${FONT};color:${C.text};${i ? `border-top:1px solid ${C.border};` : ''}">${e(v)}</td></tr>`,
  )
  .join('\n')}
</table>`
    : '';

  const hasEstimate = inp.lines.some((l) => l.isEstimate && l.type !== 'TOTAL');
  const breakdown = inp.lines.length
    ? `<table width="100%" cellpadding="0" cellspacing="0" class="jk-line" style="margin:0 0 8px;border-collapse:collapse;font-variant-numeric:tabular-nums;font-feature-settings:'tnum';">
<caption class="jk-heading" style="text-align:left;padding:0 0 8px;font:600 15px/1.4 ${FONT};color:${C.heading};">${e(inp.role === 'TRAVELER' ? t.breakdownTraveler : t.breakdown)}</caption>
<tr><th scope="col" class="jk-muted" style="text-align:left;padding:6px 0;font:500 12px/1.4 ${FONT};color:${C.muted};">${e(t.item)}</th><th scope="col" class="jk-muted" style="text-align:right;padding:6px 0;font:500 12px/1.4 ${FONT};color:${C.muted};">${e(t.amount)}</th></tr>
${inp.lines
  .map((l) => {
    const total = l.type === 'TOTAL';
    const w = total ? 700 : 400;
    const border = total ? `border-top:2px solid ${C.heading};` : `border-top:1px solid ${C.border};`;
    return `<tr><td class="jk-text jk-line" style="padding:8px 0;${border}font:${w} 14px/1.4 ${FONT};color:${C.text};">${e(lineLabel(l, inp.locale))}</td><td class="jk-text jk-line" style="padding:8px 0;${border}text-align:right;white-space:nowrap;font:${total ? 700 : 600} 14px/1.4 ${FONT};color:${C.text};">${e(formatIdr(l.amountIdr, inp.locale))}</td></tr>`;
  })
  .join('\n')}
</table>
${hasEstimate ? `<p class="jk-muted" style="margin:0 0 18px;font:400 12px/1.5 ${FONT};color:${C.muted};">${e(t.estimateNote)}</p>` : '<div style="height:10px;line-height:10px;">&nbsp;</div>'}`
    : '';

  const cta = `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 14px;border-collapse:separate;">
<tr><td class="jk-btn-cell" style="border-radius:999px;background:${C.button};"><a class="jk-btn" href="${e(links.webUrl)}" style="display:inline-block;padding:13px 26px;font:600 15px/1.2 ${FONT};color:${C.buttonText};text-decoration:none;border-radius:999px;">${e(copy.cta)}</a></td></tr></table>
<p class="jk-muted" style="margin:0 0 6px;font:400 13px/1.5 ${FONT};color:${C.muted};"><a class="jk-link" href="${e(links.deepLink)}" style="color:${C.link};text-decoration:underline;">${e(t.openApp)}</a>${
    links.receiptUrl
      ? ` &nbsp;·&nbsp; <a class="jk-link" href="${e(links.receiptUrl)}" style="color:${C.link};text-decoration:underline;">${e(t.receipt)}</a>`
      : ''
  }</p>
<p class="jk-muted" style="margin:0;font:400 12px/1.5 ${FONT};color:${C.muted};word-break:break-all;">${e(t.fallback)} <a class="jk-link" href="${e(links.webUrl)}" style="color:${C.link};">${e(links.webUrl)}</a></p>`;

  const footer = `<p class="jk-muted" style="margin:0 0 8px;font:400 12px/1.6 ${FONT};color:${C.muted};">${e(t.auto)}</p>
<p class="jk-muted" style="margin:0 0 8px;font:400 12px/1.6 ${FONT};color:${C.muted};"><a class="jk-link" href="${e(links.supportUrl)}" style="color:${C.link};">${e(t.help)}</a> &nbsp;·&nbsp; <a class="jk-link" href="${e(links.settingsUrl)}" style="color:${C.link};">${e(t.settings)}</a></p>
<p class="jk-muted" style="margin:0 0 8px;font:400 12px/1.6 ${FONT};color:${C.muted};"><a class="jk-link" href="${e(links.termsUrl)}" style="color:${C.link};">${e(t.terms)}</a> &nbsp;·&nbsp; <a class="jk-link" href="${e(links.privacyUrl)}" style="color:${C.link};">${e(t.privacy)}</a></p>
<p class="jk-muted" style="margin:0;font:500 12px/1.6 ${FONT};color:${C.muted};">${e(t.tagline)}</p>`;

  return `<!DOCTYPE html>
<html lang="${inp.locale}" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${e(copy.subject)}</title>
<style>
:root { color-scheme: light dark; supported-color-schemes: light dark; }
@media (prefers-color-scheme: dark) {
  .jk-bg { background:${C.darkBg} !important; }
  .jk-card { background:${C.darkCard} !important; border-color:${C.darkBorder} !important; }
  .jk-heading, .jk-text { color:${C.darkText} !important; }
  .jk-muted { color:${C.darkMuted} !important; }
  .jk-line { border-color:${C.darkBorder} !important; }
  .jk-link { color:${C.darkLink} !important; }
  .jk-btn-cell { background:${C.darkButton} !important; }
  .jk-btn { color:${C.darkBg} !important; }
  .jk-hl-warning { background:#431407 !important; color:#FED7AA !important; }
  .jk-hl-info { background:#0B1A42 !important; color:#DCE6FF !important; }
  .jk-hl-danger { background:#450A0A !important; color:#FECACA !important; }
}
@media only screen and (max-width:620px) { .jk-container { width:100% !important; } .jk-pad { padding:24px 18px !important; } }
</style>
</head>
<body class="jk-bg" style="margin:0;padding:0;background:${C.bg};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;" aria-hidden="true">${e(copy.body)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="jk-bg" style="background:${C.bg};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" class="jk-container" style="width:600px;max-width:600px;">
<tr><td style="padding:4px 4px 18px;"><a href="${e(links.homeUrl)}" style="text-decoration:none;"><img src="${e(links.logoUrl)}" width="160" height="40" alt="JastipKita" style="display:block;border:0;outline:none;width:160px;height:40px;"></a></td></tr>
<tr><td class="jk-card jk-pad" style="background:${C.card};border:1px solid ${C.border};border-radius:16px;padding:32px;">
<h1 class="jk-heading" style="margin:0 0 16px;font:600 22px/1.3 ${FONT};color:${C.heading};">${e(copy.heading)}</h1>
${p(t.hi(inp.name))}
${copy.paragraphs.map(p).join('\n')}
${hl}
${summary}
${breakdown}
${cta}
</td></tr>
<tr><td style="padding:22px 8px 8px;">
${footer}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export function renderEmailText(inp: LayoutInput): string {
  const t = T[inp.locale];
  const out: string[] = [];
  out.push(inp.copy.heading, '', t.hi(inp.name), '');
  for (const para of inp.copy.paragraphs) out.push(para, '');
  if (inp.copy.highlight) out.push(`>> ${inp.copy.highlight.text}`, '');
  const rows = summaryRows(inp);
  if (rows.length) {
    for (const [k, v] of rows) out.push(`${k}: ${v}`);
    out.push('');
  }
  if (inp.lines.length) {
    out.push(inp.role === 'TRAVELER' ? t.breakdownTraveler : t.breakdown);
    for (const l of inp.lines) {
      const label = lineLabel(l, inp.locale);
      out.push(`${l.type === 'TOTAL' ? '= ' : '- '}${label}: ${formatIdr(l.amountIdr, inp.locale)}`);
    }
    if (inp.lines.some((l) => l.isEstimate && l.type !== 'TOTAL')) out.push(t.estimateNote);
    out.push('');
  }
  out.push(`${inp.copy.cta}: ${inp.links.webUrl}`);
  out.push(`${t.openApp}: ${inp.links.deepLink}`);
  if (inp.links.receiptUrl) out.push(`${t.receipt}: ${inp.links.receiptUrl}`);
  out.push('', '—', t.auto, `${t.help}: ${inp.links.supportUrl}`, `${t.settings}: ${inp.links.settingsUrl}`);
  out.push(`${t.terms}: ${inp.links.termsUrl}`, `${t.privacy}: ${inp.links.privacyUrl}`, t.tagline);
  return out.join('\n');
}
