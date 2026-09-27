import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Risk } from '../../api/admin';
import { useCan } from '../../auth/AuthProvider';
import { CAP } from '../../auth/permissions';
import { ActionDialog } from '../../components/ActionDialog';
import { DataTable, useCursorQuery } from '../../components/DataTable';
import { JsonView } from '../../components/data';
import { Drawer } from '../../components/Overlay';
import { Badge, Button, Callout, Card, Checkbox, DateTime, Field, IdText, KeyValue, LoadingBlock, PageHeader, Select, StatusBadge } from '../../components/ui';
import { useAdminAction } from '../../hooks/useAdminAction';
import { humanize } from '../../lib/format';
import { KycBadge, TrustBadge } from '../users/UsersPage';

function reasonCodes(reasons: unknown): { code: string; message?: string }[] {
  return Array.isArray(reasons) ? (reasons as { code?: string; message?: string }[]).map((r) => ({ code: r.code ?? '?', message: r.message })) : [];
}

function subjectLink(type: string, id: string, txId?: string | null) {
  if (type === 'USER') return `/users/${id}`;
  if (type === 'TRANSACTION') return `/transactions/${id}`;
  if (type === 'TRIP') return `/trips/${id}`;
  if (type === 'REFERRAL') return '/referrals';
  return txId ? `/transactions/${txId}` : null;
}

export default function RiskPage() {
  const nav = useNavigate();
  const { id } = useParams();
  const [status, setStatus] = useState('OPEN,IN_REVIEW');
  const [subject, setSubject] = useState('');
  const [assignee, setAssignee] = useState('');
  const filters = { status, subjectType: subject || undefined, assignee: assignee || undefined, limit: 25 };
  const { query, rows, pagination } = useCursorQuery(['risk', filters], (cursor) => Risk.queue({ ...filters, cursor }));
  return (
    <div className="stack stack--lg">
      <PageHeader title="Review risiko" subtitle="Penilaian fraud dengan alasan & sinyal. CONFIRMED_FRAUD menahan payout (dan opsional menangguhkan akun)." />
      <Card flush>
        <div className="filterbar">
          <Field label="Status">
            <Select
              value={status}
              onChange={setStatus}
              options={[
                { value: 'OPEN,IN_REVIEW', label: 'Terbuka & ditinjau' },
                { value: 'CLEARED', label: 'Cleared' },
                { value: 'CONFIRMED_FRAUD', label: 'Fraud terkonfirmasi' },
              ]}
            />
          </Field>
          <Field label="Subjek">
            <Select value={subject} onChange={setSubject} placeholder="Semua" options={['USER', 'TRANSACTION', 'PAYMENT', 'REFERRAL', 'REFUND', 'PURCHASE_PROOF', 'TRIP']} />
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
        </div>
        <DataTable
          caption="Antrean review risiko"
          rows={rows}
          loading={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
          rowKey={(r) => r.id}
          onRowClick={(r) => nav(`/risk/${r.id}`)}
          rowLabel={(r) => `Buka review ${r.subjectType} skor ${r.assessment.score}`}
          pagination={pagination}
          empty={{ title: 'Tidak ada review pada filter ini' }}
          columns={[
            { key: 'sub', header: 'Subjek', render: (r) => <span className="stack" style={{ gap: 0 }}><strong>{humanize(r.subjectType)}</strong><IdText id={r.subjectId} /></span> },
            { key: 'score', header: 'Skor', align: 'right', render: (r) => <Badge tone={r.assessment.score >= 70 ? 'danger' : r.assessment.score >= 40 ? 'warning' : 'info'}>{r.assessment.score}</Badge>, sortValue: (r) => r.assessment.score },
            { key: 'dec', header: 'Keputusan', render: (r) => <StatusBadge status={r.assessment.decision} /> },
            { key: 'reasons', header: 'Alasan', render: (r) => <span className="row row--tight">{reasonCodes(r.assessment.reasons).slice(0, 3).map((x) => <Badge key={x.code} tone="neutral" dot={false}>{x.code}</Badge>)}</span> },
            { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
            { key: 'a', header: 'PJ', render: (r) => (r.assigneeId ? <IdText id={r.assigneeId} /> : <span className="muted">—</span>) },
            { key: 'c', header: 'Dibuat', render: (r) => <DateTime value={r.createdAt} />, sortValue: (r) => r.createdAt },
          ]}
        />
      </Card>
      {id ? <RiskDrawer id={id} onClose={() => nav('/risk')} /> : null}
    </div>
  );
}

function RiskDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['risk', 'detail', id], queryFn: () => Risk.detail(id) });
  const review = useCan(CAP.riskReview);
  const suspendCap = useCan(CAP.suspendUser);
  const [dlg, setDlg] = useState(false);
  const [outcome, setOutcome] = useState<'CLEARED' | 'CONFIRMED_FRAUD'>('CLEARED');
  const [suspend, setSuspend] = useState(false);
  const assign = useAdminAction({ run: () => Risk.assign(id), invalidate: [['risk']], success: 'Review ditugaskan ke Anda' });
  const resolve = useAdminAction({
    run: (notes: string) => Risk.resolve(id, { outcome, notes, ...(suspend ? { suspendUser: true } : {}) }),
    invalidate: [['risk'], ['payouts'], ['transactions']],
    toastErrors: false,
    success: (r) => `Review ${r.status}${r.effects.length ? ` · ${r.effects.join(', ')}` : ''}`,
    onSuccess: onClose,
  });
  const r = q.data;
  const closed = r && !r.allowedActions.length ? `Review sudah ${r.status}` : null;
  return (
    <Drawer
      open
      onClose={onClose}
      wide
      title={r ? `Review ${humanize(r.subjectType)}` : 'Review risiko'}
      subtitle={r ? <span className="row row--tight"><StatusBadge status={r.status} /> skor {r.assessment.score} · {r.assessment.decision} · rules {r.assessment.rulesVersion}</span> : null}
      footer={
        <>
          <Button onClick={() => assign.mutate(undefined)} loading={assign.isPending} disabledReason={review.reason ?? closed}>
            Tugaskan ke saya
          </Button>
          <Button variant="primary" mfa onClick={() => setDlg(true)} disabledReason={review.reason ?? closed}>
            Selesaikan review
          </Button>
        </>
      }
    >
      {!r ? (
        <LoadingBlock rows={8} />
      ) : (
        <>
          <Card title="Alasan penilaian">
            <ul className="stack stack--sm" style={{ margin: 0, paddingLeft: 18 }}>
              {reasonCodes(r.assessment.reasons).map((x) => (
                <li key={x.code}>
                  <code>{x.code}</code> {x.message ? <span className="small muted">— {x.message}</span> : null}
                </li>
              ))}
            </ul>
            <details style={{ marginTop: 12 }}>
              <summary className="small">Sinyal mentah</summary>
              <JsonView value={r.assessment.signals} />
            </details>
          </Card>
          <Card title="Subjek & pengguna terlibat (dimasking)">
            <KeyValue
              items={[
                ['Subjek', (() => {
                  const l = subjectLink(r.subject.type, r.subject.id, r.subject.transactionId);
                  return l ? <Link to={l}>{humanize(r.subject.type)} <IdText id={r.subject.id} /></Link> : <IdText id={r.subject.id} />;
                })()],
                ['Transaksi', r.subject.transactionId ? <Link to={`/transactions/${r.subject.transactionId}`}><IdText id={r.subject.transactionId} /></Link> : '—'],
              ]}
            />
            <div className="stack stack--sm" style={{ marginTop: 12 }}>
              {r.users.map((u) => (
                <div key={u.id} className="row row--between">
                  <Link to={`/users/${u.id}`}>{u.displayName ?? u.id}</Link>
                  <span className="row row--tight">
                    <StatusBadge status={u.status} /> <KycBadge level={u.kycLevel} /> <TrustBadge score={u.trustScore} />
                  </span>
                </div>
              ))}
            </div>
          </Card>
          <Card title="Riwayat penilaian" flush>
            <DataTable
              compact
              caption="Riwayat penilaian"
              rows={r.assessmentHistory}
              rowKey={(h) => h.id}
              columns={[
                { key: 't', header: 'Waktu', render: (h) => <DateTime value={h.createdAt} /> },
                { key: 's', header: 'Skor', align: 'right', render: (h) => h.score },
                { key: 'd', header: 'Keputusan', render: (h) => <StatusBadge status={h.decision} /> },
                { key: 'r', header: 'Alasan', render: (h) => <span className="small">{reasonCodes(h.reasons).map((x) => x.code).join(', ')}</span> },
              ]}
            />
          </Card>
        </>
      )}
      <ActionDialog
        open={dlg}
        onClose={() => setDlg(false)}
        title="Selesaikan review risiko"
        description="CLEARED membersihkan payout hold transaksi bila tidak ada review lain terbuka. CONFIRMED_FRAUD menahan payout terjadwal."
        confirmLabel={outcome === 'CLEARED' ? 'Tandai CLEARED' : 'Konfirmasi fraud'}
        tone={outcome === 'CLEARED' ? 'success' : 'danger'}
        mfa
        reason={{ label: 'Catatan investigasi', minLength: 10 }}
        onConfirm={(n) => resolve.mutateAsync(n)}
      >
        <Field label="Hasil" required>
          <Select value={outcome} onChange={(v) => setOutcome(v as 'CLEARED' | 'CONFIRMED_FRAUD')} options={['CLEARED', 'CONFIRMED_FRAUD']} />
        </Field>
        {outcome === 'CONFIRMED_FRAUD' ? (
          <Checkbox checked={suspend} onChange={setSuspend} disabled={!suspendCap.allowed} label="Tangguhkan akun pengguna terkait" hint={suspendCap.reason ?? 'Semua sesi dicabut.'} />
        ) : null}
        {outcome === 'CONFIRMED_FRAUD' ? <Callout tone="danger">Payout SCHEDULED terkait akan ON_HOLD (CONFIRMED_FRAUD). Hanya bisa dilepas oleh admin lain.</Callout> : null}
      </ActionDialog>
    </Drawer>
  );
}
