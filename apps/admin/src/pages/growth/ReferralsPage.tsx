import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { Referrals } from '../../api/admin';
import type { Referral } from '../../api/types';
import { useCan } from '../../auth/AuthProvider';
import { CAP } from '../../auth/permissions';
import { ActionDialog } from '../../components/ActionDialog';
import { DataTable } from '../../components/DataTable';
import { KpiTile } from '../../components/KpiTile';
import { Badge, Button, Callout, Card, DateTime, LoadingBlock, Money, PageHeader, Select, StatusBadge } from '../../components/ui';
import { useAdminAction } from '../../hooks/useAdminAction';
import { formatNumber, humanize } from '../../lib/format';

const LABELS: Record<string, { label: string; unit: string }> = {
  cacProxyIdr: { label: 'CAC proxy', unit: 'IDR' },
  ltvProxyIdr: { label: 'LTV proxy', unit: 'IDR' },
  conversion: { label: 'Konversi', unit: 'RATIO' },
  fraudRate: { label: 'Fraud rate', unit: 'RATIO' },
  repeatRate: { label: 'Repeat rate', unit: 'RATIO' },
  grossMarginIdr: { label: 'Gross margin', unit: 'IDR' },
};

export function isSuspicious(r: Referral): boolean {
  return r.fraudReasons.length > 0 || r.openRiskReviews > 0 || r.adminHold;
}

export default function ReferralsPage() {
  const [status, setStatus] = useState('QUALIFIED');
  const [onlySuspicious, setOnlySuspicious] = useState(false);
  const stats = useQuery({ queryKey: ['referrals', 'stats'], queryFn: Referrals.stats });
  const list = useQuery({ queryKey: ['referrals', 'list', status], queryFn: () => Referrals.list(status || undefined) });
  const perm = useCan(CAP.referrals);
  const [dlg, setDlg] = useState<{ kind: 'reject' | 'hold' | 'release'; r: Referral } | null>(null);
  const act = useAdminAction({
    run: (v: { kind: 'reject' | 'hold' | 'release'; r: Referral; text: string }, key) => (v.kind === 'reject' ? Referrals.reject(v.r.id, v.text) : v.kind === 'hold' ? Referrals.hold(v.r.id, v.text) : Referrals.release(v.r.id, v.text, key)),
    actionKey: (v) => `referral.${v.kind}:${v.r.id}`,
    invalidate: [['referrals']],
    toastErrors: false,
    success: (r) => `Referral → ${r.status}`,
  });
  const rows = (list.data?.data ?? []).filter((r) => !onlySuspicious || isSuspicious(r));
  return (
    <div className="stack stack--lg">
      <PageHeader title="Referral" subtitle="Unit economics 90 hari + reward mencurigakan. Nominal reward hanya diubah lewat business config (maker-checker)." />
      {stats.data ? (
        <>
          <Callout tone={stats.data.guardrail.allowIncrease ? 'success' : 'warning'} title={stats.data.guardrail.allowIncrease ? 'Guardrail: kenaikan reward diizinkan.' : 'Guardrail: JANGAN naikkan reward.'}>
            CAC/LTV {stats.data.guardrail.cacToLtv !== null ? formatNumber(stats.data.guardrail.cacToLtv) : '—'} · {stats.data.guardrail.reasons.length ? `alasan: ${stats.data.guardrail.reasons.join(', ')}` : 'semua ambang terpenuhi'}
          </Callout>
          <div className="kpi-grid">
            {Object.entries(stats.data.metrics).map(([k, m]) => (
              <KpiTile key={k} metric={{ key: k, label: LABELS[k]?.label ?? k, unit: LABELS[k]?.unit ?? 'COUNT', value: m.value, definition: m.definition, sampleSize: m.sampleSize, dataQuality: m.dataQuality }} />
            ))}
          </div>
          <p className="small muted">
            Hitungan 90 hari: total {stats.data.counts.total} · pending {stats.data.counts.pending} · qualified {stats.data.counts.qualified} · rewarded {stats.data.counts.rewarded} · rejected {stats.data.counts.rejected} · expired {stats.data.counts.expired}. {stats.data.note}
          </p>
        </>
      ) : (
        <LoadingBlock rows={3} />
      )}
      <Card
        title="Referral"
        actions={
          <>
            <label className="checkbox small">
              <input type="checkbox" checked={onlySuspicious} onChange={(e) => setOnlySuspicious(e.target.checked)} /> Hanya mencurigakan
            </label>
            <Select className="select--sm" aria-label="Status" value={status} onChange={setStatus} placeholder="Semua" options={['PENDING', 'QUALIFIED', 'REWARDED', 'REJECTED', 'EXPIRED']} />
          </>
        }
        flush
      >
        <DataTable
          caption="Daftar referral"
          rows={rows}
          loading={list.isPending}
          error={list.error}
          rowKey={(r) => r.id}
          rowClassName={(r) => (isSuspicious(r) ? 'row--highlight' : undefined)}
          empty={{ title: 'Tidak ada referral' }}
          columns={[
            { key: 'p', header: 'Program', render: (r) => <Badge tone="info" dot={false}>{r.program}</Badge> },
            { key: 'rr', header: 'Referrer → referee', render: (r) => <span><Link to={`/users/${r.referrer.id}`}>{r.referrer.displayName ?? '—'}</Link> → <Link to={`/users/${r.referee.id}`}>{r.referee.displayName ?? '—'}</Link></span> },
            { key: 'rw', header: 'Reward', align: 'right', render: (r) => <span className="stack" style={{ gap: 0 }}><Money value={r.referrerRewardIdr} /><span className="cell-sub">+ <Money value={r.refereeRewardIdr} /></span></span> },
            { key: 's', header: 'Status', render: (r) => <span className="row row--tight"><StatusBadge status={r.status} />{r.adminHold ? <Badge tone="warning">Ditahan</Badge> : null}</span> },
            { key: 'f', header: 'Sinyal fraud', render: (r) => (r.fraudReasons.length ? <span className="row row--tight">{r.fraudReasons.map((f, i) => <Badge key={i} tone="danger" dot={false} title={f.message}>{f.code}</Badge>)}</span> : <span className="muted">—</span>) },
            { key: 'rv', header: 'Review', align: 'right', render: (r) => (r.openRiskReviews ? <Link to="/risk?status=OPEN,IN_REVIEW"><Badge tone="warning">{r.openRiskReviews} terbuka</Badge></Link> : '0') },
            { key: 'c', header: 'Dibuat', render: (r) => <DateTime value={r.createdAt} /> },
            {
              key: 'act',
              header: 'Aksi',
              render: (r) => (
                <span className="btn-group">
                  {r.status === 'QUALIFIED' ? (
                    <>
                      <Button size="sm" variant="success" mfa disabledReason={perm.reason ?? (r.openRiskReviews ? 'Review risiko masih terbuka — minta tim Risk CLEAR dulu' : null)} onClick={() => setDlg({ kind: 'release', r })}>
                        Rilis
                      </Button>
                      <Button size="sm" disabledReason={perm.reason ?? (r.adminHold ? 'Sudah ditahan' : null)} onClick={() => setDlg({ kind: 'hold', r })}>
                        Tahan
                      </Button>
                    </>
                  ) : null}
                  {['PENDING', 'QUALIFIED'].includes(r.status) ? (
                    <Button size="sm" variant="danger-outline" disabledReason={perm.reason} onClick={() => setDlg({ kind: 'reject', r })}>
                      Tolak
                    </Button>
                  ) : null}
                </span>
              ),
            },
          ]}
        />
      </Card>
      <ActionDialog
        open={!!dlg}
        onClose={() => setDlg(null)}
        title={dlg ? `${dlg.kind === 'release' ? 'Rilis reward' : dlg.kind === 'hold' ? 'Tahan reward' : 'Tolak referral'} (${humanize(dlg.r.program)})` : ''}
        description={dlg?.kind === 'release' ? 'QUALIFIED → REWARDED + credit (tidak dapat ditarik) ke kedua pihak, idempotency referral:{id}:referrer|referee.' : dlg?.kind === 'hold' ? 'Membuka review risiko REFERRAL; rilis hanya setelah tim Risk CLEARED.' : 'Tanpa credit. Referral yang sudah REWARDED tidak dapat ditolak.'}
        confirmLabel={dlg?.kind === 'release' ? 'Rilis reward' : dlg?.kind === 'hold' ? 'Tahan reward' : 'Tolak referral'}
        tone={dlg?.kind === 'release' ? 'success' : 'danger'}
        mfa={dlg?.kind === 'release'}
        idempotencyKey={dlg?.kind === 'release' ? act.keyFor({ ...dlg, text: '' }) : null}
        onConfirm={(text) => act.mutateAsync({ ...dlg!, text })}
      />
    </div>
  );
}
