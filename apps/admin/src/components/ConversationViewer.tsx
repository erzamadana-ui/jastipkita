/**
 * Scoped chat access: a moderator may read a conversation only with an OPEN dispute or OPEN ticket on the same
 * transaction (disputeId / ticketId) and a stated reason — the API enforces the scope (CHAT_ACCESS_*) and audits
 * `chat.conversation_viewed`. Messages are held in component state only (not in the query cache).
 */
import { useState } from 'react';
import { Chat } from '../api/admin';
import type { ConversationView } from '../api/types';
import { ActionDialog } from './ActionDialog';
import { Dialog } from './Overlay';
import { Badge, Button, DateTime, StatusBadge } from './ui';

export function ConversationButton({ conversationId, disputeId, ticketId, disabledReason }: { conversationId: string | null; disputeId?: string; ticketId?: string; disabledReason?: string | null }) {
  const [ask, setAsk] = useState(false);
  const [view, setView] = useState<ConversationView | null>(null);
  return (
    <>
      <Button icon="chat" onClick={() => setAsk(true)} disabledReason={disabledReason ?? (!conversationId ? 'Transaksi belum punya percakapan' : null)}>
        Lihat percakapan
      </Button>
      <ActionDialog
        open={ask}
        onClose={() => setAsk(false)}
        title="Buka percakapan transaksi"
        description={`Akses berdasarkan ${disputeId ? 'dispute' : 'tiket'} yang masih terbuka. Tercatat di audit log (chat.conversation_viewed).`}
        confirmLabel="Buka percakapan"
        reason={{ minLength: 5, placeholder: 'mis. memeriksa klaim barang tidak sesuai' }}
        onConfirm={async (reason) => {
          const r = await Chat.conversation(conversationId!, { ...(disputeId ? { disputeId } : {}), ...(ticketId ? { ticketId } : {}), reason, limit: 100 });
          setView(r);
        }}
      />
      <Dialog open={!!view} onClose={() => setView(null)} wide title="Percakapan (baca saja)" description={view ? `Dasar akses: ${view.basis.type} · ${view.data.length} pesan terbaru` : undefined} footer={<Button onClick={() => setView(null)}>Tutup</Button>}>
        <div className="thread">
          {[...(view?.data ?? [])].reverse().map((m) => (
            <div key={m.id} className="msg">
              <div className="msg__meta row row--tight">
                <strong>{m.senderDisplayName ?? m.type}</strong> · <DateTime value={m.createdAt} />
                {m.moderationStatus !== 'CLEAN' ? <StatusBadge status={m.moderationStatus} /> : null}
                {m.reasons.map((r) => (
                  <Badge key={r} tone="warning" dot={false}>
                    {r}
                  </Badge>
                ))}
              </div>
              {m.deleted ? <em className="muted">Pesan dihapus</em> : (m.body ?? <em className="muted">[{m.type}]</em>)}
            </div>
          ))}
        </div>
      </Dialog>
    </>
  );
}
