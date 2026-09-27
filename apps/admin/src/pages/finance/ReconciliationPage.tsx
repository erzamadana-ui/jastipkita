import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { System } from '../../api/admin';
import { useCan } from '../../auth/AuthProvider';
import { CAP } from '../../auth/permissions';
import { Callout, Card, KeyValue, LoadingBlock, PageHeader } from '../../components/ui';
import { formatNumber } from '../../lib/format';

/**
 * Reconciliation runs are produced by the `money.daily_reconciliation` job into `reconciliation_runs/items`
 * (docs/04-payments-ledger.md) but the admin API exposes no endpoint for them yet — this page says so honestly and
 * links the signals that ARE available (per-transaction ledger balance, refund/payout failure counters).
 */
export default function ReconciliationPage() {
  const canHealth = useCan(CAP.infraRead);
  const health = useQuery({ queryKey: ['system', 'health'], queryFn: System.health, enabled: canHealth.allowed });
  return (
    <div className="stack stack--lg">
      <PageHeader title="Rekonsiliasi" subtitle="Hasil job money.daily_reconciliation (pembayaran SECURED ↔ jurnal capture PROVIDER_CASH)." />
      <Callout tone="warning" title="Belum tersedia di API admin.">
        Tabel <code>reconciliation_runs</code> / <code>reconciliation_items</code> sudah diisi job harian, tetapi belum ada endpoint <code>GET /v1/admin/reconciliation/runs</code>. Halaman ini tidak menampilkan angka buatan. Sementara itu: selisih dicatat sebagai log ALERT dan status <code>COMPLETED_WITH_DIFFS</code> di database.
      </Callout>
      <div className="grid grid-2">
        <Card title="Sinyal yang tersedia">
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            <li>
              Detail transaksi → tab Ledger: flag <strong>seimbang</strong> per jurnal dan saldo escrow per bucket (<Link to="/transactions">Transaksi</Link>).
            </li>
            <li>Refund/payout FAILED dan PROCESSING &gt; 1 jam memicu alert (docs/06-observability.md §3).</li>
            <li>KPI “Pendapatan platform (ledger)” di Dashboard = angka finance-grade dari ledger.</li>
          </ul>
        </Card>
        <Card title="Kesehatan uang (live)">
          {!canHealth.allowed ? (
            <p className="muted small">Butuh izin infra.db.read untuk melihat penghitung sistem.</p>
          ) : health.data ? (
            <KeyValue
              items={[
                ['Refund FAILED', formatNumber(health.data.refunds.failed)],
                ['Refund menunggu approval > 24 jam', formatNumber(health.data.refunds.pendingApprovalOlderThan24h)],
                ['Refund PROCESSING > 1 jam', formatNumber(health.data.refunds.processingOlderThan1h)],
                ['Payout FAILED', formatNumber(health.data.payouts.failed)],
                ['Payout ON_HOLD > 48 jam', formatNumber(health.data.payouts.onHoldOlderThan48h)],
                ['Webhook gagal 24 jam', formatNumber(health.data.webhooks.failed24h)],
                ['Webhook belum diproses > 10 mnt', formatNumber(health.data.webhooks.unprocessedOlderThan10m)],
              ]}
            />
          ) : (
            <LoadingBlock rows={4} />
          )}
        </Card>
      </div>
    </div>
  );
}
