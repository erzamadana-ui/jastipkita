import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Settlement } from '../../api/admin';
import type { SettlementChange } from '../../api/types';
import { useAuth, useCan } from '../../auth/AuthProvider';
import { CAP } from '../../auth/permissions';
import { ActionDialog } from '../../components/ActionDialog';
import { DataTable } from '../../components/DataTable';
import { Badge, Button, Callout, Card, Checkbox, DateTime, Field, IdText, PageHeader, Select, StatusBadge } from '../../components/ui';
import { useAdminAction } from '../../hooks/useAdminAction';
import { humanize } from '../../lib/format';

const SECRET_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
const MASK_RE = /^\*{4}\d{2,4}$/;

/** Blocks anything that looks like a real account number (≥ 7 consecutive digits) from being typed into the form. */
export function looksLikeAccountNumber(v: string): boolean {
  return /\d{7,}/.test(v.replace(/[\s.-]/g, ''));
}

interface Draft {
  changeType: 'CREATE' | 'UPDATE' | 'DISABLE' | 'SET_PRIMARY';
  settlementAccountId: string;
  label: string;
  purpose: string;
  bankCode: string;
  secretRef: string;
  accountMask: string;
  holderNameMask: string;
  isPrimary: boolean;
}

const EMPTY: Draft = { changeType: 'CREATE', settlementAccountId: '', label: '', purpose: 'PLATFORM_REVENUE', bankCode: '', secretRef: '', accountMask: '', holderNameMask: '', isPrimary: false };

export function validateDraft(d: Draft): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(d)) if (typeof v === 'string' && looksLikeAccountNumber(v)) e[k] = 'Terlihat seperti nomor rekening. Jangan pernah memasukkan nomor rekening di sini.';
  if (d.changeType !== 'CREATE' && !d.settlementAccountId) e.settlementAccountId = 'Pilih rekening';
  const needsSecret = d.changeType === 'CREATE' || (d.changeType === 'UPDATE' && (d.secretRef || d.accountMask));
  if (needsSecret) {
    if (!SECRET_RE.test(d.secretRef)) e.secretRef = e.secretRef ?? 'NAMA secret: huruf besar/angka/_ (3–64), mis. SETTLEMENT_MAIN';
    if (!MASK_RE.test(d.accountMask)) e.accountMask = e.accountMask ?? 'Format ****0961 (4 bintang + 2–4 digit terakhir)';
  }
  if (d.changeType === 'CREATE') {
    if (d.label.trim().length < 3) e.label = 'Minimal 3 karakter';
    if (!/^[A-Z0-9_]{2,20}$/.test(d.bankCode)) e.bankCode = 'Kode bank, mis. BCA';
    if (d.holderNameMask.trim().length < 2) e.holderNameMask = e.holderNameMask ?? 'Wajib, mis. PT J*** K***';
  }
  return e;
}

export default function SettlementPage() {
  const { me } = useAuth();
  const accounts = useQuery({ queryKey: ['settlement', 'accounts'], queryFn: Settlement.accounts });
  const [status, setStatus] = useState('');
  const changes = useQuery({ queryKey: ['settlement', 'changes', status], queryFn: () => Settlement.changes((status || undefined) as never) });
  const reqCap = useCan(CAP.settlementRequest);
  const approveCap = useCan(CAP.settlementApprove);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [dlg, setDlg] = useState<{ kind: 'approve' | 'reject'; c: SettlementChange } | null>(null);
  const errors = useMemo(() => validateDraft(draft), [draft]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const request = useAdminAction({
    run: (reason: string, key) =>
      Settlement.request(
        {
          changeType: draft.changeType,
          reason,
          ...(draft.changeType !== 'CREATE' ? { settlementAccountId: draft.settlementAccountId } : {}),
          ...(draft.label ? { label: draft.label } : {}),
          ...(draft.purpose && draft.changeType === 'CREATE' ? { purpose: draft.purpose as 'PLATFORM_REVENUE' } : {}),
          ...(draft.bankCode ? { bankCode: draft.bankCode } : {}),
          ...(draft.secretRef ? { secretRef: draft.secretRef } : {}),
          ...(draft.accountMask ? { accountMask: draft.accountMask } : {}),
          ...(draft.holderNameMask ? { holderNameMask: draft.holderNameMask } : {}),
          ...(draft.changeType === 'CREATE' ? { isPrimary: draft.isPrimary } : {}),
        },
        key,
      ),
    actionKey: () => 'settlement.request',
    invalidate: [['settlement']],
    toastErrors: false,
    success: 'Permintaan perubahan dibuat — menunggu FINANCE_SUPER_ADMIN lain',
    onSuccess: () => setDraft(EMPTY),
  });
  const decide = useAdminAction({
    run: (v: { kind: 'approve' | 'reject'; c: SettlementChange; note: string }, key) => (v.kind === 'approve' ? Settlement.approve(v.c.id, v.note || undefined, key) : Settlement.reject(v.c.id, v.note, key)),
    actionKey: (v) => `settlement.${v.kind}:${v.c.id}`,
    invalidate: [['settlement']],
    toastErrors: false,
    success: (r) => `Perubahan ${r.status}`,
  });

  const approveBlock = (c: SettlementChange) => approveCap.reason ?? (c.requestedBy === me?.id ? 'Anda pengaju perubahan ini (maker-checker)' : !c.canApprove ? 'API menolak: bukan FINANCE_SUPER_ADMIN lain / sudah diputuskan' : Date.parse(c.expiresAt) <= Date.now() ? 'Kedaluwarsa (72 jam)' : null);

  return (
    <div className="stack stack--lg">
      <PageHeader title="Rekening settlement" subtitle="Rekening bank platform — hanya mask. Perubahan = maker-checker FINANCE_SUPER_ADMIN + MFA ≤ 15 menit." actions={<Button variant="primary" icon="plus" mfa onClick={() => setOpen(true)} disabledReason={reqCap.reason}>Ajukan perubahan</Button>} />
      <Callout tone="info" icon="lock" title="Nomor rekening tidak pernah diketik di admin.">
        Operator pemilik secret store menambahkan rekening ke <code>SETTLEMENT_SECRETS_JSON</code> di server (Workers secret / env) lalu redeploy. Di sini Anda hanya mengisi <strong>NAMA secret</strong> (mis. <code>SETTLEMENT_MAIN</code>) dan mask <code>****0961</code>; API mencocokkan digit akhir & kode bank dengan secret store. API dan database hanya menyimpan <code>secret://NAMA</code> + mask. (docs/api/admin.md §4)
      </Callout>
      <Card title="Rekening aktif" flush>
        <DataTable
          caption="Rekening settlement"
          rows={accounts.data?.data}
          loading={accounts.isPending}
          error={accounts.error}
          rowKey={(a) => a.id}
          empty={{ title: 'Belum ada rekening settlement' }}
          columns={[
            { key: 'l', header: 'Label', render: (a) => <span className="stack" style={{ gap: 0 }}><span className="cell-primary">{a.label}</span><span className="cell-sub">{humanize(a.purpose)}</span></span> },
            { key: 'b', header: 'Rekening', render: (a) => <span className="mono">{a.bankCode} {a.accountMask}</span> },
            { key: 'h', header: 'Pemilik', render: (a) => a.holderNameMask },
            { key: 's', header: 'Status', render: (a) => <span className="row row--tight"><StatusBadge status={a.status} />{a.isPrimary ? <Badge tone="info">Utama</Badge> : null}</span> },
            { key: 'sec', header: 'Secret store', render: (a) => (a.secretConfigured ? <Badge tone="success">Terkonfigurasi</Badge> : <Badge tone="danger">Secret hilang</Badge>) },
            { key: 'act', header: 'Aktif sejak', render: (a) => <DateTime value={a.activatedAt} /> },
          ]}
        />
      </Card>
      <Card title="Riwayat & persetujuan perubahan" actions={<Select className="select--sm" aria-label="Status" value={status} onChange={setStatus} placeholder="Semua" options={['PENDING', 'APPROVED', 'APPLIED', 'REJECTED', 'EXPIRED']} />} flush>
        <DataTable
          caption="Perubahan rekening settlement"
          rows={changes.data?.data}
          loading={changes.isPending}
          error={changes.error}
          rowKey={(c) => c.id}
          empty={{ title: 'Belum ada permintaan perubahan' }}
          columns={[
            { key: 't', header: 'Jenis', render: (c) => <Badge tone="info" dot={false}>{c.changeType}</Badge> },
            { key: 'p', header: 'Usulan (masked)', render: (c) => <span className="small mono">{Object.entries(c.proposed).map(([k, v]) => `${k}=${String(v)}`).join(' · ') || '—'}</span> },
            { key: 'r', header: 'Alasan', render: (c) => <span className="small">{c.reason}</span> },
            { key: 'by', header: 'Pengaju', render: (c) => <span className="stack" style={{ gap: 0 }}><IdText id={c.requestedBy} /><span className="cell-sub"><DateTime value={c.requestedAt} /></span></span> },
            { key: 's', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
            { key: 'exp', header: 'Kedaluwarsa', render: (c) => (c.status === 'PENDING' ? <DateTime value={c.expiresAt} relative /> : <DateTime value={c.decidedAt} />) },
            {
              key: 'act',
              header: 'Aksi',
              render: (c) =>
                c.status === 'PENDING' ? (
                  <span className="btn-group">
                    <Button size="sm" variant="success" mfa disabledReason={approveBlock(c)} onClick={() => setDlg({ kind: 'approve', c })}>
                      Setujui
                    </Button>
                    <Button size="sm" variant="danger-outline" mfa disabledReason={approveCap.reason} onClick={() => setDlg({ kind: 'reject', c })}>
                      Tolak
                    </Button>
                  </span>
                ) : null,
            },
          ]}
        />
      </Card>

      <ActionDialog
        open={open}
        onClose={() => setOpen(false)}
        wide
        title="Ajukan perubahan rekening settlement"
        description="Permintaan berlaku 72 jam dan harus disetujui FINANCE_SUPER_ADMIN lain."
        confirmLabel="Ajukan perubahan"
        mfa
        canConfirm={Object.keys(errors).length === 0}
        reason={{ minLength: 10, label: 'Alasan perubahan (min. 10 karakter)' }}
        idempotencyKey={open ? request.keyFor(undefined as never) : null}
        onConfirm={(reason) => request.mutateAsync(reason)}
      >
        <div className="form-grid">
          <Field label="Jenis perubahan" required>
            <Select value={draft.changeType} onChange={(v) => set('changeType', v as Draft['changeType'])} options={['CREATE', 'UPDATE', 'DISABLE', 'SET_PRIMARY']} />
          </Field>
          {draft.changeType !== 'CREATE' ? (
            <Field label="Rekening" required error={errors.settlementAccountId}>
              <Select value={draft.settlementAccountId} onChange={(v) => set('settlementAccountId', v)} placeholder="— pilih —" options={(accounts.data?.data ?? []).filter((a) => a.status !== 'DISABLED').map((a) => ({ value: a.id, label: `${a.label} · ${a.bankCode} ${a.accountMask}` }))} />
            </Field>
          ) : null}
          {draft.changeType === 'CREATE' || draft.changeType === 'UPDATE' ? (
            <>
              <Field label="Label" required={draft.changeType === 'CREATE'} error={errors.label}>
                <input className="input" value={draft.label} onChange={(e) => set('label', e.target.value)} />
              </Field>
              {draft.changeType === 'CREATE' ? (
                <Field label="Tujuan" required>
                  <Select value={draft.purpose} onChange={(v) => set('purpose', v)} options={['PLATFORM_REVENUE', 'TAX', 'OPERATIONS']} />
                </Field>
              ) : null}
              <Field label="Kode bank" required={draft.changeType === 'CREATE'} error={errors.bankCode}>
                <input className="input" value={draft.bankCode} onChange={(e) => set('bankCode', e.target.value.toUpperCase())} placeholder="BCA" />
              </Field>
              <Field label="NAMA secret (secretRef)" required={draft.changeType === 'CREATE'} error={errors.secretRef} hint="Nama entri di SETTLEMENT_SECRETS_JSON — bukan nomor rekening">
                <input className="input mono" value={draft.secretRef} onChange={(e) => set('secretRef', e.target.value.toUpperCase().replace(/^SECRET:\/\//, ''))} placeholder="SETTLEMENT_MAIN" autoComplete="off" spellCheck={false} data-testid="secret-ref" />
              </Field>
              <Field label="Mask rekening" required={draft.changeType === 'CREATE'} error={errors.accountMask} hint="4 bintang + 2–4 digit terakhir; dicocokkan server">
                <input className="input mono" value={draft.accountMask} onChange={(e) => set('accountMask', e.target.value)} placeholder="****0961" autoComplete="off" />
              </Field>
              <Field label="Mask nama pemilik" required={draft.changeType === 'CREATE'} error={errors.holderNameMask}>
                <input className="input" value={draft.holderNameMask} onChange={(e) => set('holderNameMask', e.target.value)} placeholder="PT J*** K*** I***" />
              </Field>
            </>
          ) : null}
        </div>
        {draft.changeType === 'CREATE' ? <Checkbox checked={draft.isPrimary} onChange={(v) => set('isPrimary', v)} label="Jadikan rekening utama untuk tujuan ini" /> : null}
      </ActionDialog>
      <ActionDialog
        open={dlg?.kind === 'approve'}
        onClose={() => setDlg(null)}
        title="Setujui & terapkan perubahan rekening"
        description="Hanya FINANCE_SUPER_ADMIN ≠ pengaju, MFA ≤ 15 menit (diperiksa DB dengan waktu DB). Secret dicek ulang sebelum apply_settlement_account_change()."
        confirmLabel="Setujui & terapkan"
        tone="success"
        mfa
        reason={{ label: 'Catatan (opsional)', required: false, minLength: 0 }}
        idempotencyKey={dlg?.kind === 'approve' ? decide.keyFor({ ...dlg, note: '' }) : null}
        onConfirm={(note) => decide.mutateAsync({ ...dlg!, note })}
      />
      <ActionDialog open={dlg?.kind === 'reject'} onClose={() => setDlg(null)} title="Tolak perubahan rekening" confirmLabel="Tolak perubahan" tone="danger" mfa reason={{ label: 'Catatan', minLength: 3 }} idempotencyKey={dlg?.kind === 'reject' ? decide.keyFor({ ...dlg, note: '' }) : null} onConfirm={(note) => decide.mutateAsync({ ...dlg!, note })} />
    </div>
  );
}
