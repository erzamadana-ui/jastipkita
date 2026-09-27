import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Trust } from '../../api/admin';
import type { TrustOverride } from '../../api/types';
import { useAuth, useCan } from '../../auth/AuthProvider';
import { CAP } from '../../auth/permissions';
import { ActionDialog } from '../../components/ActionDialog';
import { DataTable } from '../../components/DataTable';
import { Button, Card, DateTime, Field, IdText, PageHeader, Select, StatusBadge } from '../../components/ui';
import { useAdminAction } from '../../hooks/useAdminAction';
import { TrustBadge } from '../users/UsersPage';

export function trustApproveBlock(o: TrustOverride, meId: string | undefined, permReason: string | null): string | null {
  if (permReason) return permReason;
  if (o.status !== 'PENDING') return `Status ${o.status}`;
  if (o.requestedBy === meId) return 'Anda pengaju override ini (maker-checker)';
  if (o.userId === meId) return 'Tidak dapat menyetujui skor milik sendiri';
  if (!o.canApprove) return 'Tidak dapat disetujui oleh Anda';
  return null;
}

export default function TrustPage() {
  const { me } = useAuth();
  const [sp] = useSearchParams();
  const [status, setStatus] = useState('PENDING');
  const q = useQuery({ queryKey: ['trust', status], queryFn: () => Trust.list((status || undefined) as never) });
  const reqCap = useCan(CAP.trustRequest);
  const apprCap = useCan(CAP.trustApprove);
  const [open, setOpen] = useState(!!sp.get('userId'));
  const [userId, setUserId] = useState(sp.get('userId') ?? '');
  const [score, setScore] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [dlg, setDlg] = useState<{ kind: 'approve' | 'reject'; o: TrustOverride } | null>(null);
  const request = useAdminAction({
    run: (reason: string) => Trust.request({ userId, newScore: Number(score), reason, ...(validUntil ? { validUntil: new Date(validUntil).toISOString() } : {}) }),
    invalidate: [['trust']],
    toastErrors: false,
    success: 'Override diajukan — menunggu persetujuan',
  });
  const decide = useAdminAction({
    run: (v: { kind: 'approve' | 'reject'; o: TrustOverride; note: string }) => (v.kind === 'approve' ? Trust.approve(v.o.id, v.note || undefined) : Trust.reject(v.o.id, v.note)),
    invalidate: [['trust'], ['users']],
    toastErrors: false,
    success: (r) => `Override ${r.status}`,
  });
  const scoreNum = Number(score);
  return (
    <div className="stack stack--lg">
      <PageHeader title="Override Trust Score" subtitle="Maker-checker: penyetuju ≠ pengaju ≠ pemilik skor (dijaga DB). Pengguna melihat tanda “Disesuaikan tim JastipKita”." actions={<Button variant="primary" icon="plus" mfa onClick={() => setOpen(true)} disabledReason={reqCap.reason}>Ajukan override</Button>} />
      <Card actions={<Select className="select--sm" aria-label="Status" value={status} onChange={setStatus} placeholder="Semua" options={['PENDING', 'APPROVED', 'APPLIED', 'REJECTED', 'EXPIRED']} />} title="Permintaan override" flush>
        <DataTable
          caption="Override trust score"
          rows={q.data?.data}
          loading={q.isPending}
          error={q.error}
          rowKey={(o) => o.id}
          empty={{ title: 'Tidak ada permintaan' }}
          columns={[
            { key: 'u', header: 'Pengguna', render: (o) => <Link to={`/users/${o.userId}`}><IdText id={o.userId} /></Link> },
            { key: 'sc', header: 'Skor', render: (o) => <span className="row row--tight"><TrustBadge score={o.previousScore} /> → <TrustBadge score={o.newScore} /></span> },
            { key: 'r', header: 'Alasan', render: (o) => <span className="small">{o.reason}</span> },
            { key: 'v', header: 'Berlaku s.d.', render: (o) => <DateTime value={o.validUntil} /> },
            { key: 'by', header: 'Pengaju', render: (o) => <IdText id={o.requestedBy} /> },
            { key: 's', header: 'Status', render: (o) => <StatusBadge status={o.status} /> },
            {
              key: 'a',
              header: 'Aksi',
              render: (o) =>
                o.status === 'PENDING' ? (
                  <span className="btn-group">
                    <Button size="sm" variant="success" mfa disabledReason={trustApproveBlock(o, me?.id, apprCap.reason)} onClick={() => setDlg({ kind: 'approve', o })}>
                      Setujui
                    </Button>
                    <Button size="sm" variant="danger-outline" mfa disabledReason={apprCap.reason} onClick={() => setDlg({ kind: 'reject', o })}>
                      Tolak
                    </Button>
                  </span>
                ) : null,
            },
          ]}
        />
      </Card>
      <ActionDialog open={open} onClose={() => setOpen(false)} title="Ajukan override Trust Score" description="Permintaan kedaluwarsa dalam 72 jam bila tidak diputuskan." confirmLabel="Ajukan override" mfa canConfirm={/^[0-9a-f-]{36}$/i.test(userId) && Number.isInteger(scoreNum) && scoreNum >= 0 && scoreNum <= 100 && score !== ''} reason={{ minLength: 10 }} onConfirm={(r) => request.mutateAsync(r)}>
        <div className="form-grid">
          <Field label="ID pengguna" required>
            <input className="input mono" value={userId} onChange={(e) => setUserId(e.target.value.trim())} />
          </Field>
          <Field label="Skor baru (0–100)" required>
            <input className="input tabular" type="number" min={0} max={100} value={score} onChange={(e) => setScore(e.target.value)} />
          </Field>
          <Field label="Berlaku sampai (opsional)">
            <input className="input" type="datetime-local" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          </Field>
        </div>
      </ActionDialog>
      <ActionDialog open={dlg?.kind === 'approve'} onClose={() => setDlg(null)} title="Setujui & terapkan override" confirmLabel="Terapkan skor" tone="success" mfa reason={{ label: 'Catatan (opsional)', required: false, minLength: 0 }} onConfirm={(note) => decide.mutateAsync({ ...dlg!, note })} />
      <ActionDialog open={dlg?.kind === 'reject'} onClose={() => setDlg(null)} title="Tolak override" confirmLabel="Tolak override" tone="danger" mfa reason={{ label: 'Catatan', minLength: 3 }} onConfirm={(note) => decide.mutateAsync({ ...dlg!, note })} />
    </div>
  );
}
