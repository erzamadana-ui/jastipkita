import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Support } from '../../api/admin';
import { DataTable, useCursorQuery } from '../../components/DataTable';
import { Badge, Card, DateTime, Field, IdText, InfoTip, PageHeader, Segmented, Select, StatusBadge } from '../../components/ui';
import { formatHours, formatNumber, formatPercent, humanize } from '../../lib/format';
import { SlaBadge } from '../disputes/DisputesPage';

export default function TicketsPage() {
  const nav = useNavigate();
  const [sla, setSla] = useState<'' | 'BREACHED' | 'DUE_SOON'>('');
  const [priority, setPriority] = useState('');
  const [assignee, setAssignee] = useState('');
  const [status, setStatus] = useState('');
  const filters = { sla: sla || undefined, priority: priority || undefined, assignee: assignee || undefined, status: status || undefined, limit: 25 };
  const { query, rows, pagination } = useCursorQuery(['support', 'tickets', filters], (cursor) => Support.tickets({ ...filters, cursor }), { refetchInterval: 60_000 });
  const slaQ = useQuery({ queryKey: ['support', 'sla'], queryFn: Support.sla });
  return (
    <div className="stack stack--lg">
      <PageHeader title="Tiket support" subtitle="SLA = batas respons pertama agen per prioritas (config support.sla). Catatan internal tidak pernah terlihat pengguna." />
      {slaQ.data ? (
        <Card
          title={
            <span className="row row--tight">
              SLA respons pertama <InfoTip label="Definisi SLA">{slaQ.data.definition}</InfoTip>
            </span>
          }
          hint={`30 hari: median ${formatHours(slaQ.data.last30Days.medianFirstResponseHours)} · terpenuhi ${formatPercent(slaQ.data.last30Days.slaMetRatio)} (n=${slaQ.data.last30Days.responded})${slaQ.data.last30Days.dataQuality ? ` · ⚠ ${slaQ.data.last30Days.dataQuality}` : ''}`}
        >
          <div className="grid grid-4">
            {slaQ.data.byPriority.map((p) => (
              <div key={p.priority} className="stat-inline">
                <span className="l">
                  {p.priority} · SLA {p.slaHours} jam
                </span>
                <span className="v">{formatNumber(p.open)} terbuka</span>
                <span className="small">
                  {p.breached ? <Badge tone="danger">{p.breached} lewat SLA</Badge> : <span className="muted">0 lewat SLA</span>} · {p.awaitingFirstResponse} belum direspons · {p.dueWithin4h} &lt; 4 jam
                </span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
      <Card flush>
        <div className="filterbar">
          <Field label="SLA">
            <Segmented
              label="SLA"
              value={sla}
              onChange={setSla}
              options={[
                { key: '', label: 'Semua' },
                { key: 'BREACHED', label: 'Lewat SLA' },
                { key: 'DUE_SOON', label: '< 4 jam' },
              ]}
            />
          </Field>
          <Field label="Prioritas">
            <Select value={priority} onChange={setPriority} placeholder="Semua" options={['URGENT', 'HIGH', 'NORMAL', 'LOW']} />
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
            <Select value={status} onChange={setStatus} placeholder="Terbuka (default)" options={['OPEN', 'PENDING_USER', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']} />
          </Field>
        </div>
        <DataTable
          caption="Antrean tiket"
          rows={rows}
          loading={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
          rowKey={(t) => t.id}
          onRowClick={(t) => nav(`/support/${t.id}`)}
          rowLabel={(t) => `Buka tiket ${t.number}`}
          rowClassName={(t) => (t.slaState === 'BREACHED' ? 'row--danger' : undefined)}
          pagination={pagination}
          empty={{ title: 'Tidak ada tiket pada filter ini' }}
          columns={[
            { key: 'n', header: 'Tiket', render: (t) => <span className="stack" style={{ gap: 0 }}><span className="cell-primary mono">{t.number}</span><span className="cell-sub">{humanize(t.category)} · {t.channel}</span></span> },
            { key: 's', header: 'Subjek', render: (t) => <span className="truncate" style={{ maxWidth: 280, display: 'inline-block' }} title={t.subject}>{t.subject}</span> },
            { key: 'u', header: 'Pengguna', render: (t) => t.userDisplayName ?? '—' },
            { key: 'p', header: 'Prioritas', render: (t) => <StatusBadge status={t.priority} />, sortValue: (t) => ['URGENT', 'HIGH', 'NORMAL', 'LOW'].indexOf(t.priority) },
            { key: 'st', header: 'Status', render: (t) => <StatusBadge status={t.status} /> },
            { key: 'sla', header: 'SLA', render: (t) => <span className="stack" style={{ gap: 0 }}><SlaBadge state={t.slaState} /><span className="cell-sub"><DateTime value={t.slaDueAt} relative /></span></span>, sortValue: (t) => t.slaDueAt },
            { key: 'a', header: 'PJ', render: (t) => (t.assigneeId ? <IdText id={t.assigneeId} /> : <span className="muted">—</span>) },
            { key: 'c', header: 'Dibuat', render: (t) => <DateTime value={t.createdAt} />, sortValue: (t) => t.createdAt },
          ]}
        />
      </Card>
    </div>
  );
}
