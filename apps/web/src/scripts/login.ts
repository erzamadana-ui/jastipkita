/** OTP login (POST /v1/auth/otp/request → /v1/auth/otp/verify). Tokens kept in sessionStorage only. */
import { api, ApiError, describeError, LEGAL_CONSENT_VERSION, session } from '../lib/api.ts';

interface Challenge { challengeId: string; expiresAt: string; resendAvailableAt: string }
interface VerifyResult { tokens?: { accessToken: string; accessTokenExpiresAt: string }; isNewUser?: boolean }

const req = document.querySelector<HTMLFormElement>('#otp-request');
const ver = document.querySelector<HTMLFormElement>('#otp-verify');
const dest = document.querySelector<HTMLInputElement>('#destination');
const destLabel = document.querySelector<HTMLLabelElement>('#dest-label');
const reqErr = document.querySelector<HTMLDivElement>('#req-error');
const verErr = document.querySelector<HTMLDivElement>('#ver-error');
const consents = document.querySelector<HTMLFieldSetElement>('#consents');
let challenge: Challenge | null = null;

function next(): string {
  const n = new URLSearchParams(location.search).get('next') ?? '';
  // Only allow same-site relative paths under the site base.
  return /^\/jastipkita\/[a-z0-9/_-]*$/i.test(n) ? n : location.pathname.replace(/masuk\/?$/, 'akun/');
}
function showErr(el: HTMLElement | null, msg: string) { if (el) { el.hidden = false; el.textContent = msg; } }

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
  if (reqErr) reqErr.hidden = true;
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
    const sent = document.querySelector('#sent-to');
    if (sent) sent.textContent = `Kode dikirim ke ${destination}. Berlaku sampai ${new Date(challenge.expiresAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}.`;
    document.querySelector<HTMLInputElement>('#code')?.focus();
  } catch (err) {
    showErr(reqErr, describeError(err));
  }
});

document.querySelector('#restart')?.addEventListener('click', () => {
  if (ver) ver.hidden = true;
  if (req) req.hidden = false;
  if (consents) consents.hidden = true;
  challenge = null;
  dest?.focus();
});

ver?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (verErr) verErr.hidden = true;
  if (!challenge) return;
  const fd = new FormData(ver);
  const code = String(fd.get('code') ?? '').trim();
  if (!/^\d{6}$/.test(code)) return showErr(verErr, 'Masukkan 6 digit kode.');
  const body: Record<string, unknown> = {
    challengeId: challenge.challengeId,
    code,
    device: { platform: 'WEB', fingerprint: session.deviceId() },
  };
  if (consents && !consents.hidden) {
    if (!fd.get('tos') || !fd.get('privacy')) return showErr(verErr, 'Centang Syarat & Ketentuan dan Kebijakan Privasi untuk membuat akun.');
    body.consents = [
      { type: 'TOS', version: LEGAL_CONSENT_VERSION, granted: true },
      { type: 'PRIVACY', version: LEGAL_CONSENT_VERSION, granted: true },
      { type: 'MARKETING', version: LEGAL_CONSENT_VERSION, granted: !!fd.get('marketing') },
    ];
  }
  try {
    const res = await api<VerifyResult>('/v1/auth/otp/verify', { body });
    if (res.tokens) session.save(res.tokens);
    location.assign(next());
  } catch (err) {
    if (err instanceof ApiError && err.code === 'CONSENT_REQUIRED' && consents) {
      consents.hidden = false;
      showErr(verErr, 'Kamu pengguna baru. Setujui dokumen di atas lalu tekan Verifikasi lagi (kode yang sama tetap berlaku).');
      consents.querySelector<HTMLInputElement>('input')?.focus();
      return;
    }
    showErr(verErr, describeError(err));
  }
});

// Optional Google sign-in (only rendered when PUBLIC_ENABLE_GOOGLE_LOGIN=true). Loads GIS lazily on click.
const gBtn = document.querySelector<HTMLButtonElement>('#google-btn');
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
        try {
          const res = await api<VerifyResult>('/v1/auth/google', { body: { idToken: resp.credential, device: { platform: 'WEB', fingerprint: session.deviceId() } } });
          if (res.tokens) session.save(res.tokens);
          location.assign(next());
        } catch (err) {
          showErr(reqErr, err instanceof ApiError && err.code === 'CONSENT_REQUIRED' ? 'Akun baru: silakan daftar lewat kode OTP terlebih dahulu untuk menyetujui dokumen legal.' : describeError(err));
        }
      },
    });
    g?.accounts.id.prompt();
  };
  document.head.appendChild(s);
});
