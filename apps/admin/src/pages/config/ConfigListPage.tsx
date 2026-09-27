import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { Config } from '../../api/admin';
import { DataTable } from '../../components/DataTable';
import { Badge, Callout, Card, DateTime, IdText, PageHeader } from '../../components/ui';

export default function ConfigListPage() {
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['config', 'list'], queryFn: Config.list });
  const pendingTotal = (q.data?.data ?? []).reduce((s, r) => s + r.pendingApprovals, 0);
  return (
    <div className="stack stack--lg">
      <PageHeader title="Business config" subtitle="Setiap perubahan = versi baru (maker-checker: pengusul ≠ penyetuju, MFA). Nilai ASUMSI wajib divalidasi sebelum produksi." />
      {pendingTotal ? <Callout tone="warning" title={`${pendingTotal} usulan menunggu persetujuan.`}>Buka key terkait untuk meninjau diff dan menyetujui/menolak.</Callout> : null}
      <Card flush>
        <DataTable
          caption="Kunci business config"
          rows={q.data?.data}
          loading={q.isPending}
          error={q.error}
          onRetry={() => void q.refetch()}
          rowKey={(r) => r.key}
          onRowClick={(r) => nav(`/config/${encodeURIComponent(r.key)}`)}
          rowLabel={(r) => `Buka config ${r.key}`}
          rowClassName={(r) => (r.pendingApprovals ? 'row--highlight' : undefined)}
          columns={[
            { key: 'k', header: 'Key', render: (r) => <code className="cell-primary">{r.key}</code>, sortValue: (r) => r.key },
            { key: 'v', header: 'Versi aktif', align: 'right', render: (r) => (r.active ? `v${r.active.version}` : '—'), sortValue: (r) => r.active?.version ?? 0 },
            { key: 'a', header: 'Asumsi', render: (r) => (r.isAssumption ? <Badge tone="amber">ASUMSI</Badge> : <span className="muted">—</span>) },
            { key: 'p', header: 'Usulan', render: (r) => (r.pendingApprovals ? <Badge tone="warning">{r.pendingApprovals} menunggu</Badge> : <span className="muted">—</span>), sortValue: (r) => r.pendingApprovals },
            { key: 'r', header: 'Alasan perubahan terakhir', render: (r) => <span className="small">{r.active?.changeReason ?? '—'}</span> },
            { key: 'by', header: 'Disetujui', render: (r) => (r.active?.approvedBy ? <span className="row row--tight"><IdText id={r.active.approvedBy} /> <DateTime value={r.active.approvedAt} /></span> : <span className="muted">seed</span>) },
          ]}
        />
      </Card>
      {q.data?.assumptions.length ? (
        <Card title="Daftar asumsi (business-config.defaults.json _meta)">
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {q.data.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
