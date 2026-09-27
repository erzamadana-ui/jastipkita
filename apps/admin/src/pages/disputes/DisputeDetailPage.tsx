import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Disputes } from '../../api/admin';
import type { DisputeDetail } from '../../api/types';
import { useCan } from '../../auth/AuthProvider';
import { CAP } from '../../auth/permissions';
import { ActionDialog } from '../../components/ActionDialog';
import { ConversationButton } from '../../components/ConversationViewer';
import { DataTable } from '../../components/DataTable';
import { DocumentViewer, eventsToTimeline, Timeline } from '../../components/data';
import { Badge, Button, Callout, Card, Checkbox, DateTime, Field, IdText, KeyValue, LoadingBlock, Money, PageHeader, Select, StatusBadge } from '../../components/ui';
import { useAdminAction } from '../../hooks/useAdminAction';
import { formatIdr, humanize } from '../../lib/format';
import { txTone } from '../../lib/status';
import { TrustBadge } from '../users/UsersPage';
import { SlaBadge } from './DisputesPage';

type Resolution = 'REFUND_FULL' | 'REFUND_PARTIAL' | 'NO_REFUND' | 'RETURN_AND_REFUND' | 'OTHER';

/** Client-side money preview of a resolution (the API decides; this mirrors docs/api/admin.md §3). */
export function resolutionPreview(d: DisputeDetail, resolution: Resolution, amountIdr: number) {
  const held = d.transaction.escrowHeldIdr;
  const executes = d.transaction.status === 'DISPUTED';
  if (!executes) return { executes, toBuyer: 0, toTraveler: 0, remainsHeld: held, needsReleaseConfirm: false };
  if (resolution === 'REFUND_FULL' || resolution === 'RETURN_AND_REFUND') return { executes, toBuyer: held, toTraveler: 0, remainsHeld: 0, needsReleaseConfirm: false };
  if (resolution === 'REFUND_PARTIAL') {
    const a = Math.max(0, Math.min(amountIdr, held));
    return { executes, toBuyer: a, toTraveler: held - a, remainsHeld: 0, needsReleaseConfirm: false };
  }
  return { executes, toBuyer: 0, toTraveler: held, remainsHeld: 0, needsReleaseConfirm: d.transaction.preDisputeStatus !== 'DELIVERED' };
}

export default function DisputeDetailPage() {
  const { id = '' } = useParams();
  const q = useQuery({ queryKey: ['disputes', 'detail', id], queryFn: () => Disputes.detail(id) });
  const can = useCan(CAP.disputes);
  const [dlg, setDlg] = useState<null | 'evidence' | 'review' | 'resolve' | 'close'>(null);
  const [dueHours, setDueHours] = useState('72');
  const [closeWindow, setCloseWindow] = useState(false);
  const [resolution, setResolution] = useState<Resolution>('REFUND_FULL');
  const [amount, setAmount] = useState('');
  const [releaseBefore, setReleaseBefore] = useState(false);
  const inv = [['disputes'], ['transactions']];
  const assign = useAdminAction({ run: () => Disputes.assign(id), invalidate: inv, success: 'Dispute ditugaskan ke Anda' });
  const evidence = useAdminAction({ run: (note: string) => Disputes.requestEvidence(id, note, Number(dueHours)), invalidate: inv, toastErrors: false, success: 'Permintaan bukti dikirim' });
  const review = useAdminAction({ run: (note: string) => Disputes.review(id, { closeEvidenceWindow: closeWindow, ...(note ? { note } : {}) }), invalidate: inv, toastErrors: false, success: 'Dispute masuk UNDER_REVIEW' });
  const resolve = useAdminAction({
    run: (note: string, key) =>
      Disputes.resolve(id, { resolution, note, ...(resolution === 'REFUND_PARTIAL' ? { amountIdr: Number(amount) } : {}), ...(releaseBefore ? { releaseBeforeDelivery: true } : {}) }, key),
    actionKey: () => `dispute.resolve:${id}`,
    invalidate: inv,
    toastErrors: false,
    success: (r) => `Diputuskan · eksekusi ${r.execution.status}`,
  });
  const close = useAdminAction({ run: (note: string) => Disputes.close(id, note), invalidate: inv, toastErrors: false, success: 'Dispute ditutup' });

  if (q.isPending) return <LoadingBlock rows={10} />;
  if (q.isError || !q.data) return <Callout tone="danger">Dispute tidak dapat dimuat.</Callout>;
  const d = q.data;
  const act = (a: DisputeDetail['allowedActions'][number]) => can.reason ?? (d.allowedActions.includes(a) ? null : `Tidak tersedia pada status ${d.status}`);
  const pv = resolutionPreview(d, resolution, Number(amount) || 0);
  const partialOk = resolution !== 'REFUND_PARTIAL' || (Number(amount) > 0 && Number(amount) < d.transaction.escrowHeldIdr);

  return (
    <div className="stack stack--lg">
      <PageHeader
        breadcrumb={<Link to="/disputes">Dispute</Link>}
        title={<span className="mono">{d.number}</span>}
        subtitle={
          <span className="row">
            <StatusBadge status={d.status} /> <SlaBadge state={d.slaState} /> {humanize(d.type)} · dibuka {humanize(d.openedByRole)} <DateTime value={d.slaDueAt} relative />
          </span>
        }
        actions={
          <>
            <ConversationButton conversationId={d.conversationId} disputeId={d.id} disabledReason={d.status === 'CLOSED' ? 'Dispute sudah ditutup' : null} />
            <Button onClick={() => assign.mutate(undefined)} loading={assign.isPending} disabledReason={can.reason}>
              Tugaskan ke saya
            </Button>
          </>
        }
      />
      {d.slaState === 'BREACHED' ? <Callout tone="danger" title="SLA terlewati.">{d.slaBreach ?? 'Tangani segera (runbook dispute-sla-breach).'}</Callout> : null}
      {d.status === 'APPEALED' ? <Callout tone="warning" title="Banding diajukan.">Mulai review ulang; bila transaksi sudah tidak DISPUTED, resolusi berbeda menjadi MANUAL_FOLLOW_UP (uang tidak dibalik otomatis).</Callout> : null}
      <Card title="Langkah berikutnya" hint={`Aksi tersedia: ${d.allowedActions.map(humanize).join(', ') || '—'}`}>
        <div className="btn-group">
          <Button onClick={() => setDlg('evidence')} disabledReason={act('REQUEST_EVIDENCE')}>
            Minta bukti
          </Button>
          <Button onClick={() => setDlg('review')} disabledReason={act('START_REVIEW')}>
            Mulai review
          </Button>
          <Button variant="primary" mfa onClick={() => setDlg('resolve')} disabledReason={act('RESOLVE')} data-testid="dispute-resolve">
            Putuskan resolusi
          </Button>
          <Button variant="danger-outline" onClick={() => setDlg('close')} disabledReason={act('CLOSE')}>
            Tutup dispute
          </Button>
        </div>
      </Card>
      <div className="grid grid-main-side">
        <div className="stack stack--lg">
          <Card title="Keluhan">
            <p style={{ whiteSpace: 'pre-wrap' }}>{d.description ?? '—'}</p>
            <div style={{ marginTop: 12 }}>
              <KeyValue
                cols={2}
                items={[
                  ['Resolusi diminta', humanize(d.requestedResolution)],
                  ['Resolusi', d.resolution ? <span>{humanize(d.resolution)} {d.resolutionAmountIdr !== null ? <Money value={d.resolutionAmountIdr} /> : null}</span> : '—'],
                  ['Batas bukti', <DateTime value={d.evidenceDueAt} />],
                  ['Batas banding', <DateTime value={d.appealDeadline} />],
                  ['Catatan resolusi', d.resolutionNote],
                  ['PJ', d.assigneeId ? <IdText id={d.assigneeId} /> : 'Belum ditugaskan'],
                ]}
              />
            </div>
          </Card>
          <Card title={`Bukti (${d.evidence.length})`}>
            <div className="stack stack--lg">
              {d.evidence.map((e) => (
                <div key={e.id} className="stack stack--sm">
                  <div className="row small">
                    <Badge tone={e.party === 'BUYER' ? 'info' : e.party === 'TRAVELER' ? 'violet' : 'neutral'}>{e.party}</Badge>
                    <span>{humanize(e.type)}</span>
                    <span className="muted">
                      <DateTime value={e.createdAt} />
                    </span>
                  </div>
                  {e.note ? <p className="small">{e.note}</p> : null}
                  {e.fileId ? <DocumentViewer fileId={e.fileId} title={`Bukti ${humanize(e.type)}`} /> : null}
                </div>
              ))}
              {!d.evidence.length ? <p className="muted small">Belum ada bukti.</p> : null}
            </div>
          </Card>
        </div>
        <div className="stack stack--lg">
          <Card title="Transaksi & dana">
            <KeyValue
              items={[
                ['Transaksi', <Link to={`/transactions/${d.transaction.id}`} className="mono">{d.transaction.number}</Link>],
                ['Status', <StatusBadge status={d.transaction.status} tone={txTone(d.transaction.status)} />],
                ['Sebelum dispute', humanize(d.transaction.preDisputeStatus)],
                ['Dana ditahan', <Money value={d.transaction.escrowHeldIdr} emphasize />],
              ]}
            />
          </Card>
          <Card title="Pihak">
            <div className="stack">
              {(['buyer', 'traveler'] as const).map((k) => (
                <div key={k} className="row row--between">
                  <span>
                    <span className="small muted">{k === 'buyer' ? 'Penitip' : 'Traveler'} · </span>
                    {d[k] ? <Link to={`/users/${d[k]!.id}`}>{d[k]!.displayName}</Link> : '—'}
                  </span>
                  {d[k] ? <TrustBadge score={d[k]!.trustScore} /> : null}
                </div>
              ))}
            </div>
          </Card>
          <Card title="Timeline">
            <Timeline label="Riwayat dispute" items={eventsToTimeline(d.timeline, ['CLOSED'])} />
          </Card>
          {d.refunds.length ? (
            <Card title="Refund terkait" flush>
              <DataTable compact caption="Refund terkait" rows={d.refunds} rowKey={(r) => r.id} columns={[{ key: 'n', header: 'Nomor', render: (r) => <span className="mono">{r.number}</span> }, { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.status} /> }, { key: 'a', header: 'Nominal', align: 'right', render: (r) => <Money value={r.amountIdr} /> }]} />
            </Card>
          ) : null}
        </div>
      </div>

      <ActionDialog open={dlg === 'evidence'} onClose={() => setDlg(null)} title="Minta bukti tambahan" description="Status → EVIDENCE_COLLECTION dengan batas waktu baru." confirmLabel="Kirim permintaan" reason={{ label: 'Catatan untuk para pihak', minLength: 5 }} onConfirm={(n) => evidence.mutateAsync(n)}>
        <Field label="Batas waktu (jam)">
          <input className="input" type="number" min={1} max={336} value={dueHours} onChange={(e) => setDueHours(e.target.value)} />
        </Field>
      </ActionDialog>
      <ActionDialog open={dlg === 'review'} onClose={() => setDlg(null)} title="Mulai review" confirmLabel="Mulai review" reason={{ label: 'Catatan (opsional)', required: false, minLength: 0 }} onConfirm={(n) => review.mutateAsync(n)}>
        {d.status === 'EVIDENCE_COLLECTION' && d.evidenceDueAt && Date.parse(d.evidenceDueAt) > Date.now() ? (
          <Checkbox checked={closeWindow} onChange={setCloseWindow} label="Tutup masa bukti lebih awal" hint={<>Masa bukti berjalan sampai <DateTime value={d.evidenceDueAt} />; tanpa ini API menjawab EVIDENCE_WINDOW_OPEN.</>} />
        ) : null}
      </ActionDialog>
      <ActionDialog
        open={dlg === 'resolve'}
        onClose={() => setDlg(null)}
        wide
        title={`Putuskan ${d.number}`}
        description="Resolusi dieksekusi dalam transaksi DB yang sama: refund lewat money.requestRefund atau rilis ke traveler. Idempotency dispute:{id}:v{versi} mencegah refund ganda."
        confirmLabel="Putuskan & eksekusi"
        tone={resolution === 'NO_REFUND' || resolution === 'OTHER' ? 'danger' : 'primary'}
        mfa
        idempotencyKey={dlg === 'resolve' ? resolve.keyFor(undefined as never) : null}
        canConfirm={partialOk && (!pv.needsReleaseConfirm || releaseBefore)}
        reason={{ label: 'Catatan keputusan (dikirim ke para pihak & audit)', minLength: 10 }}
        onConfirm={(n) => resolve.mutateAsync(n)}
      >
        <div className="form-grid">
          <Field label="Resolusi" required>
            <Select value={resolution} onChange={(v) => setResolution(v as Resolution)} options={['REFUND_FULL', 'REFUND_PARTIAL', 'RETURN_AND_REFUND', 'NO_REFUND', 'OTHER']} />
          </Field>
          {resolution === 'REFUND_PARTIAL' ? (
            <Field label="Nominal refund (IDR)" required hint={`Harus < dana ditahan ${formatIdr(d.transaction.escrowHeldIdr)}`} error={!partialOk && amount ? 'Harus > 0 dan lebih kecil dari dana ditahan (gunakan REFUND_FULL untuk semuanya)' : null}>
              <input className="input tabular" type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
          ) : null}
        </div>
        <table className="breakdown" aria-label="Pratinjau ledger resolusi" data-testid="resolve-preview">
          <tbody>
            <tr>
              <td>Dana ditahan saat ini</td>
              <td>
                <Money value={d.transaction.escrowHeldIdr} />
              </td>
            </tr>
            <tr className="group-start">
              <td>→ Refund ke penitip</td>
              <td>
                <Money value={pv.toBuyer} />
              </td>
            </tr>
            <tr>
              <td>→ Rilis ke traveler (payout)</td>
              <td>
                <Money value={pv.toTraveler} />
              </td>
            </tr>
            <tr className="total">
              <td>Tetap ditahan</td>
              <td>
                <Money value={pv.remainsHeld} />
              </td>
            </tr>
          </tbody>
        </table>
        <p className="small muted">Pratinjau dihitung di klien dari escrow (PRODUCT_FUND + CUSTOMS_RESERVE + CLEARING); nominal final = min(escrow, pembayaran yang dapat direfund) menurut ledger API.</p>
        {!pv.executes ? <Callout tone="warning">Transaksi sudah {d.transaction.status} (bukan DISPUTED): keputusan hanya dicatat — ALREADY_EXECUTED atau MANUAL_FOLLOW_UP.</Callout> : null}
        {pv.needsReleaseConfirm ? (
          <Checkbox checked={releaseBefore} onChange={setReleaseBefore} label="Saya sadar barang BELUM diterima penitip dan dana dirilis ke traveler (releaseBeforeDelivery)" hint={`Status sebelum dispute: ${d.transaction.preDisputeStatus ?? '—'}`} />
        ) : null}
      </ActionDialog>
      <ActionDialog open={dlg === 'close'} onClose={() => setDlg(null)} title="Tutup dispute" description="RESOLVED → CLOSED setelah jendela banding; OPEN/EVIDENCE_COLLECTION hanya bila barang sudah DELIVERED (lanjut BUYER_CONFIRMED)." confirmLabel="Tutup dispute" tone="danger" reason={{ label: 'Catatan', minLength: 5 }} onConfirm={(n) => close.mutateAsync(n)} />
    </div>
  );
}
