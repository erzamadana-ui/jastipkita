import { useState } from 'react';
import { Link } from 'react-router';
import { Chat } from '../../api/admin';
import type { FlaggedMessage, RevealedMessage } from '../../api/types';
import { useCan } from '../../auth/AuthProvider';
import { CAP } from '../../auth/permissions';
import { ActionDialog } from '../../components/ActionDialog';
import { DataTable, useCursorQuery } from '../../components/DataTable';
import { Dialog } from '../../components/Overlay';
import { Badge, Button, Callout, Card, DateTime, Field, PageHeader, Select, StatusBadge } from '../../components/ui';
import { useAdminAction } from '../../hooks/useAdminAction';

export default function ChatModerationPage() {
  const [status, setStatus] = useState('FLAGGED');
  const { query, rows, pagination } = useCursorQuery(['chat', 'flagged', status], (cursor) => Chat.flagged({ status, cursor, limit: 25 }));
  const perm = useCan(CAP.chat);
  const [dlg, setDlg] = useState<{ kind: 'reveal' | 'hide' | 'unhide'; m: FlaggedMessage } | null>(null);
  const [revealed, setRevealed] = useState<RevealedMessage | null>(null);
  const act = useAdminAction({
    run: (v: { kind: 'reveal' | 'hide' | 'unhide'; m: FlaggedMessage; reason: string }) => (v.kind === 'reveal' ? Chat.reveal(v.m.id, v.reason) : v.kind === 'hide' ? Chat.hide(v.m.id, v.reason) : Chat.unhide(v.m.id, v.reason)),
    invalidate: [['chat']],
    toastErrors: false,
    onSuccess: (r, v) => {
      if (v.kind === 'reveal') setRevealed(r as RevealedMessage);
    },
    success: (_r, v) => (v.kind === 'reveal' ? null : v.kind === 'hide' ? 'Pesan disembunyikan' : 'Pesan ditampilkan kembali'),
  });
  return (
    <div className="stack stack--lg">
      <PageHeader title="Moderasi chat" subtitle="Antrean hanya menampilkan teks dimasking. Membuka teks asli butuh alasan (audit chat.message_revealed)." />
      <Card flush>
        <div className="filterbar">
          <Field label="Status">
            <Select value={status} onChange={setStatus} options={['FLAGGED', 'HIDDEN', 'FLAGGED,HIDDEN']} />
          </Field>
        </div>
        <DataTable
          caption="Pesan yang ditandai"
          rows={rows}
          loading={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
          rowKey={(m) => m.id}
          pagination={pagination}
          empty={{ title: 'Tidak ada pesan yang ditandai' }}
          columns={[
            { key: 'b', header: 'Pesan (dimasking)', render: (m) => <span className="small" style={{ whiteSpace: 'pre-wrap' }}>{m.maskedBody ?? <em className="muted">[{m.type}]</em>}</span> },
            { key: 'r', header: 'Alasan', render: (m) => <span className="row row--tight">{m.reasons.map((r) => <Badge key={r} tone="warning" dot={false}>{r}</Badge>)}</span> },
            { key: 's', header: 'Status', render: (m) => <StatusBadge status={m.moderationStatus} /> },
            { key: 'from', header: 'Pengirim', render: (m) => m.senderDisplayName ?? '—' },
            { key: 'tx', header: 'Transaksi', render: (m) => (m.transactionId ? <Link className="mono" to={`/transactions/${m.transactionId}`}>{m.transactionNumber}</Link> : '—') },
            { key: 't', header: 'Waktu', render: (m) => <DateTime value={m.createdAt} /> },
            {
              key: 'a',
              header: 'Aksi',
              render: (m) => (
                <span className="btn-group">
                  <Button size="sm" icon="eye" disabledReason={perm.reason} onClick={() => setDlg({ kind: 'reveal', m })}>
                    Lihat asli
                  </Button>
                  {m.moderationStatus === 'HIDDEN' ? (
                    <Button size="sm" disabledReason={perm.reason} onClick={() => setDlg({ kind: 'unhide', m })}>
                      Tampilkan
                    </Button>
                  ) : (
                    <Button size="sm" variant="danger-outline" disabledReason={perm.reason ?? (m.type === 'SYSTEM' || m.type === 'STATUS' ? 'Pesan sistem' : null)} onClick={() => setDlg({ kind: 'hide', m })}>
                      Sembunyikan
                    </Button>
                  )}
                </span>
              ),
            },
          ]}
        />
      </Card>
      <ActionDialog
        open={!!dlg}
        onClose={() => setDlg(null)}
        title={dlg?.kind === 'reveal' ? 'Buka teks asli' : dlg?.kind === 'hide' ? 'Sembunyikan pesan' : 'Tampilkan kembali pesan'}
        description={dlg?.kind === 'hide' ? 'Pengguna melihat “Pesan disembunyikan oleh moderator.”' : dlg?.kind === 'reveal' ? 'Akses dicatat di audit log.' : 'Status kembali ke FLAGGED/CLEAN sebelumnya.'}
        confirmLabel={dlg?.kind === 'reveal' ? 'Buka teks asli' : dlg?.kind === 'hide' ? 'Sembunyikan' : 'Tampilkan'}
        tone={dlg?.kind === 'hide' ? 'danger' : 'primary'}
        onConfirm={(reason) => act.mutateAsync({ ...dlg!, reason })}
      />
      <Dialog open={!!revealed} onClose={() => setRevealed(null)} title="Teks asli (tercatat)" footer={<Button onClick={() => setRevealed(null)}>Tutup</Button>}>
        {revealed ? (
          <>
            <Callout tone="neutral">
              <span style={{ whiteSpace: 'pre-wrap' }}>{revealed.body ?? '[tanpa teks]'}</span>
            </Callout>
            <p className="small muted">
              Alasan penandaan: {revealed.reasons.join(', ') || '—'} · dibuka <DateTime value={revealed.revealedAt} />
            </p>
          </>
        ) : null}
      </Dialog>
    </div>
  );
}
