import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Infra, System } from '../../api/admin';
import { describeError } from '../../api/errors';
import type { ConnectionTest, DbOperation, DbOperationDetail, WorkflowStep } from '../../api/types';
import { useAuth, useCan } from '../../auth/AuthProvider';
import { CAP } from '../../auth/permissions';
import { ActionDialog } from '../../components/ActionDialog';
import { BarList } from '../../components/charts';
import { DataTable } from '../../components/DataTable';
import { JsonView } from '../../components/data';
import { Badge, Button, Callout, Card, Checkbox, DateTime, Field, IdText, KeyValue, LoadingBlock, Meter, ModeBadge, PageHeader, StatusBadge, TabPanel, Tabs } from '../../components/ui';
import { useAdminAction } from '../../hooks/useAdminAction';
import { formatBytes, formatNumber, formatPercent, humanize, wibDate, addDays } from '../../lib/format';
import { severityTone } from '../../lib/status';

type Tab = 'health' | 'schema' | 'storage' | 'backups' | 'workflow' | 'provider';

export default function InfraPage() {
  const [tab, setTab] = useState<Tab>('health');
  const op = useCan(CAP.infraOperate);
  return (
    <div className="stack stack--lg">
      <PageHeader title="DB & Infra Center" subtitle="Kesehatan database & sistem, skema/migrasi, storage, backup/restore, workflow migrasi 8 langkah." />
      <Callout tone="info" icon="lock" title="Kredensial tidak pernah ditampilkan atau dapat diubah di sini.">
        Host dimasking, connection string & API key provider hanya ada di secret store server. Tidak ada DDL dari UI — migrasi dijalankan dari CI; UI mencatat & menyetujui prosesnya.
        {!op.allowed ? <> Aksi (backup/restore/workflow) butuh SUPER_ADMIN + infra.db.operate + MFA — Anda mode baca.</> : null}
      </Callout>
      <Tabs
        label="DB & Infra"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'health', label: 'Kesehatan' },
          { key: 'schema', label: 'Skema & migrasi' },
          { key: 'storage', label: 'Storage' },
          { key: 'backups', label: 'Backup & restore' },
          { key: 'workflow', label: 'Workflow migrasi' },
          { key: 'provider', label: 'Provider & koneksi' },
        ]}
      />
      {tab === 'health' ? <HealthTab /> : null}
      {tab === 'schema' ? <SchemaTab /> : null}
      {tab === 'storage' ? <StorageTab /> : null}
      {tab === 'backups' ? <BackupsTab /> : null}
      {tab === 'workflow' ? <WorkflowTab /> : null}
      {tab === 'provider' ? <ProviderTab /> : null}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'danger' | 'warning' }) {
  return (
    <div className="stat-inline">
      <span className="l">{label}</span>
      <span className="v" style={tone ? { color: tone === 'danger' ? 'var(--jk-color-error-text)' : 'var(--jk-color-warning-text)' } : undefined}>
        {value}
      </span>
    </div>
  );
}

function HealthTab() {
  const db = useQuery({ queryKey: ['infra', 'db-health'], queryFn: Infra.health, refetchInterval: 30_000 });
  const sys = useQuery({ queryKey: ['system', 'health'], queryFn: System.health, refetchInterval: 30_000 });
  const alerts = useQuery({ queryKey: ['system', 'alerts'], queryFn: System.alerts, refetchInterval: 60_000 });
  const h = sys.data;
  const d = db.data;
  return (
    <TabPanel id="health">
      <div className="grid grid-2">
        <Card title="Database" hint={d ? `${d.server.versionString} · ${d.target.host ?? '—'}:${d.target.port ?? '—'} · db ${d.target.database ?? '—'} · SSL ${d.target.ssl ? 'ya' : 'tidak'}` : undefined} actions={d ? <StatusBadge status={h?.database.ok === false ? 'DOWN' : 'UP'} /> : null}>
          {!d ? (
            <LoadingBlock rows={5} />
          ) : (
            <div className="stack">
              <div className="grid grid-4">
                <Stat label="Latensi" value={`${d.latencyMs} ms`} />
                <Stat label="Ukuran" value={formatBytes(d.sizeBytes)} />
                <Stat label="Cache hit" value={formatPercent(d.cacheHitRatio, 2)} tone={d.cacheHitRatio !== null && d.cacheHitRatio < 0.95 ? 'warning' : undefined} />
                <Stat label="Query > 30 dtk" value={d.longRunningQueries.count} tone={d.longRunningQueries.count ? 'warning' : undefined} />
              </div>
              <div className="stack stack--sm">
                <span className="small">
                  Koneksi {d.connections.total} / {d.connections.max} ({formatPercent(d.connections.utilization, 0)})
                </span>
                <Meter ratio={d.connections.utilization} label="Utilisasi koneksi" tone={(d.connections.utilization ?? 0) > 0.85 ? 'danger' : (d.connections.utilization ?? 0) > 0.7 ? 'warn' : undefined} />
                <span className="small muted">{d.connections.byState.map((s) => `${s.state}: ${s.count}`).join(' · ')}</span>
              </div>
              <KeyValue
                cols={2}
                items={[
                  ['Commit / rollback', `${formatNumber(d.transactions.commits)} / ${formatNumber(d.transactions.rollbacks)}`],
                  ['Deadlock', formatNumber(d.transactions.deadlocks)],
                  ['Replika', d.replication.isReplica ? 'ya' : 'tidak'],
                  ['WAL sender', d.replication.walSenders],
                  ['Zona waktu', d.server.timezone],
                  ['Mulai', <DateTime value={d.server.startedAt} />],
                ]}
              />
              {d.dataQuality ? <p className="kpi__quality">⚠ {d.dataQuality}</p> : null}
            </div>
          )}
        </Card>
        <Card title="Alert aktif" hint="Ambang: docs/06-observability.md §3 (ALERT_THRESHOLDS)" actions={alerts.data ? <StatusBadge status={alerts.data.status} /> : null} flush>
          <DataTable
            compact
            caption="Alert aktif"
            rows={alerts.data?.alerts}
            loading={alerts.isPending}
            error={alerts.error}
            rowKey={(a) => a.code}
            empty={{ title: 'Tidak ada alert aktif' }}
            columns={[
              { key: 's', header: 'Sev', render: (a) => <Badge tone={severityTone(a.severity)}>{a.severity}</Badge> },
              { key: 'c', header: 'Kode', render: (a) => <span className="stack" style={{ gap: 0 }}><code>{a.code}</code><span className="cell-sub">{a.message}</span></span> },
              { key: 'v', header: 'Nilai / ambang', align: 'right', render: (a) => `${formatNumber(a.value)} / ${formatNumber(a.threshold)}` },
              { key: 'f', header: 'Sejak', render: (a) => <span className="stack" style={{ gap: 0 }}><DateTime value={a.firstSeenAt} relative /><span className="cell-sub">{a.occurrences}× terlihat</span></span> },
            ]}
          />
        </Card>
      </div>
      <Card title="Observability sistem" hint={h ? `Status ${h.status} · diperbarui ${new Date(h.generatedAt).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB` : undefined}>
        {!h ? (
          <LoadingBlock rows={4} />
        ) : (
          <div className="grid grid-4">
            <Card title="Outbox">
              <KeyValue items={[['Backlog', <span className={h.outbox.backlog >= 100 ? 'badge badge--warning' : undefined}>{formatNumber(h.outbox.backlog)}</span>], ['Tertua', h.outbox.oldestUnpublishedAgeSec !== null ? `${Math.round(h.outbox.oldestUnpublishedAgeSec / 60)} mnt` : '—'], ['Retry ≥ 3', h.outbox.retryingEvents]]} />
            </Card>
            <Card title="Job">
              <KeyValue items={[['Antre / jalan', `${h.jobs.queued} / ${h.jobs.running}`], ['Terlambat > 10 mnt', h.jobs.overdue], ['DEAD 24 jam', h.jobs.dead24h ? <Badge tone="danger">{h.jobs.dead24h}</Badge> : '0'], ['DEAD total', h.jobs.deadTotal], ['Lease kedaluwarsa', h.jobs.expiredLeases]]} />
            </Card>
            <Card title="Webhook pembayaran">
              <KeyValue items={[['Diterima 24 jam', h.webhooks.received24h], ['Gagal 24 jam', h.webhooks.failed24h ? <Badge tone="danger">{h.webhooks.failed24h}</Badge> : '0'], ['Belum diproses > 10 mnt', h.webhooks.unprocessedOlderThan10m], ['Signature invalid', h.webhooks.invalidSignature24h]]} />
            </Card>
            <Card title="Security events 24 jam">
              <KeyValue items={[['HIGH/CRITICAL', h.security.highOrCritical24h], ['CRITICAL', h.security.critical24h ? <Badge tone="danger">{h.security.critical24h}</Badge> : '0'], ['Rantai audit', <StatusBadge status={h.auditChain.status ?? 'UNKNOWN'} />], ['Dicek', <DateTime value={h.auditChain.checkedAt} relative />]]} />
              {h.security.byType.length ? <p className="small muted" style={{ marginTop: 8 }}>{h.security.byType.map((t) => `${t.type} ${t.count}`).join(' · ')}</p> : null}
            </Card>
            <Card title="Refund">
              <KeyValue items={[['FAILED', h.refunds.failed], ['Menunggu approval', h.refunds.pendingApproval], ['> 24 jam', h.refunds.pendingApprovalOlderThan24h], ['PROCESSING > 1 jam', h.refunds.processingOlderThan1h]]} />
            </Card>
            <Card title="Payout">
              <KeyValue items={[['FAILED', h.payouts.failed], ['ON_HOLD', h.payouts.onHold], ['Hold > 48 jam', h.payouts.onHoldOlderThan48h], ['PROCESSING > 1 jam', h.payouts.processingOlderThan1h]]} />
            </Card>
            <Card title="Notifikasi & SLA">
              <KeyValue items={[['Pengiriman 24 jam', h.notifications.deliveries24h], ['Gagal', `${h.notifications.failed24h} (${formatPercent(h.notifications.failureRate)})`], ['Dispute lewat SLA', h.disputes.slaBreachedOpen], ['Tiket lewat SLA', h.support.firstResponseBreached]]} />
            </Card>
            <Card title="Integrasi">
              <div className="row">
                {Object.entries(h.integrations).map(([k, v]) => (
                  <ModeBadge key={k} name={k} mode={v} />
                ))}
              </div>
            </Card>
          </div>
        )}
      </Card>
    </TabPanel>
  );
}

function SchemaTab() {
  const q = useQuery({ queryKey: ['infra', 'migrations'], queryFn: Infra.migrations });
  const m = q.data;
  return (
    <TabPanel id="schema">
      {m ? (
        <>
          <Callout tone={m.inSync ? 'success' : 'danger'} title={m.inSync ? 'Skema sinkron dengan build.' : 'Skema TIDAK sinkron dengan build.'}>
            Skema DB <code>{m.schemaVersion ?? '—'}</code> · manifest build <code>{m.buildVersion ?? '—'}</code> · applied {m.summary.applied} · pending {m.summary.pending} · checksum drift {m.summary.checksumDrift} · tidak dikenal build {m.summary.unknownInBuild}. {m.note}
          </Callout>
        </>
      ) : null}
      <Card title="Migrasi (checksum SHA-256 per file vs schema_migrations)" flush>
        <DataTable
          compact
          caption="Migrasi skema"
          rows={m?.migrations}
          loading={q.isPending}
          error={q.error}
          rowKey={(r) => r.version}
          rowClassName={(r) => (r.status === 'CHECKSUM_DRIFT' || r.status === 'UNKNOWN_IN_BUILD' ? 'row--danger' : r.status === 'PENDING' ? 'row--highlight' : undefined)}
          columns={[
            { key: 'v', header: 'Versi', render: (r) => <code className="cell-primary">{r.version}</code>, sortValue: (r) => r.version },
            { key: 'n', header: 'Nama', render: (r) => r.name },
            { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.status} label={humanize(r.status)} /> },
            { key: 'f', header: 'Checksum file', render: (r) => <code className="small" title={r.fileChecksum ?? ''}>{r.fileChecksum ? `${r.fileChecksum.slice(0, 12)}…` : '—'}</code> },
            { key: 'a', header: 'Checksum DB', render: (r) => <code className="small" title={r.appliedChecksum ?? ''} style={r.status === 'CHECKSUM_DRIFT' ? { color: 'var(--jk-color-error-text)' } : undefined}>{r.appliedChecksum ? `${r.appliedChecksum.slice(0, 12)}…` : '—'}</code> },
            { key: 't', header: 'Diterapkan', render: (r) => <DateTime value={r.appliedAt} /> },
            { key: 'ms', header: 'Durasi', align: 'right', render: (r) => (r.executionMs !== null ? `${formatNumber(r.executionMs)} ms` : '—') },
            { key: 'by', header: 'Oleh', render: (r) => <code>{r.appliedBy ?? '—'}</code> },
          ]}
        />
      </Card>
    </TabPanel>
  );
}

function StorageTab() {
  const q = useQuery({ queryKey: ['infra', 'storage'], queryFn: () => Infra.storage(20) });
  return (
    <TabPanel id="storage">
      <Card title={q.data ? `Database ${formatBytes(q.data.databaseBytes)}` : 'Storage'} hint={q.data?.definition}>
        {q.data ? <BarList label="Tabel terbesar" items={q.data.tables.map((t) => ({ key: t.table, label: <code>{t.table}</code>, sub: `≈ ${formatNumber(t.estimatedRows)} baris · tabel ${formatBytes(t.tableBytes)} · indeks ${formatBytes(t.indexBytes)}`, value: t.totalBytes, display: formatBytes(t.totalBytes) }))} /> : <LoadingBlock rows={8} />}
      </Card>
    </TabPanel>
  );
}

function ProviderTab() {
  const q = useQuery({ queryKey: ['infra', 'provider'], queryFn: Infra.provider });
  const [test, setTest] = useState<ConnectionTest | null>(null);
  const run = useAdminAction({ run: () => Infra.connectionTest(), invalidate: [['infra', 'ops']], onSuccess: setTest, success: (r) => (r.ok ? `Koneksi OK · rata-rata ${r.avgMs} ms` : 'Koneksi GAGAL') });
  const p = q.data;
  return (
    <TabPanel id="provider">
      <div className="grid grid-2">
        <Card title="Provider & kapabilitas">
          {!p ? (
            <LoadingBlock />
          ) : (
            <div className="stack">
              <KeyValue
                items={[
                  ['Admin provider', <code>{p.provider}</code>],
                  ['DB provider', <code>{p.dbProvider}</code>],
                  ['Target', `${p.target.host ?? '—'}:${p.target.port ?? '—'} · db ${p.target.database ?? '—'} · SSL ${p.target.ssl ? 'ya' : 'tidak'}`],
                  ['Kapabilitas', <span className="row row--tight">{Object.entries(p.capabilities).map(([k, v]) => <Badge key={k} tone={v ? 'success' : 'neutral'}>{k}</Badge>)}</span>],
                  ['Backup', p.backupsManagedOutsideApp ? 'Dikelola di luar aplikasi (pg_dump / konsol provider)' : 'Via provider API'],
                  ['Kredensial', p.credentials],
                ]}
              />
              <details>
                <summary className="small">Info provider</summary>
                <JsonView value={p.info} />
              </details>
            </div>
          )}
        </Card>
        <Card title="Uji koneksi" hint="3 × SELECT 1 — dicatat sebagai db_operations CONNECTION_TEST" actions={<Button icon="play" onClick={() => run.mutate(undefined)} loading={run.isPending}>Jalankan</Button>}>
          {test ? (
            <KeyValue items={[['Hasil', test.ok ? <Badge tone="success">OK</Badge> : <Badge tone="danger">GAGAL</Badge>], ['Sampel', test.samplesMs.map((s) => `${s} ms`).join(', ')], ['Rata-rata', test.avgMs !== null ? `${test.avgMs} ms` : '—'], ['Galat (disanitasi)', test.error ?? '—'], ['Operasi', <IdText id={test.operationId} />]]} />
          ) : (
            <p className="muted small">Belum dijalankan.</p>
          )}
        </Card>
      </div>
    </TabPanel>
  );
}

function OperationsTable({ ops, loading }: { ops: DbOperation[] | undefined; loading: boolean }) {
  const { me } = useAuth();
  const op = useCan(CAP.infraOperate);
  const [dlg, setDlg] = useState<{ kind: 'approve' | 'cancel'; o: DbOperation } | null>(null);
  const act = useAdminAction({ run: (v: { kind: 'approve' | 'cancel'; o: DbOperation; text: string }) => (v.kind === 'approve' ? Infra.approveOperation(v.o.id, v.text || undefined) : Infra.cancelOperation(v.o.id, v.text)), invalidate: [['infra']], toastErrors: false, success: (r) => `Operasi ${r.type} → ${r.status}` });
  return (
    <>
      <DataTable
        compact
        caption="Operasi DB"
        rows={ops}
        loading={loading}
        rowKey={(o) => o.id}
        empty={{ title: 'Belum ada operasi' }}
        columns={[
          { key: 't', header: 'Jenis', render: (o) => <Badge tone="info" dot={false}>{o.type}</Badge> },
          { key: 's', header: 'Status', render: (o) => <StatusBadge status={o.status} /> },
          { key: 'env', header: 'Lingkungan', render: (o) => o.environment },
          { key: 'r', header: 'Alasan', render: (o) => <span className="small">{o.reason ?? '—'}</span> },
          { key: 'by', header: 'Diminta / disetujui', render: (o) => <span className="row row--tight"><IdText id={o.requestedBy} /> → <IdText id={o.approvedBy} /></span> },
          { key: 'c', header: 'Dibuat', render: (o) => <DateTime value={o.createdAt} /> },
          {
            key: 'a',
            header: 'Aksi',
            render: (o) =>
              ['REQUESTED', 'APPROVED'].includes(o.status) ? (
                <span className="btn-group">
                  {o.status === 'REQUESTED' ? (
                    <Button size="sm" variant="success" mfa disabledReason={op.reason ?? (o.requestedBy === me?.id ? 'Anda pengaju — butuh SUPER_ADMIN lain' : null)} onClick={() => setDlg({ kind: 'approve', o })}>
                      Setujui
                    </Button>
                  ) : null}
                  <Button size="sm" variant="danger-outline" mfa disabledReason={op.reason} onClick={() => setDlg({ kind: 'cancel', o })}>
                    Batalkan
                  </Button>
                </span>
              ) : null,
          },
        ]}
      />
      <ActionDialog
        open={!!dlg}
        onClose={() => setDlg(null)}
        title={dlg ? `${dlg.kind === 'approve' ? 'Setujui' : 'Batalkan'} operasi ${dlg.o.type}` : ''}
        description={dlg?.kind === 'approve' && dlg.o.type === 'RESTORE' ? 'Restore berjalan segera ke branch/database BARU (tidak pernah in-place).' : undefined}
        confirmLabel={dlg?.kind === 'approve' ? 'Setujui operasi' : 'Batalkan operasi'}
        tone={dlg?.kind === 'approve' ? 'success' : 'danger'}
        mfa
        reason={dlg?.kind === 'approve' ? { label: 'Catatan (opsional)', required: false, minLength: 0 } : { minLength: 5 }}
        onConfirm={(text) => act.mutateAsync({ ...dlg!, text })}
      />
    </>
  );
}

function BackupsTab() {
  const op = useCan(CAP.infraOperate);
  const q = useQuery({ queryKey: ['infra', 'backups'], queryFn: Infra.backups });
  const ops = useQuery({ queryKey: ['infra', 'ops', 'all'], queryFn: () => Infra.operations({ limit: 50 }) });
  const [dlg, setDlg] = useState<null | 'backup' | 'restore' | 'export'>(null);
  const [label, setLabel] = useState('');
  const [backupId, setBackupId] = useState('');
  const [pit, setPit] = useState('');
  const [from, setFrom] = useState(addDays(wibDate(), -29));
  const [to, setTo] = useState(wibDate());
  const inv = [['infra']];
  const backup = useAdminAction({ run: (reason: string) => Infra.createBackup(label, reason), invalidate: inv, toastErrors: false, success: 'Backup dibuat' });
  const restore = useAdminAction({ run: (reason: string) => Infra.restore({ label, reason, ...(backupId ? { backupId } : {}), ...(pit ? { pointInTime: new Date(pit).toISOString() } : {}) }), invalidate: inv, toastErrors: false, success: (r) => r.note });
  const exp = useAdminAction({ run: (reason: string) => Infra.exportAnalytics({ from, to, reason }), invalidate: inv, toastErrors: false, success: (r) => r.note });
  const b = q.data;
  return (
    <TabPanel id="backups">
      {b?.managedOutsideApp ? <Callout tone="warning" title={`Provider ${b.provider}: backup & PITR dikelola di luar aplikasi.`}>{b.note} Tombol backup/restore mengembalikan 422 BACKUP_MANAGED_OUTSIDE_APP / RESTORE_MANAGED_OUTSIDE_APP.</Callout> : null}
      <Card
        title="Backup"
        actions={
          <>
            <Button icon="database" mfa onClick={() => setDlg('backup')} disabledReason={op.reason ?? (b?.managedOutsideApp ? 'Dikelola di luar aplikasi' : null)}>
              Buat backup
            </Button>
            <Button mfa onClick={() => setDlg('restore')} disabledReason={op.reason ?? (b?.managedOutsideApp ? 'Dikelola di luar aplikasi' : null)}>
              Restore ke branch baru
            </Button>
            <Button icon="download" mfa onClick={() => setDlg('export')} disabledReason={op.reason}>
              Ekspor analitik anonim
            </Button>
          </>
        }
        flush
      >
        {b?.error ? <Callout tone="danger">{b.error}</Callout> : null}
        <DataTable
          compact
          caption="Backup provider"
          rows={b?.backups}
          loading={q.isPending}
          error={q.error}
          rowKey={(x) => x.id}
          empty={{ title: b?.managedOutsideApp ? 'Backup tidak dikelola aplikasi' : 'Belum ada backup' }}
          columns={[
            { key: 'id', header: 'ID', render: (x) => <code>{x.id}</code> },
            { key: 'k', header: 'Jenis', render: (x) => x.kind },
            { key: 's', header: 'Status', render: (x) => <StatusBadge status={x.status} /> },
            { key: 'z', header: 'Ukuran', align: 'right', render: (x) => formatBytes(x.sizeBytes) },
            { key: 'c', header: 'Dibuat', render: (x) => <DateTime value={x.createdAt} /> },
          ]}
        />
      </Card>
      <Card title="Log operasi DB (db_operations)" hint="RESTORE / IMPORT / SWITCH / ROLLBACK butuh SUPER_ADMIN kedua (DB CHECK)" flush>
        <OperationsTable ops={ops.data?.data} loading={ops.isPending} />
      </Card>
      <AuditCheckpointCard />
      <ActionDialog open={dlg === 'backup'} onClose={() => setDlg(null)} title="Buat backup (branch provider)" confirmLabel="Buat backup" mfa canConfirm={label.trim().length > 2} onConfirm={(r) => backup.mutateAsync(r)}>
        <Field label="Label" required>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="pre-migration-0070" />
        </Field>
      </ActionDialog>
      <ActionDialog open={dlg === 'restore'} onClose={() => setDlg(null)} title="Minta restore ke branch/database BARU" description="Tidak pernah in-place. Berjalan setelah SUPER_ADMIN lain menyetujui." confirmLabel="Minta restore" tone="danger" mfa canConfirm={label.trim().length > 2 && (!!backupId || !!pit)} onConfirm={(r) => restore.mutateAsync(r)}>
        <div className="form-grid">
          <Field label="Label branch baru" required>
            <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
          </Field>
          <Field label="Backup ID">
            <select className="select" value={backupId} onChange={(e) => setBackupId(e.target.value)}>
              <option value="">— tidak —</option>
              {(b?.backups ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.id}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Point in time (opsional)">
            <input className="input" type="datetime-local" value={pit} onChange={(e) => setPit(e.target.value)} />
          </Field>
        </div>
      </ActionDialog>
      <ActionDialog open={dlg === 'export'} onClose={() => setDlg(null)} title="Ekspor analitik anonim" description="Agregat harian saja (funnel, GMV, take rate, hitungan event) — tanpa ID pengguna atau teks bebas. File EXPORT terenkripsi, 7 hari, hanya pemohon." confirmLabel="Minta ekspor" mfa onConfirm={(r) => exp.mutateAsync(r)}>
        <div className="form-grid">
          <Field label="Dari" required>
            <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Sampai" required>
            <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
      </ActionDialog>
    </TabPanel>
  );
}

const STORAGE_LABEL: Record<string, string> = {
  MATCH: 'Objek cocok',
  MISMATCH: 'Objek TIDAK cocok',
  MISSING: 'Objek tidak ada',
  ERROR: 'Storage error',
  SKIPPED: 'Belum ada objek',
};

/** T12: daily audit chain checkpoint (DB row + WORM object) and the read-only verification since the last one. */
export function AuditCheckpointCard() {
  const q = useQuery({ queryKey: ['infra', 'audit-checkpoints'], queryFn: Infra.auditCheckpoints });
  const v = q.data;
  const cp = v?.checkpoint ?? null;
  return (
    <Card
      title="Checkpoint rantai audit (WORM)"
      hint="Job harian infra.audit_checkpoint → tabel audit_checkpoints + objek audit-checkpoints/YYYY/MM/DD.json. Verifikasi read-only: hitung ulang rantai sejak checkpoint terakhir."
      actions={
        <>
          {v ? <StatusBadge status={v.status} label={v.status === 'NO_CHECKPOINT' ? 'Belum ada checkpoint' : v.status} /> : null}
          <Button size="sm" icon="refresh" onClick={() => void q.refetch()} loading={q.isFetching}>
            Verifikasi ulang
          </Button>
        </>
      }
    >
      {q.error ? (
        <Callout tone="danger" title={describeError(q.error).title}>{describeError(q.error).detail}</Callout>
      ) : !v ? (
        <LoadingBlock rows={4} />
      ) : (
        <div className="stack">
          {v.findings.length ? (
            <Callout tone="danger" title="Rantai audit TIDAK cocok dengan checkpoint — tangani sebagai insiden keamanan (docs/runbooks/security-incident.md).">
              <ul>{v.findings.map((f) => <li key={f}>{f}</li>)}</ul>
            </Callout>
          ) : null}
          {v.warnings.length ? (
            <Callout tone="warning">
              <ul>{v.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            </Callout>
          ) : null}
          <div className="grid grid-4">
            <Stat label="Checkpoint terakhir" value={cp ? cp.day : '—'} tone={!cp || cp.ageSec > 26 * 3600 ? 'warning' : undefined} />
            <Stat label="Id / jumlah baris" value={cp ? `#${formatNumber(cp.lastId)} / ${formatNumber(cp.rowCount)}` : '—'} />
            <Stat label="Baris sejak checkpoint" value={formatNumber(v.segment.rowsSinceCheckpoint)} />
            <Stat label="Objek storage" value={STORAGE_LABEL[v.storage.status] ?? v.storage.status} tone={v.storage.status === 'MISMATCH' ? 'danger' : v.storage.status === 'MATCH' || v.storage.status === 'SKIPPED' ? undefined : 'warning'} />
          </div>
          <KeyValue
            cols={2}
            items={[
              ['Anchor (hash di last_id)', v.anchor ? (v.anchor.hashMatches && v.anchor.rowCountMatches ? <Badge tone="success">cocok</Badge> : <Badge tone="danger">tidak cocok</Badge>) : '—'],
              ['Segmen diverifikasi', `#${formatNumber(v.segment.fromId)} … #${formatNumber(v.segment.toId)}${v.segment.brokenAtId !== null ? ` · rusak di #${v.segment.brokenAtId}` : ''}`],
              ['Storage', <span className="row row--tight"><ModeBadge name="storage" mode={v.storage.mode} /><code className="small">{v.storage.key ?? '—'}</code></span>],
              ['Checkpoint tercatat', `${v.history.checkpoints}${v.history.mismatched.length ? ` · ${v.history.mismatched.length} tidak cocok` : ''}`],
              ['Dibuat', cp ? <DateTime value={cp.createdAt} relative /> : '—'],
              ['Dicek', <span><DateTime value={v.checkedAt} relative /> · {v.durationMs} ms</span>],
            ]}
          />
          {v.recent.length ? (
            <details>
              <summary className="small">10 checkpoint terakhir</summary>
              <DataTable
                compact
                caption="Checkpoint audit terakhir"
                rows={v.recent}
                rowKey={(r) => r.day}
                columns={[
                  { key: 'd', header: 'Hari (UTC)', render: (r) => <code>{r.day}</code> },
                  { key: 'i', header: 'Last id', align: 'right', render: (r) => formatNumber(r.lastId) },
                  { key: 'n', header: 'Baris', align: 'right', render: (r) => formatNumber(r.rowCount) },
                  { key: 'm', header: 'Storage', render: (r) => r.storageMode },
                  { key: 'c', header: 'Dibuat', render: (r) => <DateTime value={r.createdAt} /> },
                ]}
              />
            </details>
          ) : null}
          <p className="small muted">{v.note}</p>
        </div>
      )}
    </Card>
  );
}

const STEP_LABEL: Record<string, string> = {
  PRE_CHECK: 'Pre-check',
  BACKUP: 'Backup',
  SCHEMA_MIGRATION: 'Migrasi skema (CI)',
  DATA_MIGRATION: 'Migrasi data',
  VALIDATION: 'Validasi',
  SWITCH: 'Switch',
  MONITORING: 'Monitoring',
  ROLLBACK: 'Rollback',
};

function WorkflowTab() {
  const op = useCan(CAP.infraOperate);
  const { me } = useAuth();
  const list = useQuery({ queryKey: ['infra', 'ops', 'migration'], queryFn: () => Infra.operations({ type: 'MIGRATION', limit: 10 }) });
  const current = list.data?.data.find((o) => ['REQUESTED', 'APPROVED', 'RUNNING'].includes(o.status)) ?? list.data?.data[0] ?? null;
  const detail = useQuery({ queryKey: ['infra', 'op', current?.id], queryFn: () => Infra.operation(current!.id), enabled: !!current });
  const [startOpen, setStartOpen] = useState(false);
  const [target, setTarget] = useState('');
  const [desc, setDesc] = useState('');
  const [ci, setCi] = useState('');
  const start = useAdminAction({ run: (reason: string) => Infra.startWorkflow({ targetVersion: target, description: desc, reason, ...(ci ? { ciRunUrl: ci } : {}) }), invalidate: [['infra']], toastErrors: false, success: 'Workflow migrasi dibuat — menunggu persetujuan rencana' });
  const [planDlg, setPlanDlg] = useState(false);
  const approvePlan = useAdminAction({ run: (note: string) => Infra.approveOperation(current!.id, note || undefined), invalidate: [['infra']], toastErrors: false, success: 'Rencana migrasi disetujui' });
  const d = detail.data;
  const openOne = list.data?.data.some((o) => ['REQUESTED', 'APPROVED', 'RUNNING'].includes(o.status));
  return (
    <TabPanel id="workflow">
      <Card
        title="Workflow migrasi 8 langkah"
        hint="PRE_CHECK → BACKUP → SCHEMA_MIGRATION → DATA_MIGRATION → VALIDATION → SWITCH → MONITORING (→ ROLLBACK). DDL selalu dari CI."
        actions={
          <Button variant="primary" icon="plus" mfa onClick={() => setStartOpen(true)} disabledReason={op.reason ?? (openOne ? 'Masih ada workflow berjalan' : null)}>
            Mulai workflow
          </Button>
        }
      >
        {!current ? (
          list.isPending ? <LoadingBlock /> : <p className="muted small">Belum ada workflow migrasi.</p>
        ) : !d ? (
          <LoadingBlock rows={6} />
        ) : (
          <div className="stack stack--lg">
            <div className="row row--between">
              <span className="row">
                <StatusBadge status={d.status} />
                <strong>
                  Target <code>{String(d.params.targetVersion ?? '—')}</code>
                </strong>
                <span className="small muted">{String(d.params.description ?? '')}</span>
                {d.params.ciRunUrl ? (
                  <a className="small" href={String(d.params.ciRunUrl)} target="_blank" rel="noopener noreferrer">
                    CI run ↗
                  </a>
                ) : null}
              </span>
              {d.status === 'REQUESTED' ? (
                <Button variant="success" mfa onClick={() => setPlanDlg(true)} disabledReason={op.reason ?? (d.requestedBy === me?.id ? 'Rencana harus disetujui SUPER_ADMIN lain' : null)}>
                  Setujui rencana
                </Button>
              ) : null}
            </div>
            <ol className="steps" aria-label="Langkah workflow migrasi">
              {d.steps.map((s) => (
                <StepCard key={s.step} op={d} step={s} canOperate={op.allowed} permReason={op.reason} meId={me?.id} />
              ))}
            </ol>
          </div>
        )}
      </Card>
      <Card title="Riwayat workflow" flush>
        <OperationsTable ops={list.data?.data} loading={list.isPending} />
      </Card>
      <ActionDialog open={startOpen} onClose={() => setStartOpen(false)} title="Mulai workflow migrasi" description="Membuat rencana (REQUESTED) dengan 8 langkah; SUPER_ADMIN lain menyetujui rencana sebelum langkah pertama." confirmLabel="Buat workflow" mfa canConfirm={/^\d{4}/.test(target) && desc.trim().length > 3} onConfirm={(r) => start.mutateAsync(r)}>
        <div className="form-grid">
          <Field label="Versi target" required hint="mis. 0070">
            <input className="input mono" value={target} onChange={(e) => setTarget(e.target.value.trim())} />
          </Field>
          <Field label="Deskripsi" required>
            <input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} />
          </Field>
          <Field label="URL run CI (opsional)">
            <input className="input" value={ci} onChange={(e) => setCi(e.target.value)} placeholder="https://github.com/…/actions/runs/…" />
          </Field>
        </div>
      </ActionDialog>
      <ActionDialog open={planDlg} onClose={() => setPlanDlg(false)} title="Setujui rencana migrasi" confirmLabel="Setujui rencana" tone="success" mfa reason={{ label: 'Catatan (opsional)', required: false, minLength: 0 }} onConfirm={(n) => approvePlan.mutateAsync(n)} />
    </TabPanel>
  );
}

function StepCard({ op, step, canOperate, permReason, meId }: { op: DbOperationDetail; step: WorkflowStep; canOperate: boolean; permReason: string | null; meId: string | undefined }) {
  const [ticks, setTicks] = useState<Record<string, boolean>>(() => Object.fromEntries(step.checklist.map((c) => [c.key, c.done])));
  const [notes, setNotes] = useState(step.notes ?? '');
  const [evidence, setEvidence] = useState(Object.entries(step.evidence ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'));
  const [err, setErr] = useState<unknown>(null);
  const record = useAdminAction({
    run: (outcome: 'DONE' | 'SKIPPED' | 'FAILED') =>
      Infra.recordStep(op.id, step.step, {
        outcome,
        checklist: ticks,
        ...(notes ? { notes } : {}),
        evidence: Object.fromEntries(evidence.split('\n').map((l) => l.split('=')).filter((p) => p.length >= 2 && p[0]!.trim()).map((p) => [p[0]!.trim(), p.slice(1).join('=').trim()])),
      }),
    invalidate: [['infra']],
    toastErrors: false,
    success: (r) => `Langkah ${step.step} dicatat · workflow ${r.status}`,
  });
  const approve = useAdminAction({ run: () => Infra.approveStep(op.id, step.step), invalidate: [['infra']], success: `Langkah ${step.step} disetujui` });
  const pending = step.status === 'PENDING';
  const active = ['APPROVED', 'RUNNING'].includes(op.status);
  const allTicked = step.checklist.every((c) => ticks[c.key]);
  const awaitingApproval = step.requiresApproval && step.status === 'DONE' && !step.approvedBy;
  const cls = step.status === 'DONE' || step.status === 'SKIPPED' ? 'step step--done' : step.status === 'FAILED' ? 'step step--failed' : 'step';
  const isCurrent = pending && active && op.steps.filter((s) => s.stepNo < step.stepNo && s.step !== 'ROLLBACK').every((s) => s.status !== 'PENDING' && !(s.requiresApproval && s.status === 'DONE' && !s.approvedBy));
  const block = permReason ?? (!active ? 'Workflow belum disetujui / sudah selesai' : !isCurrent && step.step !== 'ROLLBACK' ? 'Selesaikan langkah sebelumnya dulu (urutan dijaga API)' : null);
  const run = (o: 'DONE' | 'SKIPPED' | 'FAILED') => {
    setErr(null);
    record.mutate(o, { onError: setErr });
  };
  return (
    <li className={`${cls}${isCurrent ? ' step--current' : ''}`} aria-current={isCurrent ? 'step' : undefined}>
      <div className="row row--between">
        <span className="row">
          <span className="step__no">{step.stepNo}</span>
          <strong>{STEP_LABEL[step.step] ?? step.step}</strong>
          {pending ? (
            isCurrent ? <StatusBadge status={step.status} tone="info" label="Langkah aktif" /> : <StatusBadge status={step.status} tone="neutral" label={step.step === 'ROLLBACK' ? 'Siaga' : 'Belum mulai'} />
          ) : (
            <StatusBadge status={step.status} />
          )}
          {step.requiresApproval ? <Badge tone={step.approvedBy ? 'success' : awaitingApproval ? 'warning' : 'neutral'}>{step.approvedBy ? 'Disetujui admin kedua' : 'Butuh admin kedua'}</Badge> : null}
        </span>
        <span className="small muted">{step.completedAt ? <>oleh <IdText id={step.completedBy} /> · <DateTime value={step.completedAt} /></> : null}</span>
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0 0' }} className="stack stack--sm">
        {step.checklist.map((c) => (
          <li key={c.key}>
            <Checkbox checked={!!ticks[c.key]} disabled={!pending || !canOperate} onChange={(v) => setTicks((t) => ({ ...t, [c.key]: v }))} label={c.label} />
          </li>
        ))}
      </ul>
      {pending && canOperate && (isCurrent || step.step === 'ROLLBACK') ? (
        <div className="stack stack--sm" style={{ marginTop: 10 }}>
          <div className="grid grid-2">
            <Field label="Catatan">
              <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
            <Field label="Evidence (key=nilai per baris; tautan/ID saja, bukan secret)">
              <textarea className="textarea textarea--code" rows={2} value={evidence} onChange={(e) => setEvidence(e.target.value)} />
            </Field>
          </div>
          <div className="btn-group">
            <Button size="sm" variant="success" mfa loading={record.isPending} disabledReason={block ?? (!allTicked ? 'Semua checklist wajib dicentang untuk DONE' : null)} onClick={() => run('DONE')}>
              Tandai DONE
            </Button>
            {!['PRE_CHECK', 'BACKUP', 'SCHEMA_MIGRATION', 'VALIDATION', 'MONITORING'].includes(step.step) ? (
              <Button size="sm" mfa disabledReason={block} onClick={() => run('SKIPPED')}>
                Lewati
              </Button>
            ) : null}
            <Button size="sm" variant="danger-outline" mfa disabledReason={block} onClick={() => run('FAILED')}>
              Tandai FAILED
            </Button>
          </div>
          {err ? <Callout tone="danger">{describeError(err).title}</Callout> : null}
        </div>
      ) : null}
      {awaitingApproval ? (
        <div style={{ marginTop: 10 }}>
          <Button size="sm" variant="success" mfa loading={approve.isPending} disabledReason={permReason ?? (step.completedBy === meId ? 'Dicatat oleh Anda — butuh SUPER_ADMIN lain' : null)} onClick={() => approve.mutate(undefined)}>
            Setujui {STEP_LABEL[step.step]}
          </Button>
        </div>
      ) : null}
      {step.evidence && Object.keys(step.evidence).length ? <p className="small muted" style={{ marginTop: 8 }}>Evidence: {Object.entries(step.evidence).map(([k, v]) => `${k}=${v}`).join(' · ')}</p> : null}
      {step.notes && !pending ? <p className="small" style={{ marginTop: 4 }}>{step.notes}</p> : null}
    </li>
  );
}
