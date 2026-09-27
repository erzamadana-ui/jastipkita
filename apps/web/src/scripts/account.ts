/** /akun/: GET /v1/me, privacy export, delete-account (14-day grace) and cancel-deletion. */
import { api, ApiError, describeError, escapeHtml, session } from '../lib/api.ts';

interface Profile {
  id: string; email: string | null; phone: string | null; displayName: string | null; kycLevel: number; trustScore: number;
  activeMode: 'BUYER' | 'TRAVELER'; referralCode: string; status: string; deletionScheduledFor: string | null; createdAt: string;
}
const KYC = ['', 'Terdaftar', 'HP terverifikasi', 'Identitas terverifikasi', 'Traveler terverifikasi', 'Trusted Traveler'];
const $ = <E extends HTMLElement>(s: string) => document.querySelector<E>(s);
const fmt = (iso: string) => new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' }) + ' WIB';

function mask(p: Profile): string {
  if (p.email) { const [u = '', d = ''] = p.email.split('@'); return `${u.slice(0, 2)}${'•'.repeat(Math.max(1, u.length - 2))}@${d}`; }
  if (p.phone) return `${p.phone.slice(0, 5)}•••${p.phone.slice(-3)}`;
  return '—';
}
function showError(msg: string) {
  const box = $<HTMLDivElement>('#acc-error');
  if (!box) return;
  box.hidden = false;
  const p = box.querySelector('p');
  if (p) p.textContent = msg;
}
function setPending(date: string | null) {
  const box = $<HTMLDivElement>('#acc-pending');
  const del = $<HTMLElement>('#hapus');
  if (!box) return;
  box.hidden = !date;
  if (del) del.hidden = !!date;
  const t = $<HTMLParagraphElement>('#acc-pending-text');
  if (t && date) t.textContent = `Akun dijadwalkan terhapus pada ${fmt(date)}. Selama masa tenggang, fitur lain dinonaktifkan.`;
}

async function load() {
  if (!session.getAccessToken()) { $('#acc-signed-out')!.hidden = false; return; }
  try {
    const p = await api<Profile>('/v1/me', { auth: true });
    $('#acc-signed-in')!.hidden = false;
    const name = p.displayName || 'Pengguna JastipKita';
    $('#acc-name')!.textContent = name;
    $('#acc-initials')!.textContent = name.split(/\s+/).map((w) => w[0] ?? '').join('').slice(0, 2).toUpperCase();
    $('#acc-contact')!.textContent = mask(p);
    const kyc = $<HTMLSpanElement>('#acc-kyc')!;
    kyc.className = `kyc-badge kyc-${Math.min(5, Math.max(1, p.kycLevel))}`;
    kyc.lastElementChild!.textContent = `Level ${p.kycLevel} · ${KYC[p.kycLevel] ?? ''}`;
    $('#acc-trust')!.textContent = String(p.trustScore);
    $('#acc-mode')!.textContent = p.activeMode === 'TRAVELER' ? 'Traveler' : 'Penitip';
    $('#acc-ref')!.textContent = p.referralCode;
    $('#acc-since')!.textContent = new Date(p.createdAt).toLocaleDateString('id-ID', { dateStyle: 'medium' });
    setPending(p.deletionScheduledFor);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { session.clear(); $('#acc-signed-out')!.hidden = false; return; }
    $('#acc-signed-out')!.hidden = false;
    showError(describeError(e));
  }
}

$('#acc-logout')?.addEventListener('click', async () => {
  try { await api('/v1/auth/logout', { method: 'POST', auth: true, body: {} }); } catch { /* ignore */ }
  session.clear();
  location.reload();
});

$('#acc-export')?.addEventListener('click', async () => {
  const msg = $('#acc-export-msg');
  try {
    await api('/v1/privacy/export', { method: 'POST', auth: true, body: {} });
    if (msg) msg.textContent = 'Permintaan diterima. Kami memberi tahu kamu saat file siap (maks. 3×24 jam sesuai UU PDP).';
  } catch (e) {
    if (msg) msg.textContent = describeError(e);
  }
});

const form = $<HTMLFormElement>('#del-form');
const dialog = $<HTMLDialogElement>('#del-dialog');
form?.addEventListener('submit', (e) => {
  e.preventDefault();
  const err = $<HTMLDivElement>('#del-error');
  if (err) err.hidden = true;
  if (!(form.elements.namedItem('confirm') as HTMLInputElement).checked) {
    if (err) { err.hidden = false; err.textContent = 'Centang pernyataan konfirmasi terlebih dahulu.'; }
    return;
  }
  if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
  else void doDelete();
});
dialog?.addEventListener('close', () => { if (dialog.returnValue === 'confirm') void doDelete(); });

async function doDelete() {
  const err = $<HTMLDivElement>('#del-error');
  const reason = ($<HTMLTextAreaElement>('#del-reason')?.value ?? '').trim();
  try {
    const res = await api<{ effectiveAt: string }>('/v1/privacy/delete-account', { auth: true, body: { confirm: true, ...(reason ? { reason } : {}) } });
    setPending(res.effectiveAt);
  } catch (e) {
    if (!err) return;
    err.hidden = false;
    if (e instanceof ApiError && e.code === 'DELETION_BLOCKED') {
      const d = e.details as Record<string, unknown>;
      const parts = Object.entries(d).filter(([, v]) => Number(v) > 0 || v === true).map(([k, v]) => `${k}: ${String(v)}`);
      err.innerHTML = `${escapeHtml(e.message)}${parts.length ? ` <span class="xsmall">(${escapeHtml(parts.join(', '))})</span>` : ''}`;
    } else err.textContent = describeError(e);
  }
}

$('#acc-cancel')?.addEventListener('click', async () => {
  try {
    await api('/v1/privacy/cancel-deletion', { method: 'POST', auth: true, body: {} });
    setPending(null);
  } catch (e) { showError(describeError(e)); }
});

void load();
