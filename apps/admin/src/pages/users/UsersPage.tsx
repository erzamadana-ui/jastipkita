import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Users } from '../../api/admin';
import { ADMIN_ROLES } from '../../auth/permissions';
import { DataTable, useCursorQuery } from '../../components/DataTable';
import { Badge, Card, DateTime, Field, PageHeader, Select, StatusBadge } from '../../components/ui';
import { KYC_LABEL, kycTone, trustTone } from '../../lib/status';

export function KycBadge({ level }: { level: number }) {
  return (
    <Badge tone={kycTone(level)} title={`Level KYC ${level}`}>
      L{level} · {KYC_LABEL[level] ?? '—'}
    </Badge>
  );
}

export function TrustBadge({ score }: { score: number }) {
  return (
    <Badge tone={trustTone(score)} title="Trust Score 0–100">
      Trust {score}
    </Badge>
  );
}

export default function UsersPage() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const [status, setStatus] = useState('');
  const [role, setRole] = useState('');
  const [kyc, setKyc] = useState('');
  const filters = { q: applied || undefined, status: (status || undefined) as never, role: role || undefined, kycLevel: kyc ? Number(kyc) : undefined, limit: 25 };
  const { query, rows, pagination } = useCursorQuery(['users', filters], (cursor) => Users.search({ ...filters, cursor }));

  return (
    <div className="stack stack--lg">
      <PageHeader title="Pengguna" subtitle="Pencarian dengan PII dimasking. Kontak lengkap hanya lewat “Tampilkan kontak” (alasan + MFA, tercatat)." />
      <Card flush>
        <form
          className="filterbar"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(q.trim());
          }}
        >
          <Field label="Cari (e-mail, telepon 08…/+62…, nama, ID, kode referral)" className="field--grow">
            <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="mis. rina@ atau 0812…" />
          </Field>
          <Field label="Status">
            <Select value={status} onChange={setStatus} placeholder="Semua" options={['ACTIVE', 'SUSPENDED', 'PENDING_DELETION', 'DELETED']} />
          </Field>
          <Field label="Peran">
            <Select value={role} onChange={setRole} placeholder="Semua" options={ADMIN_ROLES.map((r) => ({ value: r, label: r }))} />
          </Field>
          <Field label="Level KYC">
            <Select value={kyc} onChange={setKyc} placeholder="Semua" options={[1, 2, 3, 4, 5].map((l) => ({ value: String(l), label: `L${l} · ${KYC_LABEL[l]}` }))} />
          </Field>
          <button className="btn btn--primary" type="submit">
            Cari
          </button>
        </form>
        <DataTable
          caption="Hasil pencarian pengguna"
          rows={rows}
          loading={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
          rowKey={(u) => u.id}
          onRowClick={(u) => nav(`/users/${u.id}`)}
          rowLabel={(u) => `Buka pengguna ${u.displayName ?? u.id}`}
          pagination={pagination}
          empty={{ title: 'Tidak ada pengguna yang cocok' }}
          columns={[
            { key: 'name', header: 'Nama', render: (u) => <span className="cell-primary">{u.displayName ?? '—'}</span>, sortValue: (u) => u.displayName },
            { key: 'email', header: 'E-mail', render: (u) => <span className="mono">{u.email ?? '—'}</span> },
            { key: 'phone', header: 'Telepon', render: (u) => <span className="mono">{u.phone ?? '—'}</span> },
            { key: 'status', header: 'Status', render: (u) => <StatusBadge status={u.status} />, sortValue: (u) => u.status },
            { key: 'kyc', header: 'KYC', render: (u) => <KycBadge level={u.kycLevel} />, sortValue: (u) => u.kycLevel },
            { key: 'trust', header: 'Trust', align: 'right', render: (u) => <TrustBadge score={u.trustScore} />, sortValue: (u) => u.trustScore },
            { key: 'roles', header: 'Peran', render: (u) => (u.roles.length ? u.roles.map((r) => <Badge key={r} tone="navy" dot={false}>{r}</Badge>) : <span className="muted">—</span>) },
            { key: 'created', header: 'Terdaftar', render: (u) => <DateTime value={u.createdAt} />, sortValue: (u) => u.createdAt },
          ]}
        />
      </Card>
    </div>
  );
}
