import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Trips } from '../../api/admin';
import { useAuth, useCan } from '../../auth/AuthProvider';
import { CAP } from '../../auth/permissions';
import { ActionDialog } from '../../components/ActionDialog';
import { DataTable, useCursorQuery } from '../../components/DataTable';
import { DocumentViewer, eventsToTimeline, JsonView, Timeline } from '../../components/data';
import { Button, Callout, Card, DateTime, IdText, KeyValue, LoadingBlock, PageHeader, StatusBadge } from '../../components/ui';
import { useAdminAction } from '../../hooks/useAdminAction';
import { formatDate, formatHours, formatNumber, humanize } from '../../lib/format';
import { KycBadge } from './UsersPage';

export function TripsQueuePage() {
  const nav = useNavigate();
  const { query, rows, pagination } = useCursorQuery(['trips', 'queue'], (cursor) => Trips.queue({ cursor, limit: 25 }));
  return (
    <div className="stack stack--lg">
      <PageHeader title="Verifikasi trip" subtitle="Trip VERIFICATION_PENDING, dokumen terlama di atas. Admin tidak pernah dapat memverifikasi trip sendiri." />
      <Card flush>
        <DataTable
          caption="Antrean verifikasi trip"
          rows={rows}
          loading={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
          rowKey={(t) => t.id}
          onRowClick={(t) => nav(`/trips/${t.id}`)}
          rowLabel={(t) => `Tinjau trip ${t.route.originCity} ke ${t.route.destinationCity}`}
          pagination={pagination}
          empty={{ title: 'Tidak ada trip yang menunggu verifikasi' }}
          columns={[
            { key: 'r', header: 'Rute', render: (t) => <span className="cell-primary">{t.route.originCity} ({t.route.originCountry}) → {t.route.destinationCity} ({t.route.destinationCountry})</span> },
            { key: 'd', header: 'Tanggal', render: (t) => `${formatDate(t.departureDate)} – ${formatDate(t.arrivalDate)}`, sortValue: (t) => t.departureDate },
            { key: 'tr', header: 'Traveler', render: (t) => <span className="row row--tight">{t.travelerDisplayName ?? '—'} {t.travelerKycLevel ? <KycBadge level={t.travelerKycLevel} /> : null}</span> },
            { key: 'k', header: 'Kapasitas', align: 'right', render: (t) => `${formatNumber(t.capacityKg)} kg` },
            { key: 'docs', header: 'Dokumen', align: 'right', render: (t) => t.pendingDocuments ?? '—' },
            { key: 'w', header: 'Menunggu', align: 'right', render: (t) => formatHours(t.waitingHours ?? null), sortValue: (t) => t.waitingHours ?? 0 },
          ]}
        />
      </Card>
    </div>
  );
}

export function TripDetailPage() {
  const { id = '' } = useParams();
  const { me } = useAuth();
  const q = useQuery({ queryKey: ['trips', 'detail', id], queryFn: () => Trips.detail(id), staleTime: 0, gcTime: 0 });
  const can = useCan(CAP.tripVerify);
  const [dlg, setDlg] = useState<null | 'approve' | 'reject'>(null);
  const approve = useAdminAction({ run: (note: string) => Trips.approve(id, note || undefined), invalidate: [['trips']], toastErrors: false, success: 'Trip terverifikasi' });
  const reject = useAdminAction({ run: (reason: string) => Trips.reject(id, reason), invalidate: [['trips']], toastErrors: false, success: 'Dokumen ditolak — trip kembali ke DRAFT' });
  if (q.isPending) return <LoadingBlock rows={8} />;
  if (q.isError || !q.data) return <Callout tone="danger">Trip tidak dapat dimuat.</Callout>;
  const t = q.data;
  const block = can.reason ?? (t.travelerId === me?.id ? 'Tidak dapat memverifikasi trip sendiri' : !t.allowedActions.length ? `Status ${t.status}` : null);
  return (
    <div className="stack stack--lg">
      <PageHeader
        breadcrumb={<Link to="/trips">Verifikasi trip</Link>}
        title={`${t.route.originCity} → ${t.route.destinationCity}`}
        subtitle={
          <span className="row">
            <StatusBadge status={t.status} /> {formatDate(t.departureDate)} – {formatDate(t.arrivalDate)} · {formatNumber(t.capacityKg)} kg
          </span>
        }
        actions={
          <>
            <Button variant="danger-outline" onClick={() => setDlg('reject')} disabledReason={block}>
              Tolak dokumen
            </Button>
            <Button variant="success" icon="check" onClick={() => setDlg('approve')} disabledReason={block}>
              Verifikasi trip
            </Button>
          </>
        }
      />
      <div className="grid grid-main-side">
        <Card title="Dokumen perjalanan">
          <div className="stack stack--lg">
            {t.documents.map((d) => (
              <div key={d.id} className="stack stack--sm">
                {d.fileId ? <DocumentViewer fileId={d.fileId} mime={d.mime} title={`${humanize(d.docType)} · ${d.status}`} /> : <Callout tone="neutral">{humanize(d.docType)} tanpa file</Callout>}
                <KeyValue
                  cols={2}
                  items={[
                    ['Penerbangan', d.flightNumber],
                    ['Tanggal', formatDate(d.flightDate)],
                    ['Status', <StatusBadge status={d.status} />],
                    ['Catatan', d.notes],
                  ]}
                />
                {d.extracted ? (
                  <details>
                    <summary className="small">Data hasil ekstraksi</summary>
                    <JsonView value={d.extracted} />
                  </details>
                ) : null}
              </div>
            ))}
            {!t.documents.length ? <p className="muted small">Tidak ada dokumen.</p> : null}
          </div>
        </Card>
        <div className="stack stack--lg">
          <Card title="Traveler">
            <KeyValue
              items={[
                ['Nama', t.travelerDisplayName],
                ['KYC', t.travelerKycLevel ? <KycBadge level={t.travelerKycLevel} /> : '—'],
                ['ID', <Link to={`/users/${t.travelerId}`}><IdText id={t.travelerId} /></Link>],
                ['Terverifikasi', <DateTime value={t.verifiedAt} />],
              ]}
            />
          </Card>
          <Card title="Timeline">
            <Timeline label="Riwayat status trip" items={eventsToTimeline(t.timeline)} />
          </Card>
        </div>
      </div>
      <ActionDialog open={dlg === 'approve'} onClose={() => setDlg(null)} title="Verifikasi trip" description="VERIFIED + event trip.verified (level KYC traveler dihitung ulang)." confirmLabel="Verifikasi trip" tone="success" reason={{ label: 'Catatan (opsional)', required: false, minLength: 0 }} onConfirm={(n) => approve.mutateAsync(n)} />
      <ActionDialog open={dlg === 'reject'} onClose={() => setDlg(null)} title="Tolak dokumen trip" description="Trip kembali ke DRAFT; traveler melihat alasan." confirmLabel="Tolak dokumen" tone="danger" onConfirm={(r) => reject.mutateAsync(r)} />
    </div>
  );
}
