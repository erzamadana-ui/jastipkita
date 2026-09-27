/** Trip discovery island — GET /v1/trips (public, no PII). Shows "segera hadir" when the API is unreachable. */
import { api, ApiError, escapeHtml } from '../lib/api.ts';
import { formatIdr } from '../lib/money.ts';

interface Trip {
  id: string; status: string; originCountry: string; originCity: string; destinationCountry: string; destinationCity: string;
  departureDate: string; arrivalDate: string; capacityRemainingKg: number; itemsRemaining: number | null;
  fee: { type: 'FIXED' | 'PERCENT' | 'PER_KG'; value: number; label: string }; excludedCategories: string[]; verified: boolean;
  traveler: {
    displayName: string;
    trustBadge: { tier: string; label: string };
    /** 2026-09-27 contract: Trust Score 0–100 + band, and KYC level (older API builds may omit them). */
    trustScore?: number;
    trustTier?: { tier: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'LOW'; label: string; labelEn: string };
    kycLevel?: number;
    identityVerified: boolean;
    rating: { average: number | null; count: number };
    completedTransactions: number;
  };
}
const TIER_CLASS: Record<string, string> = { EXCELLENT: 'trust-excellent', GOOD: 'trust-good', FAIR: 'trust-fair', LOW: 'trust-low' };
interface Page { data: Trip[]; nextCursor: string | null }

const form = document.querySelector<HTMLFormElement>('#trip-form');
const results = document.querySelector<HTMLDivElement>('#trip-results');
const moreWrap = document.querySelector<HTMLDivElement>('#trip-more-wrap');
const moreBtn = document.querySelector<HTMLButtonElement>('#trip-more');
let cursor: string | null = null;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}
function fee(f: Trip['fee']): string {
  if (f.label) return f.label;
  if (f.type === 'PERCENT') return `${f.value / 100}% harga barang`;
  if (f.type === 'PER_KG') return `${formatIdr(f.value)}/kg`;
  return formatIdr(f.value);
}

function card(t: Trip): string {
  const r = t.traveler.rating;
  const rating = r.average !== null && r.count > 0 ? `★ ${r.average.toFixed(1).replace('.', ',')} (${r.count} ulasan)` : 'Belum ada ulasan';
  return `<article class="card trip-card">
    <div class="trip-route">${escapeHtml(t.originCity)} <span class="muted small">(${escapeHtml(t.originCountry)})</span>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
      ${escapeHtml(t.destinationCity)} <span class="muted small">(${escapeHtml(t.destinationCountry)})</span></div>
    <p class="small muted">Berangkat ${escapeHtml(fmtDate(t.departureDate))} · tiba ${escapeHtml(fmtDate(t.arrivalDate))}</p>
    <div style="display:flex;flex-wrap:wrap;gap:6px">
      ${t.verified ? '<span class="chip chip-success">Trip terverifikasi</span>' : '<span class="chip">Belum terverifikasi</span>'}
      <span class="chip">${escapeHtml(t.traveler.trustBadge.label)}${t.traveler.kycLevel ? ` · KYC ${t.traveler.kycLevel}` : ''}</span>
      ${typeof t.traveler.trustScore === 'number' ? `<span class="chip trust-chip ${TIER_CLASS[t.traveler.trustTier?.tier ?? ''] ?? ''}">Trust ${t.traveler.trustScore}${t.traveler.trustTier ? ` · ${escapeHtml(t.traveler.trustTier.label)}` : ''}</span>` : ''}
    </div>
    <p class="small"><strong>${escapeHtml(t.traveler.displayName)}</strong> · ${escapeHtml(rating)} · ${t.traveler.completedTransactions} transaksi selesai</p>
    <div><div class="small" style="display:flex;justify-content:space-between"><span>Sisa kapasitas</span><span class="tnum">${escapeHtml(String(t.capacityRemainingKg))} kg${t.itemsRemaining !== null ? ` · ${t.itemsRemaining} item` : ''}</span></div></div>
    <p class="small">Fee: <strong>${escapeHtml(fee(t.fee))}</strong></p>
    <a class="btn btn-primary btn-sm" href="../#unduh">Titip lewat aplikasi</a>
  </article>`;
}

function showTemplate(id: string) {
  const tpl = document.querySelector<HTMLTemplateElement>(id);
  if (results && tpl) {
    results.innerHTML = '';
    results.appendChild(tpl.content.cloneNode(true));
    results.classList.add('single');
  }
}

async function load(append = false) {
  if (!results || !form) return;
  const fd = new FormData(form);
  results.setAttribute('aria-busy', 'true');
  try {
    const page = await api<Page>('/v1/trips', {
      query: {
        limit: 12,
        cursor: append ? cursor : undefined,
        originCountry: String(fd.get('originCountry') ?? ''),
        destinationCountry: 'ID',
        destinationCity: String(fd.get('destinationCity') ?? '').trim(),
        arrivalBy: String(fd.get('arrivalBy') ?? ''),
        categoryCode: String(fd.get('categoryCode') ?? ''),
        verifiedOnly: fd.get('verifiedOnly') ? 'true' : 'false',
      },
      timeoutMs: 7000,
    });
    cursor = page.nextCursor;
    if (!append && page.data.length === 0) showTemplate('#trip-empty');
    else {
      results.classList.remove('single');
      const html = page.data.map(card).join('');
      results.innerHTML = append ? results.innerHTML + html : html;
    }
    if (moreWrap) moreWrap.hidden = !cursor;
  } catch (e) {
    if (e instanceof ApiError && e.kind === 'http' && e.status === 400) {
      results.innerHTML = `<div class="note note-error"><p>${escapeHtml(e.message)}</p></div>`;
    } else {
      showTemplate('#trip-unavailable');
    }
    if (moreWrap) moreWrap.hidden = true;
  } finally {
    results.setAttribute('aria-busy', 'false');
  }
}

const params = new URLSearchParams(location.search);
const origin = params.get('origin')?.toUpperCase();
const sel = document.querySelector<HTMLSelectElement>('#f-origin');
if (origin && sel && [...sel.options].some((o) => o.value === origin)) sel.value = origin;
form?.addEventListener('submit', (e) => { e.preventDefault(); cursor = null; void load(false); });
moreBtn?.addEventListener('click', () => void load(true));
void load(false);
