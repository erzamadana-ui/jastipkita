/**
 * Customs & tax calculator island. Calls POST /v1/customs/estimate; if the API is unreachable, computes the
 * same PMK 34/2025 NON_PERSONAL formula locally (src/lib/customs.ts) and labels the result "mode offline".
 */
import { api, ApiError, escapeHtml } from '../lib/api.ts';
import { estimateNonPersonal, estimatePersonal, RULE_NON_PERSONAL } from '../lib/customs.ts';
import { formatDecimalString, formatIdr } from '../lib/money.ts';
import { CURRENCY_META, KMK_RATES } from '../data/kmk-rates.ts';

type Lang = 'id' | 'en';
const lang: Lang = document.documentElement.lang === 'en' ? 'en' : 'id';
const T = (id: string, en: string) => (lang === 'id' ? id : en);
const $ = <E extends HTMLElement>(sel: string) => document.querySelector<E>(sel);

const form = $<HTMLFormElement>('#calc-form');
const out = $<HTMLDivElement>('#calc-output');
const status = $<HTMLSpanElement>('#calc-status');
const errBox = $<HTMLDivElement>('#calc-error');
const origin = $<HTMLSelectElement>('#origin');
const currency = $<HTMLSelectElement>('#currency');
const price = $<HTMLInputElement>('#price');
const qty = $<HTMLInputElement>('#qty');
const rate = $<HTMLInputElement>('#rate');
const noNpwp = $<HTMLInputElement>('#no-npwp');
const category = $<HTMLSelectElement>('#category');
const submit = $<HTMLButtonElement>('#calc-submit');

interface Step { label: string; formula: string; amount: number }
interface ApiEstimate {
  ruleCode: string | null; ruleVersion: number | null; ruleRef: string | null; treatment: string;
  customsValueIdr: number; exemptionAppliedIdr: number; dutyIdr: number; vatIdr: number; luxuryTaxIdr: number;
  incomeTaxIdr: number; importTaxIdr: number; totalIdr: number; breakdownSteps: Step[];
  sourceReference: string | null; sourceUrl: string | null; lastVerifiedAt: string | null;
  warnings: Array<{ code: string; message: string }>;
}
interface ApiResult {
  treatmentExplanation: string; estimate: ApiEstimate; personalComparison: (ApiEstimate & { note: string }) | null;
  fx: { itemToIdr: string | null; usdToIdr: string | null; asOf: string | null; source: string | null; note: string };
  disclaimer: string;
}

function setStatus(state: 'idle' | 'loading' | 'online' | 'offline', label: string) {
  if (!status) return;
  status.dataset.state = state;
  const l = status.querySelector('.lbl');
  if (l) l.textContent = label;
}

const SAMPLE_PRICE: Record<string, string> = { JPY: '60000', KRW: '150000', SGD: '259', USD: '160', MYR: '399', AUD: '260', EUR: '200' };
function syncCurrency() {
  if (!origin || !currency || !rate) return;
  const ccy = origin.selectedOptions[0]?.dataset.currency ?? 'USD';
  currency.value = ccy;
  syncRate();
}
function syncRate() {
  if (!currency || !rate) return;
  rate.value = KMK_RATES.rates[currency.value] ?? '';
  rate.placeholder = KMK_RATES.rates[currency.value] ?? '';
  if (price && !price.dataset.touched) {
    price.value = SAMPLE_PRICE[currency.value] ?? '';
    price.placeholder = SAMPLE_PRICE[currency.value] ?? '';
  }
}

function toMinor(major: string, ccy: string): number {
  const m = CURRENCY_META[ccy]?.minorUnits ?? 2;
  const [i = '0', f = ''] = major.split('.');
  return Number(i) * 10 ** m + Number((f + '0'.repeat(m)).slice(0, m) || '0');
}

function validPrice(v: string, ccy: string): boolean {
  const m = CURRENCY_META[ccy]?.minorUnits ?? 2;
  const re = m === 0 ? /^\d{1,12}$/ : new RegExp(`^\\d{1,12}(\\.\\d{1,${m}})?$`);
  return re.test(v) && Number(v) > 0;
}

function row(label: string, sub: string, amount: number): string {
  return `<tr><th scope="row">${escapeHtml(label)}${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</th><td class="num">${escapeHtml(formatIdr(amount, lang))}</td></tr>`;
}

function renderTable(steps: Step[], total: number, value: number): string {
  const body = steps
    .filter((s) => !/^Nilai dasar/i.test(s.label) && !/total/i.test(s.label) && !(s.label === 'PPnBM' && s.amount === 0))
    .map((s) => row(s.label, s.formula, s.amount))
    .join('');
  const pct = value > 0 ? ((total / value) * 100).toFixed(1) : '0';
  return `<table class="table res-table"><tbody>${body}</tbody></table>
  <p class="res-total"><span>${escapeHtml(T('Total bea & pajak', 'Total duty & tax'))} <span class="badge-est">${T('Estimasi', 'Estimate')}</span></span><strong class="tnum">${escapeHtml(formatIdr(total, lang))}</strong></p>
  <p class="xsmall muted">≈ ${lang === 'id' ? pct.replace('.', ',') : pct}% ${escapeHtml(T('dari nilai pabean', 'of the customs value'))}</p>`;
}

function personalBlock(total: number, exemption: number, note: string): string {
  return `<details class="personal"><summary>${escapeHtml(T('Pembanding: bila ini barang pribadi traveler', 'Comparison: if this were the traveler’s own goods'))}</summary>
  <p class="small">${escapeHtml(T('Estimasi', 'Estimate'))}: <strong class="tnum">${escapeHtml(formatIdr(total, lang))}</strong> (${escapeHtml(T('pembebasan', 'exemption'))} ${escapeHtml(formatIdr(exemption, lang))}).</p>
  <p class="xsmall muted">${escapeHtml(note)}</p></details>`;
}

function offline(ccy: string, unitPrice: string, quantity: number) {
  const r = (rate?.value || KMK_RATES.rates[ccy] || '').trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(r) || Number(r) <= 0) throw new Error(T('Kurs tidak valid.', 'Invalid exchange rate.'));
  const usd = KMK_RATES.rates.USD ?? '17707';
  const input = { unitPrice, quantity, itemToIdr: r, usdToIdr: usd, noNpwpScenario: !!noNpwp?.checked };
  const e = estimateNonPersonal(input);
  const p = estimatePersonal(input);
  const sym = CURRENCY_META[ccy]?.symbol ?? ccy;
  const pphPct = `${Number(e.incomeTaxRate) * 100}%`;
  const steps: Step[] = [
    { label: T('Nilai pabean', 'Customs value'), formula: `${sym}${formatDecimalString(unitPrice, lang)} × ${quantity} × Rp ${formatDecimalString(r, lang)}`, amount: e.customsValueIdr },
    { label: T('Bea masuk', 'Import duty'), formula: T('10% · dibulatkan ke atas ribuan', '10% · rounded up to 1,000'), amount: e.dutyIdr },
    { label: T('Nilai impor', 'Import value'), formula: T('nilai pabean + bea masuk', 'customs value + duty'), amount: e.importValueIdr },
    { label: T('PPN impor', 'Import VAT'), formula: '12% × DPP 11/12', amount: e.vatIdr },
    { label: T('PPh 22 impor', 'Income tax art. 22'), formula: `${pphPct}${input.noNpwpScenario ? T(' · skenario tanpa NPWP (belum terverifikasi)', ' · no-NPWP scenario (unverified)') : ''}`, amount: e.incomeTaxIdr },
  ];
  return { e, p, steps, rateUsed: r };
}

async function onSubmit(ev: SubmitEvent) {
  ev.preventDefault();
  if (!out || !currency || !price || !qty || !origin || !category) return;
  errBox && (errBox.hidden = true);
  const ccy = currency.value;
  const unitPrice = price.value.trim().replace(/\s/g, '').replace(',', '.');
  const quantity = Number(qty.value);
  if (!validPrice(unitPrice, ccy)) {
    price.setAttribute('aria-invalid', 'true');
    if (errBox) {
      errBox.hidden = false;
      errBox.textContent = T(`Harga tidak valid untuk ${ccy} (maks. ${CURRENCY_META[ccy]?.minorUnits ?? 2} desimal).`, `Invalid price for ${ccy} (max ${CURRENCY_META[ccy]?.minorUnits ?? 2} decimals).`);
    }
    price.focus();
    return;
  }
  price.removeAttribute('aria-invalid');
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
    if (errBox) { errBox.hidden = false; errBox.textContent = T('Jumlah harus 1–999.', 'Quantity must be 1–999.'); }
    qty.focus();
    return;
  }
  submit?.setAttribute('aria-busy', 'true');
  setStatus('loading', T('Menghitung…', 'Calculating…'));
  try {
    const res = await api<ApiResult>('/v1/customs/estimate', {
      body: {
        originCountry: origin.value,
        destinationCountry: 'ID',
        categoryCode: category.value,
        unitPriceMinor: toMinor(unitPrice, ccy),
        currency: ccy,
        quantity,
        treatment: 'NON_PERSONAL',
        hasNpwp: !noNpwp?.checked,
      },
      timeoutMs: 6000,
    });
    const e = res.estimate;
    setStatus('online', T('Dari API JastipKita', 'From the JastipKita API'));
    out.innerHTML = `${renderTable(e.breakdownSteps, e.totalIdr, e.customsValueIdr)}
      ${e.warnings.length ? `<ul class="res-warn">${e.warnings.map((w) => `<li>${escapeHtml(w.message)}</li>`).join('')}</ul>` : ''}
      ${res.personalComparison ? personalBlock(res.personalComparison.totalIdr, res.personalComparison.exemptionAppliedIdr, res.personalComparison.note) : ''}
      <p class="xsmall muted res-meta">${escapeHtml(res.treatmentExplanation)} ${T('Aturan', 'Rule')}: ${escapeHtml(e.ruleRef ?? e.ruleCode ?? '—')}${e.lastVerifiedAt ? ` · ${T('diverifikasi', 'verified')} ${escapeHtml(e.lastVerifiedAt)}` : ''}. ${T('Kurs', 'Rate')}: ${escapeHtml(res.fx.itemToIdr ?? '—')}${res.fx.source ? ` (${escapeHtml(res.fx.source)}${res.fx.asOf ? `, ${escapeHtml(res.fx.asOf)}` : ''})` : ''}. ${escapeHtml(res.disclaimer)}</p>`;
  } catch (err) {
    if (err instanceof ApiError && err.kind === 'http' && err.status < 500) {
      setStatus('online', T('Dari API JastipKita', 'From the JastipKita API'));
      out.innerHTML = `<div class="note note-error"><p>${escapeHtml(err.message)}</p></div>`;
    } else {
      try {
        const { e, p, steps, rateUsed } = offline(ccy, unitPrice, quantity);
        setStatus('offline', T('Mode offline · rumus lokal', 'Offline mode · local formula'));
        out.innerHTML = `${renderTable(steps, e.totalIdr, e.customsValueIdr)}
          ${personalBlock(p.totalIdr, p.exemptionAppliedIdr, T('Hanya pembanding. Pembebasan FOB USD 500 berlaku per orang per kedatangan untuk barang pribadi traveler, TIDAK untuk barang titipan. Jangan mendeklarasikan titipan sebagai barang pribadi.', 'Comparison only. The FOB USD 500 exemption applies per person per arrival to the traveler’s own goods, NOT to items bought for others. Never declare them as personal goods.'))}
          <p class="xsmall muted res-meta">${escapeHtml(T('API JastipKita belum dapat dihubungi, jadi estimasi dihitung di perangkatmu dengan rumus yang sama', 'The JastipKita API is not reachable yet, so this was computed on your device with the same formula'))} (${escapeHtml(RULE_NON_PERSONAL.code)} v${RULE_NON_PERSONAL.version}, ${escapeHtml(T('diverifikasi', 'verified'))} ${escapeHtml(RULE_NON_PERSONAL.lastVerifiedAt)}). ${escapeHtml(T('Kurs', 'Rate'))}: Rp ${escapeHtml(formatDecimalString(rateUsed, lang))}/${escapeHtml(ccy)}${rateUsed === KMK_RATES.rates[ccy] ? ` (${escapeHtml(KMK_RATES.reference)})` : ` (${escapeHtml(T('diisi manual', 'manual'))})`}.</p>`;
      } catch (e2) {
        setStatus('offline', T('Gagal menghitung', 'Could not calculate'));
        out.innerHTML = `<div class="note note-error"><p>${escapeHtml(e2 instanceof Error ? e2.message : String(e2))}</p></div>`;
      }
    }
  } finally {
    submit?.removeAttribute('aria-busy');
  }
}

if (form) {
  const params = new URLSearchParams(location.search);
  const o = params.get('origin')?.toUpperCase();
  if (o && origin && [...origin.options].some((x) => x.value === o)) origin.value = o;
  const cat = params.get('category')?.toUpperCase();
  if (cat && category && [...category.options].some((x) => x.value === cat)) category.value = cat;
  syncCurrency();
  const pr = params.get('price');
  if (pr && price && /^\d+(\.\d{1,2})?$/.test(pr)) { price.value = pr; price.dataset.touched = '1'; }
  price?.addEventListener('input', () => { if (price) price.dataset.touched = '1'; });
  origin?.addEventListener('change', syncCurrency);
  currency?.addEventListener('change', syncRate);
  form.addEventListener('submit', onSubmit);
}
