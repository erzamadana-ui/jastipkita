import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Transactions } from '../../api/admin';
import { DataTable, useCursorQuery } from '../../components/DataTable';
import { Badge, Button, Card, DateTime, Field, IdText, Money, PageHeader, Select, StatusBadge } from '../../components/ui';
import { humanize } from '../../lib/format';
import { TX_STATUSES, txTone } from '../../lib/status';

const PRESETS = [
  { value: '', label: 'Semua status' },
  { value: 'AWAITING_PAYMENT,PRICE_CHANGE_PENDING', label: 'Butuh aksi pengguna' },
  { value: 'PAYMENT_SECURED,PURCHASE_APPROVED', label: 'Dana aman (SafePay)' },
  { value: 'PURCHASED,TRAVELING,ARRIVED,CUSTOMS_PROCESS,READY_FOR_HANDOVER,OUT_FOR_DELIVERY', label: 'Dalam perjalanan' },
  { value: 'DISPUTED', label: 'Dispute' },
  { value: 'REFUND_PENDING', label: 'Refund tertunda' },
  ...TX_STATUSES.map((s) => ({ value: s, label: humanize(s) })),
];

export default function TransactionsPage() {
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [q, setQ] = useState(sp.get('q') ?? '');
  const filters = {
    q: sp.get('q') || undefined,
    status: sp.get('status') || undefined,
    from: sp.get('from') || undefined,
    to: sp.get('to') || undefined,
    buyerId: sp.get('buyerId') || undefined,
    travelerId: sp.get('travelerId') || undefined,
    limit: 25,
  };
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    setSp(n, { replace: true });
  };
  const { query, rows, pagination } = useCursorQuery(['transactions', filters], (cursor) => Transactions.list({ ...filters, cursor }));

  return (
    <div className="stack stack--lg">
      <PageHeader title="Transaksi" subtitle="Cari nomor JK-… (prefix), filter status, pihak dan tanggal (WIB). Pihak ditampilkan dimasking." />
      <Card flush>
        <form
          className="filterbar"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            set('q', q.trim().toUpperCase());
          }}
        >
          <Field label="Nomor transaksi" className="field--grow">
            <input className="input mono" type="search" placeholder="JK-260927-…" value={q} onChange={(e) => setQ(e.target.value)} data-testid="tx-search" />
          </Field>
          <Field label="Status">
            <Select value={filters.status ?? ''} onChange={(v) => set('status', v)} options={PRESETS} />
          </Field>
          <Field label="Dari">
            <input className="input" type="date" value={filters.from ?? ''} onChange={(e) => set('from', e.target.value)} />
          </Field>
          <Field label="Sampai">
            <input className="input" type="date" value={filters.to ?? ''} onChange={(e) => set('to', e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" icon="search">
            Cari
          </Button>
        </form>
        {filters.buyerId || filters.travelerId ? (
          <div className="filterbar small">
            Difilter pada {filters.buyerId ? 'penitip' : 'traveler'} <IdText id={filters.buyerId ?? filters.travelerId} />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const n = new URLSearchParams(sp);
                n.delete('buyerId');
                n.delete('travelerId');
                setSp(n, { replace: true });
              }}
            >
              Hapus filter
            </Button>
          </div>
        ) : null}
        <DataTable
          caption="Daftar transaksi"
          rows={rows}
          loading={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
          rowKey={(t) => t.id}
          onRowClick={(t) => nav(`/transactions/${t.id}`)}
          rowLabel={(t) => `Buka transaksi ${t.number}`}
          rowClassName={(t) => (t.openDispute || t.payoutHoldReason ? 'row--highlight' : undefined)}
          pagination={pagination}
          empty={{ title: 'Tidak ada transaksi yang cocok' }}
          columns={[
            { key: 'n', header: 'Nomor', render: (t) => <span className="cell-primary mono">{t.number}</span>, sortValue: (t) => t.number },
            { key: 'p', header: 'Barang', render: (t) => <span className="truncate" style={{ maxWidth: 220, display: 'inline-block' }} title={t.productName}>{t.productName}</span> },
            { key: 's', header: 'Status', render: (t) => <StatusBadge status={t.status} tone={txTone(t.status)} />, sortValue: (t) => TX_STATUSES.indexOf(t.status) },
            { key: 'b', header: 'Penitip', render: (t) => t.buyer.displayName ?? '—' },
            { key: 'tr', header: 'Traveler', render: (t) => t.traveler?.displayName ?? <span className="muted">—</span> },
            { key: 'tot', header: 'Total', align: 'right', render: (t) => <Money value={t.totalIdr} />, sortValue: (t) => t.totalIdr },
            { key: 'sec', header: 'Di-secure', align: 'right', render: (t) => <Money value={t.securedIdr} />, sortValue: (t) => t.securedIdr },
            {
              key: 'f',
              header: 'Tanda',
              render: (t) => (
                <span className="row row--tight">
                  {t.openDispute ? <Badge tone="danger">Dispute</Badge> : null}
                  {t.payoutHoldReason ? <Badge tone="warning" title={t.payoutHoldReason}>Payout hold</Badge> : null}
                </span>
              ),
            },
            { key: 'c', header: 'Dibuat', render: (t) => <DateTime value={t.createdAt} />, sortValue: (t) => t.createdAt },
          ]}
        />
      </Card>
    </div>
  );
}
