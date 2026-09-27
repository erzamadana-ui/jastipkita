import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Dashboard, System } from '../api/admin';
import type { AdminMetric, SeriesMetric } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { CAP } from '../auth/permissions';
import { BarList, Funnel, LineChart } from '../components/charts';
import { DataTable } from '../components/DataTable';
import { KpiTile } from '../components/KpiTile';
import { Badge, Button, Callout, Card, InfoTip, LoadingBlock, ModeBadge, Money, PageHeader, Segmented, Select, StatusBadge } from '../components/ui';
import { defaultRange } from '../hooks/misc';
import { formatDate, formatDayShort, formatIdrCompact, formatNumber, formatPercent, humanize } from '../lib/format';
import { severityTone, statusTone, TX_STATUSES, txTone } from '../lib/status';

const GROUPS: { title: string; keys: string[] }[] = [
  { title: 'Uang & pendapatan', keys: ['gmv', 'platformRevenue', 'netRevenue', 'takeRate', 'netTakeRate', 'ledgerPlatformRevenue'] },
  { title: 'Transaksi', keys: ['transactionsCreated', 'completedTransactions', 'disputeRate', 'refundRate', 'refundedIdr'] },
  { title: 'Pengguna, traveler & trip', keys: ['usersTotal', 'usersNew', 'usersActive', 'travelersActive', 'tripsActive'] },
  { title: 'Risiko, referral, bea cukai & support', keys: ['fraudReviewsOpen', 'referralSpend', 'referralSpendMonthToDate', 'referralMonthlyCapPerReferrer', 'referrersAtCap', 'customsEstimatedIdr', 'customsDeclaredIdr', 'customsVarianceRatio', 'supportBacklog', 'supportSlaBreached'] },
];

const SERIES: { key: SeriesMetric; label: string }[] = [
  { key: 'gmv', label: 'GMV (transaksi selesai)' },
  { key: 'net_revenue', label: 'Pendapatan bersih' },
  { key: 'payments_secured_idr', label: 'Pembayaran SECURED (IDR)' },
  { key: 'transactions_created', label: 'Transaksi dibuat' },
  { key: 'transactions_completed', label: 'Transaksi selesai' },
  { key: 'signups', label: 'Pendaftaran' },
  { key: 'disputes_opened', label: 'Dispute dibuka' },
  { key: 'refunds_succeeded_idr', label: 'Refund berhasil (IDR)' },
];

const CHANNEL_LABEL: Record<string, string> = { VA: 'Virtual account', QRIS: 'QRIS', EWALLET: 'E-wallet', CARD: 'Kartu' };

export default function DashboardPage() {
  const { can } = useAuth();
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const range = useMemo(() => defaultRange(Number(days)), [days]);
  const [metric, setMetric] = useState<SeriesMetric>('gmv');
  const [interval, setInterval] = useState<'day' | 'week'>('day');

  const kpis = useQuery({ queryKey: ['dashboard', 'kpis', range.from, range.to], queryFn: () => Dashboard.kpis(range) });
  const series = useQuery({ queryKey: ['dashboard', 'ts', metric, interval, range.from, range.to], queryFn: () => Dashboard.timeseries({ metric, interval, ...range }) });
  const funnel = useQuery({ queryKey: ['dashboard', 'funnel', range.from, range.to], queryFn: () => Dashboard.funnel(range) });
  const alerts = useQuery({ queryKey: ['system', 'alerts'], queryFn: System.alerts, enabled: can(CAP.infraRead), refetchInterval: 60_000 });

  const byKey = useMemo(() => new Map((kpis.data?.metrics ?? []).map((m) => [m.key, m])), [kpis.data]);
  const known = new Set(GROUPS.flatMap((g) => g.keys));
  const extra = (kpis.data?.metrics ?? []).filter((m) => !known.has(m.key));
  const seriesDef = SERIES.find((s) => s.key === metric)!;
  const isIdr = series.data?.unit === 'IDR';
  const health = kpis.data?.systemHealth;

  return (
    <div className="stack stack--lg">
      <PageHeader
        title="Dashboard"
        subtitle={kpis.data ? `${formatDate(kpis.data.range.from)} – ${formatDate(kpis.data.range.to)} (WIB, inklusif) · dihitung langsung dari database` : 'Memuat periode…'}
        actions={
          <>
            <Segmented
              label="Periode"
              value={days}
              onChange={setDays}
              options={[
                { key: '7', label: '7 hari' },
                { key: '30', label: '30 hari' },
                { key: '90', label: '90 hari' },
              ]}
            />
            <Button icon="refresh" onClick={() => void Promise.all([kpis.refetch(), series.refetch(), funnel.refetch(), alerts.refetch()])} loading={kpis.isFetching}>
              Muat ulang
            </Button>
          </>
        }
      />

      {kpis.isError ? <Callout tone="danger">Gagal memuat KPI.</Callout> : null}

      <section className="grid grid-main-side" aria-label="Status sistem dan integrasi">
        <Card
          title="Status sistem"
          hint={health ? `Diperbarui ${new Date(kpis.data!.generatedAt).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' })} WIB` : undefined}
          actions={can(CAP.infraRead) ? <Link to="/infra">DB & Infra Center →</Link> : null}
        >
          {!health ? (
            <LoadingBlock rows={2} />
          ) : (
            <div className="stack">
              <div className="row">
                <StatusBadge status={health.status} />
                <span className="stat-inline">
                  <span className="v">{formatNumber(health.alertsOpen ?? 0)}</span>
                  <span className="l">alert terbuka</span>
                </span>
                <span className="stat-inline">
                  <span className="v">{formatNumber(health.outboxBacklog ?? 0)}</span>
                  <span className="l">outbox backlog</span>
                </span>
                <span className="stat-inline">
                  <span className="v">{formatNumber(health.deadJobs24h ?? 0)}</span>
                  <span className="l">job DEAD 24 jam</span>
                </span>
                <span className="stat-inline">
                  <span className="v">{formatNumber(health.webhookFailures24h ?? 0)}</span>
                  <span className="l">webhook gagal 24 jam</span>
                </span>
              </div>
              {alerts.data?.alerts.length ? (
                <ul className="stack stack--sm" style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label="Alert aktif">
                  {alerts.data.alerts.slice(0, 4).map((a) => (
                    <li key={a.code} className="row small">
                      <Badge tone={severityTone(a.severity)}>{a.severity}</Badge>
                      <code>{a.code}</code>
                      <span>{a.message}</span>
                    </li>
                  ))}
                </ul>
              ) : alerts.data ? (
                <p className="muted small">Tidak ada alert aktif.</p>
              ) : !can(CAP.infraRead) ? (
                <p className="muted small">Detail alert butuh izin infra.db.read.</p>
              ) : null}
            </div>
          )}
        </Card>
        <Card title="Mode integrasi" hint="MOCK/SANDBOX = bukan uang/pesan sungguhan">
          {health?.integrations ? (
            <div className="row" data-testid="integration-modes">
              {Object.entries(health.integrations)
                .filter(([k]) => k !== 'dbAdmin')
                .map(([k, v]) => (
                  <ModeBadge key={k} name={k} mode={v} />
                ))}
            </div>
          ) : (
            <LoadingBlock rows={2} />
          )}
        </Card>
      </section>

      {GROUPS.map((g) => (
        <section key={g.title} className="stack stack--sm" aria-label={g.title}>
          <h2 className="section-title">{g.title}</h2>
          <div className="kpi-grid">
            {kpis.isPending
              ? g.keys.map((k) => (
                  <div key={k} className="card kpi">
                    <LoadingBlock rows={2} />
                  </div>
                ))
              : g.keys.map((k) => byKey.get(k)).filter((m): m is AdminMetric => !!m).map((m) => <KpiTile key={m.key} metric={m} />)}
          </div>
        </section>
      ))}
      {extra.length ? (
        <section className="stack stack--sm" aria-label="KPI lainnya">
          <h2 className="section-title">Lainnya</h2>
          <div className="kpi-grid">
            {extra.map((m) => (
              <KpiTile key={m.key} metric={m} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="grid grid-main-side">
        <Card
          title={seriesDef.label}
          hint={series.data ? <span className="row row--tight">{series.data.definition}</span> : undefined}
          actions={
            <>
              <Select aria-label="Metrik" value={metric} onChange={(v) => setMetric(v as SeriesMetric)} options={SERIES.map((s) => ({ value: s.key, label: s.label }))} className="select--sm" />
              <Segmented
                label="Interval"
                value={interval}
                onChange={setInterval}
                options={[
                  { key: 'day', label: 'Harian' },
                  { key: 'week', label: 'Mingguan' },
                ]}
              />
            </>
          }
          footer={series.data?.dataQuality ? <span className="kpi__quality">⚠ {series.data.dataQuality}</span> : series.data ? `Sampel n = ${formatNumber(series.data.sampleSize)} · bucket WIB, diisi nol` : null}
        >
          {series.data ? (
            <LineChart
              label={seriesDef.label}
              points={series.data.points.map((p) => ({ x: p.bucket, y: p.value, n: p.sampleSize }))}
              formatY={(v) => (isIdr ? formatIdrCompact(v) : formatNumber(v))}
              formatX={formatDayShort}
            />
          ) : (
            <LoadingBlock rows={6} />
          )}
        </Card>
        <Card title="Funnel" hint={funnel.data?.note} footer={funnel.data?.dataQuality ? <span className="kpi__quality">⚠ {funnel.data.dataQuality}</span> : 'Metode: hitungan peristiwa per langkah (bukan kohort).'}>
          {funnel.data ? (
            <Funnel
              label="Funnel install sampai repeat"
              formatCount={formatNumber}
              formatRatio={formatPercent}
              steps={funnel.data.steps.map((s) => ({
                key: s.step,
                label: (
                  <>
                    {humanize(s.step)} <InfoTip label={`Definisi ${s.step}`}>{s.definition}</InfoTip>
                  </>
                ),
                count: s.count,
                conversion: s.conversionFromPrevious,
                tone: s.dataQuality ? 'warning' : 'info',
                note: s.dataQuality ? <span className="kpi__quality">⚠ {s.dataQuality}</span> : null,
              }))}
            />
          ) : (
            <LoadingBlock rows={8} />
          )}
        </Card>
      </section>

      <section className="grid grid-2">
        <Card title="Transaksi per status" hint={kpis.data?.definitions.transactionsByStatus}>
          {kpis.data ? (
            <BarList
              label="Transaksi per status"
              items={[...kpis.data.breakdowns.transactionsByStatus]
                .sort((a, b) => TX_STATUSES.indexOf(a.status) - TX_STATUSES.indexOf(b.status))
                .map((s) => ({ key: s.status, label: humanize(s.status), value: s.count, tone: txTone(s.status), display: formatNumber(s.count) }))}
            />
          ) : (
            <LoadingBlock />
          )}
        </Card>
        <Card title="Pembayaran per kanal" hint={kpis.data?.definitions.paymentsByChannel} flush>
          <DataTable
            compact
            caption="Pembayaran per kanal"
            rows={kpis.data?.breakdowns.paymentsByChannel}
            loading={kpis.isPending}
            rowKey={(r) => r.channel}
            empty={{ title: 'Belum ada pembayaran SECURED pada periode ini' }}
            columns={[
              { key: 'channel', header: 'Kanal', render: (r) => <span className="stack" style={{ gap: 0 }}><strong>{CHANNEL_LABEL[r.channel] ?? r.channel}</strong><code className="cell-sub">{r.channel}</code></span> },
              { key: 'count', header: 'Jumlah', align: 'right', render: (r) => formatNumber(r.count), sortValue: (r) => r.count },
              { key: 'amount', header: 'Nominal', align: 'right', render: (r) => <Money value={r.amountIdr} />, sortValue: (r) => r.amountIdr },
            ]}
          />
        </Card>
        <Card title="Backlog support per prioritas" hint={kpis.data?.definitions.supportBacklogByPriority} flush>
          <DataTable
            compact
            caption="Backlog support per prioritas"
            rows={kpis.data?.breakdowns.supportBacklogByPriority}
            loading={kpis.isPending}
            rowKey={(r) => r.priority}
            empty={{ title: 'Tidak ada tiket terbuka' }}
            columns={[
              { key: 'p', header: 'Prioritas', render: (r) => <StatusBadge status={r.priority} /> },
              { key: 'open', header: 'Terbuka', align: 'right', render: (r) => formatNumber(r.open) },
              { key: 'b', header: 'Lewat SLA', align: 'right', render: (r) => (r.slaBreached ? <Badge tone="danger">{r.slaBreached}</Badge> : '0') },
            ]}
          />
        </Card>
        <Card title="Review fraud terbuka per subjek" hint={kpis.data?.definitions.fraudReviewsBySubject}>
          {kpis.data ? (
            kpis.data.breakdowns.fraudReviewsBySubject.length ? (
              <BarList label="Review fraud per subjek" items={kpis.data.breakdowns.fraudReviewsBySubject.map((f) => ({ key: f.subjectType, label: humanize(f.subjectType), value: f.count, tone: statusTone('REVIEW'), display: formatNumber(f.count) }))} />
            ) : (
              <p className="muted small">Tidak ada review terbuka.</p>
            )
          ) : (
            <LoadingBlock />
          )}
        </Card>
      </section>

      <footer className="footer-note">
        <strong>Catatan data:</strong> {(kpis.data?.notes ?? []).join(' ')} Rasio dengan sampel &lt; 30 ditandai dan bukan dasar keputusan. Tanggal = hari kalender WIB.
      </footer>
    </div>
  );
}
