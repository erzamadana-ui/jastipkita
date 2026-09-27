import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { Rbac } from '../../api/admin';
import type { RoleRequest } from '../../api/types';
import { useAuth, useCan } from '../../auth/AuthProvider';
import { CAP } from '../../auth/permissions';
import { ActionDialog } from '../../components/ActionDialog';
import { DataTable } from '../../components/DataTable';
import { Badge, Button, Card, DateTime, IdText, PageHeader, Select, StatusBadge } from '../../components/ui';
import { useAdminAction } from '../../hooks/useAdminAction';

export function roleRequestBlock(r: RoleRequest, meId: string | undefined): string | null {
  if (r.status !== 'PENDING') return `Status ${r.status}`;
  if (r.requestedBy === meId) return 'Anda pengaju permintaan ini (maker-checker) — hanya bisa membatalkan';
  if (r.userId === meId) return 'Anda penerima peran ini (maker-checker)';
  if (Date.parse(r.expiresAt) <= Date.now()) return 'Permintaan kedaluwarsa (72 jam)';
  return null;
}

export default function RbacPage() {
  const { me } = useAuth();
  const [status, setStatus] = useState('PENDING');
  const roles = useQuery({ queryKey: ['rbac', 'roles'], queryFn: Rbac.roles });
  const reqs = useQuery({ queryKey: ['rbac', 'requests', status], queryFn: () => Rbac.requests((status || undefined) as never) });
  const [dlg, setDlg] = useState<{ kind: 'approve' | 'reject'; r: RoleRequest } | null>(null);
  const approveCap = useCan(CAP.approveRoleRequest);
  const approve = useAdminAction({ run: (v: { id: string; note: string }) => Rbac.approve(v.id, v.note || undefined), invalidate: [['rbac']], toastErrors: false, success: 'Peran istimewa diberikan' });
  const reject = useAdminAction({ run: (v: { id: string; note: string }) => Rbac.reject(v.id, v.note), invalidate: [['rbac']], toastErrors: false, success: (r) => (r.status === 'CANCELLED' ? 'Permintaan dibatalkan' : 'Permintaan ditolak') });

  return (
    <div className="stack stack--lg">
      <PageHeader title="Peran & akses" subtitle="Matriks least-privilege dan permintaan peran istimewa (maker-checker, 72 jam)." />
      <Card title="Permintaan peran istimewa" actions={<Select className="select--sm" aria-label="Status" value={status} onChange={setStatus} placeholder="Semua" options={['PENDING', 'APPLIED', 'REJECTED', 'EXPIRED', 'CANCELLED']} />} flush>
        <DataTable
          caption="Permintaan peran"
          rows={reqs.data?.data}
          loading={reqs.isPending}
          error={reqs.error}
          rowKey={(r) => r.id}
          empty={{ title: 'Tidak ada permintaan' }}
          columns={[
            { key: 'u', header: 'Pengguna', render: (r) => <Link to={`/users/${r.userId}`}><IdText id={r.userId} /></Link> },
            { key: 'role', header: 'Peran', render: (r) => <Badge tone="navy" dot={false}>{r.roleCode}</Badge> },
            { key: 'reason', header: 'Alasan', render: (r) => <span className="small">{r.reason}</span> },
            { key: 'by', header: 'Pengaju', render: (r) => <IdText id={r.requestedBy} /> },
            { key: 'st', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
            { key: 'exp', header: 'Kedaluwarsa', render: (r) => <DateTime value={r.expiresAt} relative /> },
            {
              key: 'act',
              header: 'Aksi',
              render: (r) =>
                r.status === 'PENDING' ? (
                  <span className="btn-group">
                    <Button size="sm" variant="primary" mfa disabledReason={approveCap.reason ?? roleRequestBlock(r, me?.id)} onClick={() => setDlg({ kind: 'approve', r })}>
                      Setujui
                    </Button>
                    <Button size="sm" variant="danger-outline" mfa onClick={() => setDlg({ kind: 'reject', r })}>
                      {r.requestedBy === me?.id ? 'Batalkan' : 'Tolak'}
                    </Button>
                  </span>
                ) : null,
            },
          ]}
        />
      </Card>
      <Card title="Peran & izin" hint="Sumber: GET /v1/admin/rbac/roles" flush>
        <DataTable
          caption="Peran admin"
          rows={roles.data?.roles}
          loading={roles.isPending}
          error={roles.error}
          rowKey={(r) => r.code}
          columns={[
            { key: 'code', header: 'Peran', render: (r) => <span className="stack" style={{ gap: 2 }}><strong>{r.code}</strong><span className="cell-sub">{r.description}</span></span> },
            { key: 'p', header: 'Istimewa', render: (r) => (r.privileged ? <Badge tone="danger">maker-checker</Badge> : <span className="muted">—</span>) },
            { key: 'h', header: 'Pemegang', align: 'right', render: (r) => r.holders, sortValue: (r) => r.holders },
            { key: 'perms', header: 'Izin', render: (r) => <span className="small">{r.permissions.join(', ')}</span> },
          ]}
        />
      </Card>
      <ActionDialog
        open={dlg?.kind === 'approve'}
        onClose={() => setDlg(null)}
        title={`Setujui ${dlg?.r.roleCode ?? ''}`}
        description="Penyetuju harus SUPER_ADMIN aktif yang berbeda dari pengaju dan penerima (API + trigger DB)."
        confirmLabel="Setujui peran"
        mfa
        reason={{ label: 'Catatan (opsional)', required: false, minLength: 0 }}
        onConfirm={(note) => approve.mutateAsync({ id: dlg!.r.id, note })}
      />
      <ActionDialog open={dlg?.kind === 'reject'} onClose={() => setDlg(null)} title="Tolak / batalkan permintaan" confirmLabel="Tolak permintaan" tone="danger" mfa reason={{ label: 'Catatan', minLength: 3 }} onConfirm={(note) => reject.mutateAsync({ id: dlg!.r.id, note })} />
    </div>
  );
}
