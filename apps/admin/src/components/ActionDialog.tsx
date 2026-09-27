/**
 * Confirmation dialog for admin writes: reason (audited), optional extra fields, MFA / idempotency hints,
 * specific verb on the confirm button, busy lock (no double submit), error kept inline.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { describeError, validationIssues } from '../api/errors';
import { Icon } from './Icon';
import { Dialog } from './Overlay';
import { Button, Callout, Field } from './ui';

export interface ActionDialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  tone?: 'primary' | 'danger' | 'success';
  /** Reason textarea (sent to the API and written to the audit log). */
  reason?: { label?: string; minLength?: number; placeholder?: string; required?: boolean } | false;
  mfa?: boolean;
  idempotencyKey?: string | null;
  children?: ReactNode;
  canConfirm?: boolean;
  blockedReason?: string | null;
  wide?: boolean;
  onConfirm: (reason: string) => Promise<unknown>;
}

export function ActionDialog({ open, onClose, title, description, confirmLabel, tone = 'primary', reason = { minLength: 5 }, mfa, idempotencyKey, children, canConfirm = true, blockedReason, wide, onConfirm }: ActionDialogProps) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (open) {
      setText('');
      setErr(null);
      setBusy(false);
    }
  }, [open]);
  const min = reason ? (reason.minLength ?? 5) : 0;
  const reasonOk = !reason || (reason.required === false && text.trim().length === 0) || text.trim().length >= min;
  const submit = async () => {
    if (!reasonOk || !canConfirm || blockedReason) return;
    setBusy(true);
    setErr(null);
    try {
      await onConfirm(text.trim());
      onClose();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const issues = validationIssues(err);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      busy={busy}
      wide={wide}
      title={title}
      description={description}
      footer={
        <>
          {mfa ? (
            <span className="muted small row row--tight" style={{ marginRight: 'auto' }}>
              <Icon name="lock" size={13} /> Butuh MFA ≤ 15 menit
            </span>
          ) : null}
          <Button onClick={onClose} disabled={busy}>
            Batal
          </Button>
          <Button variant={tone} onClick={() => void submit()} loading={busy} disabledReason={blockedReason ?? (!canConfirm ? 'Lengkapi isian terlebih dahulu' : !reasonOk ? `Alasan minimal ${min} karakter` : null)} data-testid="confirm-action">
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {reason ? (
        <Field label={reason.label ?? 'Alasan (dicatat di audit log)'} required={reason.required !== false} hint={min ? `Minimal ${min} karakter.` : undefined}>
          <textarea ref={ref} className="textarea" value={text} onChange={(e) => setText(e.target.value)} placeholder={reason.placeholder} maxLength={1000} data-testid="action-reason" />
        </Field>
      ) : null}
      {blockedReason ? <Callout tone="warning">{blockedReason}</Callout> : null}
      {idempotencyKey ? (
        <p className="muted small">
          Idempotency-Key <code>{idempotencyKey.slice(0, 8)}…</code> — dipakai ulang bila aksi diulang (MFA/jaringan), jadi uang tidak berpindah dua kali.
        </p>
      ) : null}
      {err ? (
        <Callout tone="danger" title={describeError(err).title}>
          {describeError(err).detail ? <div className="small">{describeError(err).detail}</div> : null}
          {issues.length ? (
            <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {issues.map((i, n) => (
                <li key={n}>
                  <code>{i.path || '—'}</code> {i.message}
                </li>
              ))}
            </ul>
          ) : null}
        </Callout>
      ) : null}
    </Dialog>
  );
}
