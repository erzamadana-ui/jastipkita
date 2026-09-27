/**
 * Admin sign-in: e-mail OTP (POST /v1/auth/otp/request → /verify) → TOTP enrolment on first login
 * (POST /v1/auth/mfa/totp/enroll → QR of the otpauth URI rendered locally → /confirm → recovery codes shown once)
 * or TOTP verification (POST /v1/auth/mfa/verify). Access token stays in memory; refresh token in sessionStorage.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Auth } from '../api/admin';
import { describeError } from '../api/errors';
import { newIdempotencyKey } from '../api/idempotency';
import { session } from '../api/session';
import type { Schemas } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { clearOtpLogin, enrollmentIssue, enrollSecondsLeft, markOtpLogin, type EnrollmentIssue } from '../auth/enrollment';
import { useNow } from '../hooks/misc';
import { Icon } from '../components/Icon';
import { QrCode } from '../components/QrCode';
import { Button, Callout, Checkbox, Field } from '../components/ui';
import { ENV } from '../env';
import { isDark } from '../lib/theme';

const BASE = import.meta.env.BASE_URL;

function deviceFingerprint(): string {
  try {
    const k = 'jk_admin_device';
    let v = window.localStorage.getItem(k);
    if (!v) {
      v = `admin-web-${newIdempotencyKey()}`;
      window.localStorage.setItem(k, v);
    }
    return v;
  } catch {
    return `admin-web-${newIdempotencyKey()}`;
  }
}

function Frame({ children, title, subtitle }: { children: ReactNode; title: string; subtitle?: ReactNode }) {
  return (
    <div className="login">
      <aside className="login__brand" aria-hidden="false">
        <img src={`${BASE}logo-horizontal-dark.svg`} alt="JastipKita" width={200} height={49} />
        <div className="stack">
          <h1>Back office JastipKita</h1>
          <p>Titip Mudah, Aman, Terpercaya. Konsol ini memindahkan uang dan data pribadi pengguna — setiap aksi sensitif memerlukan MFA dan tercatat di audit log berantai hash.</p>
          <ul style={{ paddingLeft: 18, margin: 0 }}>
            <li>Login e-mail OTP + TOTP (RFC 6238)</li>
            <li>Maker-checker untuk uang, konfigurasi, dan hak akses</li>
            <li>PII dimasking; buka data hanya dengan alasan</li>
          </ul>
        </div>
        <small>Lingkungan: {ENV.appEnv} · API {ENV.apiBaseUrl.replace(/^https?:\/\//, '')}</small>
      </aside>
      <main className="login__panel" id="main">
        <div className="login__card stack stack--lg">
          <div className="stack stack--sm">
            <img src={`${BASE}${isDark() ? 'logo-symbol-dark.svg' : 'logo-symbol.svg'}`} alt="" width={44} height={44} />
            <h1 style={{ fontSize: 'var(--jk-type-headline-s-size)' }}>{title}</h1>
            {subtitle ? <p className="muted">{subtitle}</p> : null}
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}

// ------------------------------------------------------------------ step 1: e-mail OTP

export function LoginPage() {
  const { snapshot } = useAuth();
  const [email, setEmail] = useState('');
  const [challenge, setChallenge] = useState<Schemas['OtpChallenge'] | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!challenge) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    codeRef.current?.focus();
    return () => clearInterval(t);
  }, [challenge]);

  const request = async () => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setErr('Masukkan alamat e-mail yang valid.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      setChallenge(await Auth.requestOtp(email));
      setCode('');
    } catch (e) {
      setErr(describeError(e).title);
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!challenge || !/^\d{6}$/.test(code)) {
      setErr('Kode OTP terdiri dari 6 digit.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await Auth.verifyOtp(challenge.challengeId, code, deviceFingerprint());
      if (!r.tokens) throw new Error('Respons login tidak berisi token.');
      markOtpLogin();
      session.setTokens(r.tokens);
    } catch (e) {
      setErr(describeError(e).title);
    } finally {
      setBusy(false);
    }
  };

  const resendIn = challenge ? Math.max(0, Math.ceil((Date.parse(challenge.resendAvailableAt) - now) / 1000)) : 0;
  const expiresIn = challenge ? Math.max(0, Math.ceil((Date.parse(challenge.expiresAt) - now) / 1000)) : 0;

  return (
    <Frame title="Masuk ke Admin" subtitle="Gunakan e-mail akun staf yang sudah diberi peran admin.">
      {snapshot.endReason === 'EXPIRED' ? <Callout tone="warning">Sesi berakhir (token kedaluwarsa atau dicabut). Silakan masuk lagi.</Callout> : null}
      {!challenge ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void request();
          }}
        >
          <Field label="E-mail kerja" error={err} required>
            <input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="login-email" />
          </Field>
          <Button variant="primary" type="submit" loading={busy} data-testid="login-request">
            Kirim kode OTP
          </Button>
        </form>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void verify();
          }}
        >
          <Callout tone="info">
            Kode 6 digit dikirim ke <strong>{email}</strong>. Berlaku {Math.floor(expiresIn / 60)}:{String(expiresIn % 60).padStart(2, '0')}.
          </Callout>
          {challenge.devCode ? (
            <Callout tone="warning" title="Mode pengembangan:">
              OTP_DEV_ECHO aktif — kode <code>{challenge.devCode}</code> (tidak pernah muncul di staging/produksi).
            </Callout>
          ) : null}
          <Field label="Kode OTP" error={err} required>
            <input ref={codeRef} className="input otp-input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} data-testid="login-code" />
          </Field>
          <Button variant="primary" type="submit" loading={busy} data-testid="login-verify">
            Verifikasi & masuk
          </Button>
          <div className="row row--between small">
            <Button variant="ghost" size="sm" onClick={() => setChallenge(null)}>
              Ganti e-mail
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void request()} disabledReason={resendIn > 0 ? `Kirim ulang dalam ${resendIn} dtk` : null}>
              Kirim ulang {resendIn > 0 ? `(${resendIn})` : ''}
            </Button>
          </div>
        </form>
      )}
    </Frame>
  );
}

// ------------------------------------------------------------------ step 2a: TOTP enrolment

export function MfaEnrollPage() {
  const { passGate, reloadMe, logout, me } = useAuth();
  const [enrollment, setEnrollment] = useState<Schemas['MfaEnrollment'] | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [issue, setIssue] = useState<EnrollmentIssue | null>(null);
  const now = useNow(1000);
  const left = enrollSecondsLeft(now);

  const fail = (e: unknown) => {
    const i = enrollmentIssue(e);
    if (i) {
      setIssue(i);
      setErr(null);
      if (i.action === 'reload') void reloadMe();
    } else setErr(describeError(e).title);
  };

  const relogin = () => {
    clearOtpLogin();
    void logout();
  };

  const start = async () => {
    setBusy(true);
    setErr(null);
    setIssue(null);
    try {
      setEnrollment(await Auth.enrollTotp());
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!/^\d{6}$/.test(code)) {
      setErr('Masukkan 6 digit kode dari aplikasi authenticator.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await Auth.confirmTotp(code);
      session.setAccessToken(r.accessToken, r.accessTokenExpiresAt, r.mfaAt);
      clearOtpLogin();
      setCodes(r.recoveryCodes);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (codes) {
    return (
      <Frame title="Simpan kode pemulihan" subtitle="Ditampilkan sekali. Simpan di password manager tim — bukan di chat atau dokumen bersama.">
        <ol className="secret" style={{ columns: 2, paddingLeft: 28, margin: 0 }} data-testid="recovery-codes">
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ol>
        <Checkbox checked={saved} onChange={setSaved} label="Saya sudah menyimpan kode pemulihan di tempat aman." />
        <Button
          variant="primary"
          disabledReason={saved ? null : 'Konfirmasi dulu bahwa kode sudah disimpan'}
          onClick={() => {
            passGate();
            void reloadMe();
          }}
        >
          Lanjut ke dashboard
        </Button>
      </Frame>
    );
  }

  return (
    <Frame title="Aktifkan MFA (TOTP)" subtitle={`Wajib untuk semua admin. Akun: ${me?.email ?? '—'}`}>
      {issue ? (
        <Callout tone={issue.action === 'wait' ? 'warning' : 'danger'} title={issue.title}>
          <span data-testid="enroll-issue">{issue.detail}</span>
          {issue.action === 'relogin' ? (
            <div style={{ marginTop: 10 }}>
              <Button size="sm" variant="primary" icon="refresh" onClick={relogin} data-testid="enroll-relogin">
                Masuk ulang dengan OTP
              </Button>
            </div>
          ) : null}
        </Callout>
      ) : left !== null ? (
        left > 0 ? (
          <Callout tone="info" icon="clock">
            Selesaikan aktivasi dalam <strong data-testid="enroll-window">{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</strong> — aktivasi hanya diterima dari sesi login OTP yang berumur ≤ 15 menit.
          </Callout>
        ) : (
          <Callout tone="warning" title="Jendela aktivasi 15 menit sudah lewat">
            Masuk ulang dengan OTP lalu langsung aktivasi.
            <div style={{ marginTop: 10 }}>
              <Button size="sm" variant="primary" icon="refresh" onClick={relogin}>
                Masuk ulang dengan OTP
              </Button>
            </div>
          </Callout>
        )
      ) : (
        <Callout tone="info" icon="clock">Aktivasi hanya diterima dari sesi login OTP yang berumur ≤ 15 menit. Jika ditolak, masuk ulang dengan OTP.</Callout>
      )}
      {!enrollment ? (
        <div className="stack">
          <Callout tone="info">Pindai QR dengan aplikasi authenticator (Google Authenticator, 1Password, Authy, …). QR dibuat di browser ini; secret tidak dikirim ke layanan lain.</Callout>
          {err ? <Callout tone="danger">{err}</Callout> : null}
          <Button variant="primary" onClick={() => void start()} loading={busy} icon="shield">
            Mulai aktivasi
          </Button>
          <Button variant="ghost" onClick={() => void logout()}>
            Keluar
          </Button>
        </div>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void confirm();
          }}
        >
          <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
            <QrCode value={enrollment.otpauthUri} size={184} label={`QR kode TOTP untuk ${enrollment.issuer}`} />
            <div className="stack stack--sm" style={{ flex: 1, minWidth: 160 }}>
              <span className="small muted">Tidak bisa memindai? Masukkan secret manual:</span>
              <div className="secret" data-testid="totp-secret">
                {enrollment.secret.replace(/(.{4})/g, '$1 ').trim()}
              </div>
              <span className="small muted">
                SHA-1 · 6 digit · 30 detik · issuer {enrollment.issuer}
              </span>
            </div>
          </div>
          <Field label="Kode dari aplikasi" error={err} required>
            <input className="input otp-input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} data-testid="enroll-code" />
          </Field>
          <Button variant="primary" type="submit" loading={busy}>
            Konfirmasi
          </Button>
        </form>
      )}
    </Frame>
  );
}

// ------------------------------------------------------------------ step 2b: TOTP verification at sign-in

export function MfaVerifyPage() {
  const { passGate, logout, me } = useAuth();
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await Auth.verifyMfa(recovery ? { recoveryCode: code.trim() } : { code });
      session.setAccessToken(r.accessToken, r.accessTokenExpiresAt, r.mfaAt);
      passGate();
    } catch (e) {
      setErr(describeError(e).title);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Frame title="Verifikasi TOTP" subtitle={`Masuk sebagai ${me?.email ?? '—'}`}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label={recovery ? 'Kode pemulihan' : 'Kode TOTP'} error={err} required>
          <input
            className={recovery ? 'input input--code' : 'input otp-input'}
            inputMode={recovery ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(recovery ? e.target.value : e.target.value.replace(/\D/g, '').slice(0, 6))}
            data-testid="login-totp"
            autoFocus
          />
        </Field>
        <Button variant="primary" type="submit" loading={busy} icon="shield" data-testid="login-totp-submit">
          Verifikasi
        </Button>
        <p className="small muted" style={{ margin: 0 }} data-testid="mfa-lost-help">
          Kehilangan authenticator? Pakai kode pemulihan. Jika tidak punya, minta admin pemegang <code>rbac.manage</code> mengajukan <strong>reset MFA</strong> —
          berlaku setelah disetujui SUPER_ADMIN lain; setelah itu masuk dengan OTP dan daftarkan authenticator baru dalam 15 menit.
        </p>
        <div className="row row--between">
          <Button variant="ghost" size="sm" onClick={() => setRecovery((r) => !r)}>
            {recovery ? 'Pakai kode TOTP' : 'Pakai kode pemulihan'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void logout()} icon="logout">
            Keluar
          </Button>
        </div>
      </form>
    </Frame>
  );
}

export function NotAdminPage() {
  const { logout, me } = useAuth();
  return (
    <Frame title="Bukan akun admin" subtitle={me?.email ?? undefined}>
      <Callout tone="danger" icon="ban">
        Akun ini tidak memiliki peran admin. Minta SUPER_ADMIN memberikan peran lewat menu Peran & akses (peran istimewa memerlukan persetujuan admin kedua).
      </Callout>
      <Button onClick={() => void logout()} icon="logout">
        Keluar
      </Button>
    </Frame>
  );
}

export function SessionErrorPage() {
  const { logout, reloadMe } = useAuth();
  return (
    <Frame title="Tidak dapat memuat profil">
      <Callout tone="danger">
        <Icon name="alert" /> API tidak merespons. Periksa koneksi / status layanan.
      </Callout>
      <div className="row">
        <Button onClick={() => void reloadMe()} icon="refresh">
          Coba lagi
        </Button>
        <Button variant="ghost" onClick={() => void logout()}>
          Keluar
        </Button>
      </div>
    </Frame>
  );
}
