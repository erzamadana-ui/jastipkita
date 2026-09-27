import { useState } from 'react';
import { Audit } from '../../api/admin';
import { describeError } from '../../api/errors';
import type { AuditRow, AuditVerify } from '../../api/types';
import { DataTable, useCursorQuery } from '../../components/DataTable';
import { JsonView } from '../../components/data';
import { Drawer } from '../../components/Overlay';
import { Badge, Button, Callout, Card, DateTime, Field, IdText, KeyValue, PageHeader, Select } from '../../components/ui';

export default function AuditPage() {
  const [draft, setDraft] = useState({ actorId: '', actorType: '', entityType: '', entityId: '', action: '', from: '', to: '' });
  const [filters, setFilters] = useState(draft);
  const q = Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) as Record<string, string>;
  const { query, rows, pagination } = useCursorQuery(['audit', q], (cursor) => Audit.list({ ...q, cursor, limit: 50 } as never));
  const [open, setOpen] = useState<AuditRow | null>(null);
  const [verify, setVerify] = useState<AuditVerify | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verr, setVerr] = useState<unknown>(null);
  const runVerify = async () => {
    setVerifying(true);
    setVerr(null);
    try {
      setVerify(await Audit.verify());
    } catch (e) {
      setVerr(e);
    } finally {
      setVerifying(false);
    }
  };
  const set = (k: keyof typeof draft, v: string) => setDraft((d) => ({ ...d, [k]: v }));
  return (
    <div className="stack stack--lg">
      <PageHeader
        title="Audit log"
        subtitle="Append-only, berantai hash (tiap baris menyimpan hash baris sebelumnya). Terbaru di atas."
        actions={
          <Button variant="primary" icon="shield" loading={verifying} onClick={() => void runVerify()} data-testid="verify-chain">
            Verifikasi rantai audit
          </Button>
        }
      />
      {verr ? <Callout tone="danger">{describeError(verr).title}</Callout> : null}
      {verify ? (
        <Callout tone={verify.status === 'OK' ? 'success' : 'danger'} title={verify.status === 'OK' ? 'Rantai audit utuh.' : `Rantai RUSAK pada id ${verify.brokenAtId}.`}>
          <span className="small">
            Head #{verify.head?.lastId ?? '—'} <code>{verify.head?.lastHash.slice(0, 16)}…</code> · checkpoint eksternal terakhir #{verify.lastCheckpoint?.lastId ?? '—'} {verify.lastCheckpoint?.anchoredTo ? `(${verify.lastCheckpoint.anchoredTo})` : ''} · {verify.durationMs} ms · <DateTime value={verify.checkedAt} />. {verify.note}
          </span>
        </Callout>
      ) : null}
      <Card flush>
        <form
          className="filterbar"
          onSubmit={(e) => {
            e.preventDefault();
            setFilters(draft);
          }}
        >
          <Field label="Aksi (akhiri * untuk prefix)">
            <input className="input mono" value={draft.action} onChange={(e) => set('action', e.target.value)} placeholder="finance.*" />
          </Field>
          <Field label="Tipe aktor">
            <Select value={draft.actorType} onChange={(v) => set('actorType', v)} placeholder="Semua" options={['ADMIN', 'USER', 'BUYER', 'TRAVELER', 'SYSTEM', 'WEBHOOK', 'JOB']} />
          </Field>
          <Field label="ID aktor">
            <input className="input mono" value={draft.actorId} onChange={(e) => set('actorId', e.target.value.trim())} />
          </Field>
          <Field label="Tipe entitas">
            <input className="input mono" value={draft.entityType} onChange={(e) => set('entityType', e.target.value.trim())} placeholder="transaction" />
          </Field>
          <Field label="ID entitas">
            <input className="input mono" value={draft.entityId} onChange={(e) => set('entityId', e.target.value.trim())} />
          </Field>
          <Field label="Dari">
            <input className="input" type="date" value={draft.from} onChange={(e) => set('from', e.target.value)} />
          </Field>
          <Field label="Sampai">
            <input className="input" type="date" value={draft.to} onChange={(e) => set('to', e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" icon="search">
            Terapkan
          </Button>
        </form>
        <DataTable
          compact
          caption="Audit log"
          rows={rows}
          loading={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
          rowKey={(a) => String(a.id)}
          onRowClick={setOpen}
          rowLabel={(a) => `Detail audit ${a.id} ${a.action}`}
          pagination={pagination}
          empty={{ title: 'Tidak ada entri' }}
          columns={[
            { key: 'id', header: '#', align: 'right', render: (a) => <span className="mono">{a.id}</span> },
            { key: 't', header: 'Waktu', render: (a) => <DateTime value={a.occurredAt} /> },
            { key: 'act', header: 'Aksi', render: (a) => <code>{a.action}</code> },
            { key: 'actor', header: 'Aktor', render: (a) => <span className="row row--tight"><Badge tone={a.actorType === 'ADMIN' ? 'navy' : 'neutral'} dot={false}>{a.actorType}</Badge><IdText id={a.actorId} /></span> },
            { key: 'e', header: 'Entitas', render: (a) => <span className="small">{a.entityType} <IdText id={a.entityId} /></span> },
            { key: 'rid', header: 'Request', render: (a) => <IdText id={a.requestId} /> },
            { key: 'h', header: 'Hash', render: (a) => <code className="small" title={a.hash}>{a.hash.slice(0, 10)}…</code> },
          ]}
        />
      </Card>
      {open ? (
        <Drawer open onClose={() => setOpen(null)} title={`Audit #${open.id}`} subtitle={<code>{open.action}</code>} wide>
          <KeyValue
            cols={2}
            items={[
              ['Waktu', <DateTime value={open.occurredAt} />],
              ['Aktor', `${open.actorType} ${open.actorId ?? ''}`],
              ['Peran', open.actorRole],
              ['Entitas', `${open.entityType} ${open.entityId ?? ''}`],
              ['Request ID', <code>{open.requestId ?? '—'}</code>],
              ['Hash', <code className="small">{open.hash}</code>],
            ]}
          />
          <div className="grid grid-2">
            <Card title="Sebelum">
              <JsonView value={open.before} />
            </Card>
            <Card title="Sesudah">
              <JsonView value={open.after} />
            </Card>
          </div>
          <Card title="Meta">
            <JsonView value={open.meta} />
          </Card>
        </Drawer>
      ) : null}
    </div>
  );
}
