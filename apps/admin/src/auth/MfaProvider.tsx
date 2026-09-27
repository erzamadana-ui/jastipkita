/**
 * TOTP step-up dialog. Registered as the global step-up handler (api/mfa.ts): any call that fails with
 * MFA_REQUIRED opens this dialog; on success the new access token (same session, fresh `mfa_at`) is stored and the
 * original call is replayed by withStepUp (same Idempotency-Key for financial calls).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Auth } from '../api/admin';
import { describeError } from '../api/errors';
import { registerStepUpHandler } from '../api/mfa';
import { session } from '../api/session';
import { Dialog } from '../components/Overlay';
import { Button, Callout, Field } from '../components/ui';

export function MfaProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const handler = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        resolver.current = resolve;
        setOpen(true);
      }),
    [],
  );

  useEffect(() => registerStepUpHandler(handler), [handler]);

  const finish = (ok: boolean) => {
    setOpen(false);
    const r = resolver.current;
    resolver.current = null;
    r?.(ok);
  };

  return (
    <>
      {children}
      <StepUpDialog open={open} onDone={finish} />
    </>
  );
}

export function StepUpDialog({ open, onDone, title = 'Verifikasi MFA diperlukan' }: { open: boolean; onDone: (ok: boolean) => void; title?: string }) {
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setCode('');
      setErr(null);
      setRecovery(false);
    }
  }, [open]);

  const submit = async () => {
    const v = code.trim();
    if (!recovery && !/^\d{6}$/.test(v)) {
      setErr('Masukkan 6 digit kode dari aplikasi authenticator.');
      return;
    }
    if (recovery && v.length < 6) {
      setErr('Masukkan kode pemulihan lengkap.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await Auth.verifyMfa(recovery ? { recoveryCode: v } : { code: v });
      session.setAccessToken(r.accessToken, r.accessTokenExpiresAt, r.mfaAt);
      onDone(true);
    } catch (e) {
      setErr(describeError(e).title);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => onDone(false)}
      busy={busy}
      title={title}
      description="Aksi ini sensitif. Masukkan kode TOTP terbaru (berlaku 15 menit untuk aksi berikutnya). Aksi akan dijalankan ulang otomatis dengan kunci idempotensi yang sama."
      initialFocus={inputRef}
      footer={
        <>
          <Button variant="ghost" onClick={() => setRecovery((r) => !r)} disabled={busy}>
            {recovery ? 'Pakai kode TOTP' : 'Pakai kode pemulihan'}
          </Button>
          <span className="spacer" />
          <Button onClick={() => onDone(false)} disabled={busy}>
            Batal
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} icon="shield">
            Verifikasi
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label={recovery ? 'Kode pemulihan' : 'Kode TOTP (6 digit)'} error={err} required>
          <input
            ref={inputRef}
            className={recovery ? 'input input--code' : 'input otp-input'}
            value={code}
            onChange={(e) => setCode(recovery ? e.target.value : e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode={recovery ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            spellCheck={false}
            data-testid="mfa-code"
          />
        </Field>
      </form>
      {recovery ? <Callout tone="warning">Kode pemulihan hanya bisa dipakai sekali dan tercatat sebagai security event.</Callout> : null}
    </Dialog>
  );
}
