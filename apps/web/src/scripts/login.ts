/**
 * OTP login (POST /v1/auth/otp/request → /v1/auth/otp/verify) + optional Google sign-in.
 * New accounts must send signup consents with the EXACT versions the API accepts:
 *   - versions come from GET /v1/consents/requirements (fallback: docs/legal front-matter embedded at build time);
 *   - 422 CONSENT_REQUIRED → show the consent step (the OTP code is not consumed, the same code is re-submitted);
 *   - 422 CONSENT_VERSION_INVALID → re-fetch requirements once (or use details.allowedVersions) and retry once.
 * Tokens are kept in sessionStorage only.
 */
import { api, ApiError, describeError, escapeHtml, session } from '../lib/api.ts';
import { applyAllowedVersions, loadSignupRequirements, readFallback, toConsentInputs, type SignupRequirements } from '../lib/consents.ts';
import type { LegalType } from '../lib/legal-catalog.ts';

interface Challenge { challengeId: string; expiresAt: string; resendAvailableAt: string }
interface LoginResult { tokens?: { accessToken: string; accessTokenExpiresAt: string }; isNewUser?: boolean }

const $ = <E extends HTMLElement>(s: string) => document.querySelector<E>(s);
const req = $<HTMLFormElement>('#otp-request');
const ver = $<HTMLFormElement>('#otp-verify');
const consentForm = $<HTMLFormElement>('#consent-form');
const consentList = $<HTMLDivElement>('#consent-list');
const consentSource = $<HTMLParagraphElement>('#consent-source');
const dest = $<HTMLInputElement>('#destination');
const destLabel = $<HTMLLabelElement>('#dest-label');
const reqErr = $<HTMLDivElement>('#req-error');
const verErr = $<HTMLDivElement>('#ver-error');
const consentErr = $<HTMLDivElement>('#consent-error');
const fallback = readFallback($('#consent-fallback'));

let challenge: Challenge | null = null;
let requirements: SignupRequirements | null = null;
/** What to re-run once consents are given: the OTP verify or a Google credential sign-in. */
let pending: { kind: 'otp'; code: string } | { kind: 'google'; idToken: string } | null = null;

function next(): string {
  const n = new URLSearchParams(location.search).get('next') ?? '';
  // Only allow same-site relative paths under the site base.
  return /^\/jastipkita\/[a-z0-9/_-]*$/i.test(n) ? n : location.pathname.replace(/masuk\/?$/, 'akun/');
}
function showErr(el: HTMLElement | null, msg: string) { if (el) { el.hidden = false; el.textContent = msg; } }
function hideErr(el: HTMLElement | null) { if (el) el.hidden = true; }
function device() { return { platform: 'WEB', fingerprint: session.deviceId() }; }

function renderConsents(r: SignupRequirements) {
  if (!consentList) return;
  const prev = new Map([...consentList.querySelectorAll<HTMLInputElement>('input[data-consent-type]')].map((i) => [i.dataset.consentType, i.checked]));
  consentList.innerHTML = r.items
    .map((i) => {
      const lead = i.required ? 'Saya menyetujui ' : i.type === 'MARKETING' ? 'Saya bersedia menerima kabar promo & produk sesuai ' : 'Saya menyetujui ';
      const tail = i.required ? ' — wajib' : ' — opsional, bisa dicabut kapan saja';
      return `<label class="check"><input type="checkbox" data-consent-type="${escapeHtml(i.type)}" data-required="${i.required}"${prev.get(i.type) ? ' checked' : ''} />
        <span>${lead}<a href="${escapeHtml(i.url)}" target="_blank" rel="noopener">${escapeHtml(i.title)}</a> <span class="xsmall muted" data-consent-version>${i.version ? `(versi ${escapeHtml(i.version)})` : ''}</span>${tail}</span></label>`;
    })
    .join('');
  if (consentSource) {
    consentSource.textContent = r.source === 'api'
      ? 'Versi dokumen sesuai yang berlaku di server JastipKita.'
      : 'Server belum dapat dihubungi — versi dokumen diambil dari salinan situs.';
  }
}

async function showConsentStep(missingMsg?: string) {
  requirements = await loadSignupRequirements(fallback);
  renderConsents(requirements);
  if (consentForm) consentForm.hidden = false;
  if (ver) ver.hidden = true;
  if (req) req.hidden = true;
  showErr(consentErr, missingMsg ?? 'Kamu pengguna baru. Setujui dokumen wajib di atas untuk membuat akun.');
  consentList?.querySelector<HTMLInputElement>('input')?.focus();
}

function grantedMap(): { granted: Partial<Record<LegalType, boolean>>; missingRequired: boolean } {
  const granted: Partial<Record<LegalType, boolean>> = {};
  let missingRequired = false;
  consentList?.querySelectorAll<HTMLInputElement>('input[data-consent-type]').forEach((i) => {
    granted[i.dataset.consentType as LegalType] = i.checked;
    if (i.dataset.required === 'true' && !i.checked) missingRequired = true;
  });
  return { granted, missingRequired };
}

async function run(consents?: ReturnType<typeof toConsentInputs>): Promise<LoginResult> {
  if (!pending) throw new Error('nothing pending');
  if (pending.kind === 'otp') {
    return api<LoginResult>('/v1/auth/otp/verify', {
      body: { challengeId: challenge?.challengeId, code: pending.code, device: device(), ...(consents ? { consents } : {}) },
    });
  }
  return api<LoginResult>('/v1/auth/google', { body: { idToken: pending.idToken, device: device(), ...(consents ? { consents } : {}) } });
}

function done(res: LoginResult) {
  if (res.tokens) session.save(res.tokens);
  location.assign(next());
}

/** First attempt without consents (existing users don't need them). */
async function attempt(errBox: HTMLElement | null) {
  try {
    done(await run());
  } catch (err) {
    if (err instanceof ApiError && err.code === 'CONSENT_REQUIRED') return showConsentStep();
    showErr(errBox, describeError(err));
  }
}

// ---- OTP request ----
req?.querySelectorAll<HTMLInputElement>('input[name=channel]').forEach((r) =>
  r.addEventListener('change', () => {
    if (!dest || !destLabel) return;
    const email = r.value === 'EMAIL';
    destLabel.textContent = email ? 'Alamat e-mail' : 'Nomor HP';
    dest.type = email ? 'email' : 'tel';
    dest.autocomplete = email ? 'email' : 'tel';
    dest.inputMode = email ? 'email' : 'tel';
    dest.placeholder = email ? 'nama@email.com' : '+62 812 3456 7890';
  }),
);

req?.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideErr(reqErr);
  const channel = (new FormData(req).get('channel') as string) || 'EMAIL';
  let destination = (dest?.value ?? '').trim();
  if (channel !== 'EMAIL') {
    destination = destination.replace(/[\s-]/g, '');
    if (destination.startsWith('08')) destination = `+62${destination.slice(1)}`;
    if (!/^\+?\d{9,15}$/.test(destination)) return showErr(reqErr, 'Nomor HP tidak valid. Contoh: +6281234567890');
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destination)) {
    return showErr(reqErr, 'Alamat e-mail tidak valid.');
  }
  try {
    challenge = await api<Challenge>('/v1/auth/otp/request', { body: { channel, destination, purpose: 'LOGIN', locale: 'id' } });
    req.hidden = true;
    if (ver) ver.hidden = false;
    const sent = $('#sent-to');
    if (sent) sent.textContent = `Kode dikirim ke ${destination}. Berlaku sampai ${new Date(challenge.expiresAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}.`;
    $<HTMLInputElement>('#code')?.focus();
  } catch (err) {
    showErr(reqErr, describeError(err));
  }
});

$('#restart')?.addEventListener('click', () => {
  if (ver) ver.hidden = true;
  if (consentForm) consentForm.hidden = true;
  if (req) req.hidden = false;
  challenge = null;
  pending = null;
  dest?.focus();
});

// ---- OTP verify ----
ver?.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideErr(verErr);
  if (!challenge) return;
  const code = String(new FormData(ver).get('code') ?? '').trim();
  if (!/^\d{6}$/.test(code)) return showErr(verErr, 'Masukkan 6 digit kode.');
  pending = { kind: 'otp', code };
  await attempt(verErr);
});

// ---- Consent step (new accounts) ----
consentForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideErr(consentErr);
  if (!pending) return;
  const { granted, missingRequired } = grantedMap();
  if (missingRequired) return showErr(consentErr, 'Centang semua dokumen yang wajib untuk membuat akun.');
  requirements ??= await loadSignupRequirements(fallback);
  const btn = $<HTMLButtonElement>('#consent-btn');
  btn?.setAttribute('aria-busy', 'true');
  try {
    done(await run(toConsentInputs(requirements, granted)));
  } catch (err) {
    if (err instanceof ApiError && err.code === 'CONSENT_VERSION_INVALID') {
      // The published legal version changed (or our fallback was stale): refresh once, then retry once.
      const refreshed = await loadSignupRequirements(fallback, true);
      applyAllowedVersions(refreshed, err.details);
      requirements = refreshed;
      renderConsents(refreshed);
      try {
        done(await run(toConsentInputs(refreshed, granted)));
        return;
      } catch (err2) {
        showErr(consentErr, describeError(err2));
        return;
      }
    }
    if (err instanceof ApiError && err.code === 'CONSENT_REQUIRED') {
      // Server requires a document we did not show (requirements changed): reload the list for the user.
      requirements = await loadSignupRequirements(fallback, true);
      renderConsents(requirements);
      showErr(consentErr, 'Daftar dokumen yang wajib disetujui telah diperbarui. Periksa lalu lanjutkan.');
      return;
    }
    showErr(consentErr, describeError(err));
  } finally {
    btn?.removeAttribute('aria-busy');
  }
});

// ---- Optional Google sign-in (only rendered when PUBLIC_ENABLE_GOOGLE_LOGIN=true). GIS loads lazily on click. ----
const gBtn = $<HTMLButtonElement>('#google-btn');
gBtn?.addEventListener('click', () => {
  const clientId = gBtn.dataset.clientId;
  if (!clientId) return;
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = () => {
    const g = (window as unknown as { google?: { accounts: { id: { initialize: (o: unknown) => void; prompt: () => void } } } }).google;
    g?.accounts.id.initialize({
      client_id: clientId,
      callback: async (resp: { credential: string }) => {
        pending = { kind: 'google', idToken: resp.credential };
        await attempt(reqErr);
      },
    });
    g?.accounts.id.prompt();
  };
  document.head.appendChild(s);
});
