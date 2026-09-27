import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Support } from '../../api/admin';
import { useCan } from '../../auth/AuthProvider';
import { CAP } from '../../auth/permissions';
import { ConversationButton } from '../../components/ConversationViewer';
import { Button, Callout, Card, Checkbox, DateTime, Field, KeyValue, LoadingBlock, PageHeader, Select, StatusBadge } from '../../components/ui';
import { useAdminAction } from '../../hooks/useAdminAction';
import { humanize } from '../../lib/format';
import { txTone } from '../../lib/status';
import { SlaBadge } from '../disputes/DisputesPage';

export default function TicketDetailPage() {
  const { id = '' } = useParams();
  const q = useQuery({ queryKey: ['support', 'ticket', id], queryFn: () => Support.ticket(id) });
  const can = useCan(CAP.support);
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [nextStatus, setNextStatus] = useState('');
  const inv = [['support']];
  const assign = useAdminAction({ run: () => Support.assign(id), invalidate: inv, success: 'Tiket ditugaskan ke Anda' });
  const reply = useAdminAction({
    run: () => Support.reply(id, { body: body.trim(), internal, ...(nextStatus ? { status: nextStatus as 'OPEN' } : {}) }),
    invalidate: inv,
    success: internal ? 'Catatan internal disimpan' : 'Balasan terkirim ke pengguna',
    onSuccess: () => {
      setBody('');
      setNextStatus('');
    },
  });
  const update = useAdminAction({ run: (v: { status?: string; priority?: string }) => Support.update(id, v as never), invalidate: inv, success: 'Tiket diperbarui' });
  if (q.isPending) return <LoadingBlock rows={8} />;
  if (q.isError || !q.data) return <Callout tone="danger">Tiket tidak dapat dimuat.</Callout>;
  const t = q.data;
  const closed = t.status === 'CLOSED' ? 'Tiket sudah ditutup' : null;
  return (
    <div className="stack stack--lg">
      <PageHeader
        breadcrumb={<Link to="/support">Tiket support</Link>}
        title={t.subject}
        subtitle={
          <span className="row">
            <span className="mono">{t.number}</span> <StatusBadge status={t.status} /> <StatusBadge status={t.priority} /> <SlaBadge state={t.slaState} /> {humanize(t.category)} · {t.channel}
          </span>
        }
        actions={
          <>
            {t.transaction ? <ConversationButton conversationId={t.conversationId} ticketId={t.id} disabledReason={['RESOLVED', 'CLOSED'].includes(t.status) ? 'Hanya untuk tiket terbuka' : null} /> : null}
            <Button onClick={() => assign.mutate(undefined)} loading={assign.isPending} disabledReason={can.reason}>
              Tugaskan ke saya
            </Button>
          </>
        }
      />
      <div className="grid grid-main-side">
        <Card title="Percakapan tiket">
          <div className="thread" aria-live="polite">
            {t.messages.map((m) => (
              <div key={m.id} className={m.internal ? 'msg msg--internal' : m.authorType === 'AGENT' ? 'msg msg--agent' : 'msg'}>
                <div className="msg__meta">
                  {m.internal ? 'Catatan internal — tidak terlihat pengguna · ' : ''}
                  {humanize(m.authorType)} · <DateTime value={m.createdAt} />
                </div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
              </div>
            ))}
            {!t.messages.length ? <p className="muted small">Belum ada pesan.</p> : null}
          </div>
          <form
            className="stack"
            style={{ marginTop: 16, borderTop: '1px solid var(--jk-color-divider)', paddingTop: 16 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (body.trim()) reply.mutate(undefined);
            }}
          >
            <Field label={internal ? 'Catatan internal' : 'Balasan ke pengguna'}>
              <textarea className="textarea" value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} />
            </Field>
            <div className="row row--between">
              <Checkbox checked={internal} onChange={setInternal} label="Catatan internal (tidak dikirim ke pengguna)" />
              <span className="row">
                <Select aria-label="Status setelah balasan" className="select--sm" value={nextStatus} onChange={setNextStatus} options={[{ value: '', label: internal ? 'Status tetap' : 'Status → PENDING_USER' }, ...['IN_PROGRESS', 'PENDING_USER', 'RESOLVED', 'CLOSED'].map((s) => ({ value: s, label: `Status → ${s}` }))]} />
                <Button type="submit" variant="primary" loading={reply.isPending} disabledReason={can.reason ?? closed ?? (!body.trim() ? 'Tulis pesan terlebih dahulu' : null)}>
                  {internal ? 'Simpan catatan' : 'Kirim balasan'}
                </Button>
              </span>
            </div>
          </form>
        </Card>
        <div className="stack stack--lg">
          <Card title="Detail">
            <KeyValue
              items={[
                ['Pengguna', t.userId ? <Link to={`/users/${t.userId}`}>{t.userDisplayName ?? t.userId}</Link> : '—'],
                ['Transaksi', t.transaction ? <span className="row row--tight"><Link className="mono" to={`/transactions/${t.transaction.id}`}>{t.transaction.number}</Link><StatusBadge status={t.transaction.status} tone={txTone(t.transaction.status)} /></span> : '—'],
                ['Dispute', t.disputeId ? <Link to={`/disputes/${t.disputeId}`}>Buka dispute</Link> : '—'],
                ['Batas SLA', <DateTime value={t.slaDueAt} />],
                ['Respons pertama', <DateTime value={t.firstResponseAt} />],
                ['Dibuat', <DateTime value={t.createdAt} />],
              ]}
            />
          </Card>
          <Card title="Ubah status / prioritas" hint="Mengubah prioritas sebelum respons pertama menghitung ulang SLA.">
            <div className="stack">
              <Field label="Status">
                <Select value={t.status} onChange={(v) => update.mutate({ status: v })} options={['OPEN', 'PENDING_USER', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']} />
              </Field>
              <Field label="Prioritas">
                <Select value={t.priority} onChange={(v) => update.mutate({ priority: v })} options={['LOW', 'NORMAL', 'HIGH', 'URGENT']} />
              </Field>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
