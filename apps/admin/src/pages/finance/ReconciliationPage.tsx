import { useState } from 'react';
import { Link } from 'react-router';
import { Reconciliation } from '../../api/admin';
import type { ReconciliationItem, ReconciliationRun } from '../../api/types';
import { useCan } from '../../auth/AuthProvider';
import { CAP } from '../../auth/permissions';
import { ActionDialog } from '../../components/ActionDialog';
import { DataTable, useCursorQuery } from '../../components/DataTable';
import { Badge, Button, Callout, Card, DateTime, Field, Money, PageHeader, Select, StatusBadge } from '../../components/ui';
import { useAdminAction } from '../../hooks/useAdminAction';
import { formatNumber } from '../../lib/format';

/**
 * Reconciliation (docs/04-payments-ledger.md): the `money.daily_reconciliation` job compares SECURED payments with
 * their PROVIDER_CASH capture journals for the last full WIB day. Finance reviews runs and open differences here,
 * resolves each with an audited note (no money moves — corrections go through refund/payout/ledger flows) and can
 * start a manual run for a past period (≤ 31 days, MFA + Idempotency-Key).
 */
const ITEM_LABEL: Record<ReconciliationItem['status'], string> = {
  MATCHED: 'Cocok',
  MISMATCH: 'Nominal beda',
  MISSING_INTERNAL: 'Tidak ada jurnal internal',
  MISSING_PROVIDER: 'Tidak ada di provider',
  RESOLVED: 'Diselesaikan',
};

export function runTone(r: Pick<ReconciliationRun, 'status' | 'openItems'>): 'success' | 'warning' | 'danger' | 'neutral' {
  if (r.status === 'FAILED') return 'danger';
  if (r.status === 'COMPLETED_WITH_DIFFS') return r.openItems > 0 ? 'warning' : 'success';
  if (r.status === 'MATCHED') return 'success';
  return 'neutral';
}

function toIsoLocalDate(d: string, endOfDay: boolean): string {
  // date input (YYYY-MM-DD, WIB) → ISO with +07:00; end is exclusive (next day 00:00 WIB)
  const base = new Date(`${d}T00:00:00+07:00`);
  if (endOfDay) base.setUTCDate(base.getUTCDate() + 1);
  return base.toISOString();
}

export default function ReconciliationPage() {
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<ReconciliationRun | null>(null);
  const [itemStatus, setItemStatus] = useState('MISMATCH,MISSING_INTERNAL,MISSING_PROVIDER');
  const [resolveItem, setResolveItem] = useState<ReconciliationItem | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const canResolve = useCan(CAP.reconciliationResolve);

  const runs = useCursorQuery(['reconciliation', 'runs', status], (cursor) => Reconciliation.runs({ status: status || undefined, cursor, limit: 25 }));
  const items = useCursorQuery(['reconciliation', 'items', selected?.id ?? '-', itemStatus], (cursor) =>
    selected ? Reconciliation.items(selected.id, { status: itemStatus || undefined, cursor, limit: 50 }) : Promise.resolve({ data: [], nextCursor: null }),
  );

  const resolve = useAdminAction({
    run: (v: { item: ReconciliationItem; note: string }) => Reconciliation.resolve(v.item.id, v.note),
    invalidate: [['reconciliation']],
    toastErrors: false,
    success: 'Selisih ditandai selesai',
  });
  const start = useAdminAction({
    run: (v: { periodStart: string; periodEnd: string; reason: string }, key) => Reconciliation.start(v, key),
    actionKey: (v) => `reconciliation.start:${v.periodStart}:${v.periodEnd}`,
    invalidate: [['reconciliation']],
    toastErrors: false,
    success: (r) => `Run selesai: ${r.status} · ${formatNumber(r.payments)} pembayaran · ${formatNumber(r.mismatches)} selisih`,
  });
  const periodOk = !!from && !!to && from <= to;

  return (
    <div className="stack stack--lg">
      <PageHeader
        title="Rekonsiliasi"
        subtitle="Pembayaran SECURED ↔ jurnal capture PROVIDER_CASH, per hari WIB (job money.daily_reconciliation). Menandai selesai tidak memindahkan uang."
        actions={
          <Button mfa disabledReason={canResolve.reason} onClick={() => setManualOpen(true)}>
            Jalankan manual
          </Button>
        }
      />
      <Card flush>
        <div className="filterbar">
          <Field label="Status run">
            <Select value={status} onChange={setStatus} placeholder="Semua" options={['MATCHED', 'COMPLETED_WITH_DIFFS', 'FAILED', 'RUNNING']} />
          </Field>
        </div>
        <DataTable
          caption="Run rekonsiliasi"
          rows={runs.rows}
          loading={runs.query.isPending}
          error={runs.query.error}
          onRetry={() => void runs.query.refetch()}
          rowKey={(r) => r.id}
          pagination={runs.pagination}
          empty={{ title: 'Belum ada run rekonsiliasi' }}
          columns={[
            { key: 'p', header: 'Periode', render: (r) => <span className="stack" style={{ gap: 0 }}><DateTime value={r.periodStart} /><span className="cell-sub">s/d <DateTime value={r.periodEnd} /></span></span> },
            { key: 's', header: 'Status', render: (r) => <span className="row row--tight"><Badge tone={runTone(r)}>{r.status}</Badge>{r.sandbox ? <Badge tone="warning">SANDBOX</Badge> : null}{r.manual ? <Badge>manual</Badge> : null}</span> },
            { key: 'n', header: 'Pembayaran', align: 'right', render: (r) => formatNumber(r.payments) },
            { key: 'o', header: 'Selisih terbuka', align: 'right', render: (r) => (r.openItems > 0 ? <strong>{formatNumber(r.openItems)}</strong> : <span className="muted">0</span>) },
            { key: 'res', header: 'Diselesaikan', align: 'right', render: (r) => formatNumber(r.resolvedItems) },
            { key: 'prov', header: 'Secured (provider)', align: 'right', render: (r) => <Money value={r.providerSecuredIdr} /> },
            { key: 'int', header: 'Capture (ledger)', align: 'right', render: (r) => <Money value={r.internalCapturedIdr} /> },
            {
              key: 'act',
              header: '',
              render: (r) => (
                <Button size="sm" variant={selected?.id === r.id ? 'primary' : 'secondary'} onClick={() => setSelected(r)}>
                  Lihat item
                </Button>
              ),
            },
          ]}
        />
      </Card>

      {selected ? (
        <Card
          flush
          title={`Item run ${new Date(selected.periodStart).toLocaleDateString('id-ID')} (${selected.status})`}
          hint={selected.error ? `Error: ${selected.error}` : undefined}
        >
          <div className="filterbar">
            <Field label="Status item">
              <Select
                value={itemStatus}
                onChange={setItemStatus}
                placeholder="Semua"
                options={[
                  { value: 'MISMATCH,MISSING_INTERNAL,MISSING_PROVIDER', label: 'Selisih terbuka' },
                  { value: 'RESOLVED', label: 'Diselesaikan' },
                  { value: 'MATCHED', label: 'Cocok' },
                ]}
              />
            </Field>
          </div>
          <DataTable
            caption="Item rekonsiliasi"
            rows={items.rows}
            loading={items.query.isPending}
            error={items.query.error}
            onRetry={() => void items.query.refetch()}
            rowKey={(i) => i.id}
            pagination={items.pagination}
            empty={{ title: 'Tidak ada item pada filter ini' }}
            columns={[
              { key: 't', header: 'Transaksi', render: (i) => (i.transactionId ? <Link className="mono nowrap" to={`/transactions/${i.transactionId}`}>{i.transactionNumber}</Link> : <span className="mono small">{i.providerRef ?? i.internalRef ?? '—'}</span>) },
              { key: 's', header: 'Status', render: (i) => <StatusBadge status={i.status} label={ITEM_LABEL[i.status]} /> },
              { key: 'p', header: 'Provider', align: 'right', render: (i) => <Money value={i.providerAmountIdr} /> },
              { key: 'l', header: 'Ledger', align: 'right', render: (i) => <Money value={i.internalAmountIdr} /> },
              { key: 'd', header: 'Selisih', align: 'right', render: (i) => (i.diffIdr === 0 ? <span className="muted">0</span> : <Money value={i.diffIdr} emphasize />) },
              { key: 'n', header: 'Catatan', render: (i) => (i.resolutionNote ? <span className="small">{i.resolutionNote}</span> : <span className="muted">—</span>) },
              {
                key: 'a',
                header: 'Aksi',
                render: (i) =>
                  ['MISMATCH', 'MISSING_INTERNAL', 'MISSING_PROVIDER'].includes(i.status) ? (
                    <Button size="sm" mfa disabledReason={canResolve.reason} onClick={() => setResolveItem(i)}>
                      Tandai selesai
                    </Button>
                  ) : null,
              },
            ]}
          />
        </Card>
      ) : (
        <Callout tone="info">Pilih run untuk melihat item. Selisih apa pun juga tercatat sebagai log ALERT <code>reconciliation.mismatch</code>.</Callout>
      )}

      <ActionDialog
        open={!!resolveItem}
        onClose={() => setResolveItem(null)}
        title="Tandai selisih selesai"
        description="Tidak memindahkan uang. Koreksi (refund, payout, jurnal penyesuaian) dilakukan di alur masing-masing; catatan ini masuk audit log."
        confirmLabel="Tandai selesai"
        mfa
        reason={{ label: 'Apa yang diperiksa/dikoreksi', minLength: 10 }}
        onConfirm={(note) => resolve.mutateAsync({ item: resolveItem!, note })}
      />
      <ActionDialog
        open={manualOpen}
        onClose={() => setManualOpen(false)}
        title="Jalankan rekonsiliasi manual"
        description="Periode tanggal WIB (maks. 31 hari, tidak boleh melewati sekarang). Hasil tersimpan sebagai run baru."
        confirmLabel="Jalankan"
        mfa
        canConfirm={periodOk}
        idempotencyKey={periodOk ? start.keyFor({ periodStart: toIsoLocalDate(from, false), periodEnd: toIsoLocalDate(to, true), reason: '' }) : null}
        onConfirm={(reason) => start.mutateAsync({ periodStart: toIsoLocalDate(from, false), periodEnd: toIsoLocalDate(to, true), reason })}
      >
        <div className="grid grid-2">
          <Field label="Dari (WIB)">
            <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Sampai (WIB, inklusif)">
            <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
      </ActionDialog>
    </div>
  );
}
