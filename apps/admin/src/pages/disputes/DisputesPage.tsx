import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Disputes } from '../../api/admin';
import { DataTable, useCursorQuery } from '../../components/DataTable';
import { Badge, Card, DateTime, Field, IdText, Money, PageHeader, Segmented, Select, StatusBadge } from '../../components/ui';
import { humanize } from '../../lib/format';
import type { Tone } from '../../lib/status';

export const SLA_TONE: Record<string, Tone> = { BREACHED: 'danger', DUE_SOON: 'warning', ON_TRACK: 'success', DONE: 'neutral', RESPONDED: 'success' };
export const SLA_LABEL: Record<string, string> = { BREACHED: 'Lewat SLA', DUE_SOON: '< 24 jam', ON_TRACK: 'Sesuai SLA', DONE: 'Selesai', RESPONDED: 'Sudah direspons' };

export function SlaBadge({ state }: { state: string }) {
  return <Badge tone={SLA_TONE[state] ?? 'neutral'}>{SLA_LABEL[state] ?? state}</Badge>;
}

export default function DisputesPage() {
  const nav = useNavigate();
  const [sla, setSla] = useState<'' | 'BREACHED' | 'DUE_SOON'>('');
  const [assignee, setAssignee] = useState('');
  const [status, setStatus] = useState('');
  const filters = { sla: sla || undefined, assignee: assignee || undefined, status: status || undefined, limit: 25 };
  const { query, rows, pagination } = useCursorQuery(['disputes', filters], (cursor) => Disputes.queue({ ...filters, cursor }), { refetchInterval: 60_000 });
  return (
    <div className="stack stack--lg">
      <PageHeader title="Dispute" subtitle="Antrean berdasarkan SLA (dispute.sla). Resolusi mengeksekusi uang di transaksi yang sama — MFA + Idempotency-Key." />
      <Card flush>
        <div className="filterbar">
          <Field label="SLA">
            <Segmented
              label="Filter SLA"
              value={sla}
              onChange={setSla}
              options={[
                { key: '', label: 'Semua' },
                { key: 'BREACHED', label: 'Lewat SLA' },
                { key: 'DUE_SOON', label: '< 24 jam' },
              ]}
            />
          </Field>
          <Field label="Penanggung jawab">
            <Select
              value={assignee}
              onChange={setAssignee}
              options={[
                { value: '', label: 'Semua' },
                { value: 'me', label: 'Saya' },
                { value: 'none', label: 'Belum ditugaskan' },
              ]}
            />
          </Field>
          <Field label="Status">
            <Select value={status} onChange={setStatus} placeholder="Terbuka (default)" options={['OPEN', 'EVIDENCE_COLLECTION', 'UNDER_REVIEW', 'APPEALED', 'RESOLVED', 'CLOSED']} />
          </Field>
        </div>
        <DataTable
          caption="Antrean dispute"
          rows={rows}
          loading={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
          rowKey={(d) => d.id}
          onRowClick={(d) => nav(`/disputes/${d.id}`)}
          rowLabel={(d) => `Buka dispute ${d.number}`}
          rowClassName={(d) => (d.slaState === 'BREACHED' ? 'row--danger' : undefined)}
          pagination={pagination}
          empty={{ title: 'Tidak ada dispute pada filter ini' }}
          columns={[
            { key: 'n', header: 'Nomor', render: (d) => <span className="cell-primary mono">{d.number}</span> },
            { key: 'tx', header: 'Transaksi', render: (d) => <span className="stack" style={{ gap: 0 }}><span className="mono">{d.transactionNumber}</span><span className="cell-sub">{humanize(d.transactionStatus)}</span></span> },
            { key: 't', header: 'Tipe', render: (d) => humanize(d.type) },
            { key: 's', header: 'Status', render: (d) => <StatusBadge status={d.status} /> },
            { key: 'sla', header: 'SLA', render: (d) => <span className="stack" style={{ gap: 0 }}><SlaBadge state={d.slaState} /><span className="cell-sub"><DateTime value={d.slaDueAt} relative /></span></span>, sortValue: (d) => d.slaDueAt },
            { key: 'req', header: 'Diminta', render: (d) => humanize(d.requestedResolution) },
            { key: 'a', header: 'PJ', render: (d) => (d.assigneeId ? <IdText id={d.assigneeId} /> : <Badge tone="warning">Belum</Badge>) },
            { key: 'tot', header: 'Nilai', align: 'right', render: (d) => <Money value={d.totalIdr} /> },
            { key: 'c', header: 'Dibuka', render: (d) => <DateTime value={d.createdAt} />, sortValue: (d) => d.createdAt },
          ]}
        />
      </Card>
    </div>
  );
}
