import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Kyc } from '../../api/admin';
import type { PayoutAccountReview } from '../../api/types';
import { useAuth, useCan } from '../../auth/AuthProvider';
import { CAP } from '../../auth/permissions';
import { ActionDialog } from '../../components/ActionDialog';
import { DataTable, useCursorQuery } from '../../components/DataTable';
import { DocumentViewer, JsonView } from '../../components/data';
import { Badge, Button, Callout, Card, Checkbox, DateTime, Field, IdText, KeyValue, LoadingBlock, PageHeader, Select, StatusBadge, Tabs } from '../../components/ui';
import { useAdminAction } from '../../hooks/useAdminAction';
import { formatHours, formatPercent, humanize } from '../../lib/format';
import { KycBadge } from './UsersPage';

export function KycQueuePage() {
  const nav = useNavigate();
  const [tab, setTab] = useState<'submissions' | 'payout'>('submissions');
  const [status, setStatus] = useState('PENDING,IN_REVIEW');
  const { query, rows, pagination } = useCursorQuery(['kyc', 'queue', status], (cursor) => Kyc.queue({ status, cursor, limit: 25 }));
  const accounts = useQuery({ queryKey: ['kyc', 'payout-accounts'], queryFn: Kyc.payoutAccounts, enabled: tab === 'payout' });
  const [dlg, setDlg] = useState<{ acc: PayoutAccountReview; to: 'VERIFIED' | 'FAILED' } | null>(null);
  const override = useAdminAction({
    run: (v: { id: string; status: 'VERIFIED' | 'FAILED'; reason: string }) => Kyc.overridePayoutAccount(v.id, { status: v.status, reason: v.reason }),
    invalidate: [['kyc']],
    toastErrors: false,
    success: (r) => `Rekening ${r.verificationStatus}`,
  });
  return (
    <div className="stack stack--lg">
      <PageHeader title="Review KYC" subtitle="Antrean terlama di atas. Dokumen identitas terenkripsi dan hanya dibuka lewat API terautentikasi (tercatat)." />
      <Tabs
        label="KYC"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'submissions', label: 'Pengajuan identitas' },
          { key: 'payout', label: 'Rekening payout' },
        ]}
      />
      {tab === 'submissions' ? (
        <Card flush>
          <div className="filterbar">
            <Field label="Status">
              <Select
                value={status}
                onChange={setStatus}
                options={[
                  { value: 'PENDING,IN_REVIEW', label: 'Menunggu & ditinjau' },
                  { value: 'APPROVED', label: 'Disetujui' },
                  { value: 'REJECTED', label: 'Ditolak' },
                  { value: 'EXPIRED', label: 'Kedaluwarsa' },
                ]}
              />
            </Field>
          </div>
          <DataTable
            caption="Antrean KYC"
            rows={rows}
            loading={query.isPending}
            error={query.error}
            onRetry={() => void query.refetch()}
            rowKey={(s) => s.id}
            onRowClick={(s) => nav(`/kyc/${s.id}`)}
            rowLabel={(s) => `Tinjau KYC ${s.userDisplayName ?? s.id}`}
            pagination={pagination}
            empty={{ title: 'Antrean KYC kosong' }}
            columns={[
              { key: 'u', header: 'Pengguna', render: (s) => <span className="cell-primary">{s.userDisplayName ?? '—'}</span> },
              { key: 'id', header: 'Dokumen', render: (s) => s.idType ?? '—' },
              { key: 'lvl', header: 'Level → target', render: (s) => (s.userKycLevel ? <span className="row row--tight"><KycBadge level={s.userKycLevel} /> → L{s.targetLevel}</span> : `L${s.targetLevel}`) },
              { key: 'st', header: 'Status', render: (s) => <StatusBadge status={s.status} /> },
              { key: 'prov', header: 'Provider', render: (s) => <span className="row row--tight">{s.provider} {s.providerEnv !== 'LIVE' ? <Badge tone="warning">{s.providerEnv}</Badge> : null}</span> },
              { key: 'live', header: 'Liveness / wajah', align: 'right', render: (s) => `${formatPercent(s.livenessScore, 0)} / ${formatPercent(s.faceMatchScore, 0)}` },
              { key: 'w', header: 'Menunggu', align: 'right', render: (s) => <span className={s.waitingHours > 24 ? 'badge badge--warning' : undefined}>{formatHours(s.waitingHours)}</span>, sortValue: (s) => s.waitingHours },
            ]}
          />
        </Card>
      ) : (
        <Card title="Rekening payout belum terverifikasi" hint="UNVERIFIED / PENDING / FAILED / NAME_MISMATCH — nomor rekening hanya tampil sebagai mask" flush>
          <DataTable
            caption="Rekening payout"
            rows={accounts.data?.data}
            loading={accounts.isPending}
            error={accounts.error}
            rowKey={(a) => a.id}
            empty={{ title: 'Tidak ada rekening yang menunggu' }}
            columns={[
              { key: 'u', header: 'Pengguna', render: (a) => <Link to={`/users/${a.userId}`}>{a.userDisplayName ?? a.userId}</Link> },
              { key: 'b', header: 'Rekening', render: (a) => <span className="mono">{a.bankCode} {a.accountMask}</span> },
              { key: 's', header: 'Status', render: (a) => <StatusBadge status={a.verificationStatus} /> },
              { key: 'c', header: 'Dibuat', render: (a) => <DateTime value={a.createdAt} /> },
              {
                key: 'act',
                header: 'Override',
                render: (a) => (
                  <span className="btn-group">
                    <Button size="sm" variant="success" mfa onClick={() => setDlg({ acc: a, to: 'VERIFIED' })}>
                      Verifikasi
                    </Button>
                    <Button size="sm" variant="danger-outline" mfa onClick={() => setDlg({ acc: a, to: 'FAILED' })}>
                      Gagalkan
                    </Button>
                  </span>
                ),
              },
            ]}
          />
        </Card>
      )}
      <ActionDialog
        open={!!dlg}
        onClose={() => setDlg(null)}
        title={dlg?.to === 'VERIFIED' ? 'Override: tandai rekening VERIFIED' : 'Override: tandai rekening FAILED'}
        description={dlg ? `${dlg.acc.bankCode} ${dlg.acc.accountMask}. VERIFIED memicu payout_account.verified dan hitung ulang level KYC.` : undefined}
        confirmLabel={dlg?.to === 'VERIFIED' ? 'Tandai VERIFIED' : 'Tandai FAILED'}
        tone={dlg?.to === 'VERIFIED' ? 'success' : 'danger'}
        mfa
        onConfirm={(reason) => override.mutateAsync({ id: dlg!.acc.id, status: dlg!.to, reason })}
      />
    </div>
  );
}

export function KycDetailPage() {
  const { id = '' } = useParams();
  const { me } = useAuth();
  const q = useQuery({ queryKey: ['kyc', 'detail', id], queryFn: () => Kyc.detail(id), staleTime: 0, gcTime: 0 });
  const [dlg, setDlg] = useState<null | 'approve' | 'reject'>(null);
  const [liveness, setLiveness] = useState(false);
  const [match, setMatch] = useState(false);
  const [code, setCode] = useState('');
  const can = useCan(CAP.kycReview);
  const approve = useAdminAction({ run: (note: string) => Kyc.approve(id, { livenessPassed: liveness, documentMatches: match, ...(note ? { note } : {}) }), invalidate: [['kyc']], toastErrors: false, success: (r) => `KYC disetujui · level ${r.kycLevel}` });
  const reject = useAdminAction({ run: (reason: string) => Kyc.reject(id, { reason, ...(code ? { code } : {}) }), invalidate: [['kyc']], toastErrors: false, success: 'KYC ditolak' });

  if (q.isPending) return <LoadingBlock rows={8} />;
  if (q.isError || !q.data) return <Callout tone="danger">Pengajuan tidak dapat dimuat.</Callout>;
  const s = q.data;
  const own = s.userId === me?.id ? 'Tidak dapat meninjau KYC milik sendiri' : null;
  const allowed = (a: 'APPROVE' | 'REJECT') => (s.allowedActions.includes(a) ? null : `Status ${s.status} tidak dapat di-${a === 'APPROVE' ? 'setujui' : 'tolak'}`);
  return (
    <div className="stack stack--lg">
      <PageHeader
        breadcrumb={<Link to="/kyc">Review KYC</Link>}
        title={`KYC ${s.userDisplayName ?? ''}`}
        subtitle={
          <span className="row">
            <StatusBadge status={s.status} /> {s.idType} → level {s.targetLevel} · diajukan <DateTime value={s.submittedAt} /> · menunggu {formatHours(s.waitingHours)}
          </span>
        }
        actions={
          <>
            <Button variant="danger-outline" mfa onClick={() => setDlg('reject')} disabledReason={can.reason ?? own ?? allowed('REJECT')}>
              Tolak
            </Button>
            <Button variant="success" icon="check" mfa onClick={() => setDlg('approve')} disabledReason={can.reason ?? own ?? allowed('APPROVE')}>
              Setujui
            </Button>
          </>
        }
      />
      {s.providerEnv !== 'LIVE' ? <Callout tone="warning">Provider KYC {s.provider} berjalan di mode {s.providerEnv} — skor otomatis bukan hasil vendor live.</Callout> : null}
      {s.checks.duplicateIdentityEvents > 0 ? <Callout tone="danger" title="Indikasi identitas ganda:">{s.checks.duplicateIdentityEvents} security event KYC_DUPLICATE_IDENTITY untuk akun ini.</Callout> : null}
      <div className="grid grid-main-side">
        <Card title="Dokumen">
          <div className="stack stack--lg">
            {s.documents.map((d) =>
              d.fileId && !d.purged ? (
                <DocumentViewer key={d.id} fileId={d.fileId} mime={d.mime} sizeBytes={d.sizeBytes} title={`${humanize(d.type)} · ${humanize(d.side)} · scan ${d.scanStatus ?? '—'}`} />
              ) : (
                <Callout key={d.id} tone="neutral">
                  {humanize(d.type)} — {d.purged ? 'sudah dihapus sesuai retensi' : 'tanpa file'}
                </Callout>
              ),
            )}
          </div>
        </Card>
        <div className="stack stack--lg">
          <Card title="Identitas (dimasking)">
            {s.identity ? (
              <KeyValue
                items={[
                  ['Jenis', s.identity.idType],
                  ['Nomor', <span className="mono">{s.identity.idNumberMasked ?? '—'}</span>],
                  ['Nama', s.identity.fullNameMasked],
                  ['Kewarganegaraan', s.identity.nationality],
                  ['Terverifikasi', <DateTime value={s.identity.verifiedAt} />],
                ]}
              />
            ) : (
              <p className="muted small">Belum ada identity record.</p>
            )}
          </Card>
          <Card title="Pemeriksaan otomatis">
            <KeyValue
              items={[
                ['HP terverifikasi', s.checks.phoneVerified ? <Badge tone="success">Ya</Badge> : <Badge tone="warning">Belum</Badge>],
                ['Liveness', formatPercent(s.livenessScore, 0)],
                ['Kecocokan wajah', formatPercent(s.faceMatchScore, 0)],
                ['Pengguna', <Link to={`/users/${s.userId}`}><IdText id={s.userId} /></Link>],
              ]}
            />
            <details style={{ marginTop: 12 }}>
              <summary className="small">Hasil provider & risk flags</summary>
              <JsonView value={{ riskFlags: s.riskFlags, providerResult: s.providerResult }} />
            </details>
          </Card>
          <Card title="Pengajuan sebelumnya">
            {s.previousSubmissions.length ? (
              s.previousSubmissions.map((p) => (
                <div key={p.id} className="row row--between small">
                  <DateTime value={p.createdAt} />
                  <StatusBadge status={p.status} />
                </div>
              ))
            ) : (
              <p className="muted small">Tidak ada.</p>
            )}
          </Card>
        </div>
      </div>
      <ActionDialog
        open={dlg === 'approve'}
        onClose={() => setDlg(null)}
        title="Setujui KYC"
        description="Guard FSM KYC_CHECKS: liveness & kecocokan dokumen harus lolos, identitas tidak duplikat."
        confirmLabel="Setujui KYC"
        tone="success"
        mfa
        canConfirm={liveness && match}
        reason={{ label: 'Catatan (opsional)', required: false, minLength: 0 }}
        onConfirm={(note) => approve.mutateAsync(note)}
      >
        <Checkbox checked={liveness} onChange={setLiveness} label="Liveness / selfie lolos pemeriksaan manual" />
        <Checkbox checked={match} onChange={setMatch} label="Dokumen cocok dengan selfie dan data yang diajukan" />
      </ActionDialog>
      <ActionDialog open={dlg === 'reject'} onClose={() => setDlg(null)} title="Tolak KYC" description="Pengguna menerima alasan penolakan (kyc.rejected)." confirmLabel="Tolak KYC" tone="danger" mfa onConfirm={(reason) => reject.mutateAsync(reason)}>
        <Field label="Kode penolakan (opsional)" hint="mis. DOCUMENT_BLURRY, FACE_MISMATCH">
          <input className="input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
        </Field>
      </ActionDialog>
    </div>
  );
}
