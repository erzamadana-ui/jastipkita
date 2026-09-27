import { useEffect, useState, type ReactNode } from 'react';
import { fetchFileBlob } from '../api/admin';
import { describeError } from '../api/errors';
import type { DiffEntry } from '../api/types';
import { formatBps, formatBytes, formatDateTime, formatHours, formatIdr, formatPercent, humanize } from '../lib/format';
import { Icon } from './Icon';
import { Button, Callout, EmptyState } from './ui';

export function JsonView({ value, label }: { value: unknown; label?: string }) {
  return (
    <pre className="json" aria-label={label} tabIndex={0}>
      {value === undefined ? '—' : JSON.stringify(value, null, 2)}
    </pre>
  );
}

function compact(v: unknown): string {
  if (v === undefined) return '∅';
  const s = JSON.stringify(v);
  return s.length > 160 ? `${s.slice(0, 157)}…` : s;
}

/** Human reading of a numeric config value, inferred from the key's unit suffix (…Idr, …Bps, …Hours, …Ratio). */
export function unitHint(path: string, v: unknown): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const leaf = path.split('.').pop() ?? '';
  if (/Idr$/.test(leaf)) return formatIdr(v);
  if (/Bps$/.test(leaf)) return formatBps(v);
  if (/Hours$/.test(leaf)) return formatHours(v);
  if (/(Ratio|Rate)$/.test(leaf) && v <= 1) return formatPercent(v, 2);
  return null;
}

function DiffValue({ path, value, className }: { path: string; value: unknown; className: string }) {
  const hint = unitHint(path, value);
  return (
    <span className="diff-val">
      <span className={className}>{compact(value)}</span>
      {hint ? <span className="diff-hint">{hint}</span> : null}
    </span>
  );
}

export function DiffView({ changes, caption, emptyText = 'Tidak ada perbedaan.' }: { changes: DiffEntry[]; caption: string; emptyText?: string }) {
  if (!changes.length) return <EmptyState title={emptyText} icon="check" />;
  const label = { added: 'ditambah', removed: 'dihapus', changed: 'diubah' } as const;
  const sym = { added: '+', removed: '−', changed: '~' } as const;
  return (
    <div className="table-wrap">
      <table className="table table--compact" data-testid="diff-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" style={{ width: 40 }}>
              <span className="sr-only">Operasi</span>
            </th>
            <th scope="col">Path</th>
            <th scope="col">Sebelum</th>
            <th scope="col">Sesudah</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((c) => (
            <tr key={`${c.op}:${c.path}`}>
              <td>
                <span className={`diff-op diff-op--${c.op}`} title={label[c.op]} aria-label={label[c.op]}>
                  {sym[c.op]}
                </span>
              </td>
              <td>
                <code>{c.path}</code>
              </td>
              <td>{c.op === 'added' ? <span className="muted">—</span> : <DiffValue path={c.path} value={c.before} className="diff-before" />}</td>
              <td>{c.op === 'removed' ? <span className="muted">—</span> : <DiffValue path={c.path} value={c.after} className="diff-after" />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface TimelineItem {
  key: string;
  title: ReactNode;
  meta?: ReactNode;
  state?: 'done' | 'current' | 'error' | 'upcoming';
}

export function Timeline({ items, label }: { items: TimelineItem[]; label: string }) {
  if (!items.length) return <p className="muted small">Belum ada riwayat.</p>;
  return (
    <ol className="timeline" aria-label={label}>
      {items.map((i) => (
        <li key={i.key} className={i.state ?? 'done'}>
          <span className="dot" aria-hidden />
          <div className="title">{i.title}</div>
          {i.meta ? <div className="meta">{i.meta}</div> : null}
        </li>
      ))}
    </ol>
  );
}

/** FSM events → timeline rows ("A → B · ADMIN · 27 Sep 2026, 14:32 WIB · reason"). */
export function eventsToTimeline(events: { from: string | null; to: string; actorType: string; reason?: string | null; at: string }[], errorStatuses: string[] = ['DISPUTED', 'CANCELLED', 'REJECTED', 'FAILED']): TimelineItem[] {
  return events.map((e, i) => ({
    key: `${i}-${e.at}`,
    title: (
      <>
        {e.from ? `${humanize(e.from)} → ` : ''}
        <strong>{humanize(e.to)}</strong>
      </>
    ),
    meta: [e.actorType, formatDateTime(e.at), e.reason].filter(Boolean).join(' · '),
    state: errorStatuses.includes(e.to) ? 'error' : i === events.length - 1 ? 'current' : 'done',
  }));
}

/**
 * Authenticated document viewer: GET /v1/files/{id}/content with the bearer token (never a public URL), rendered
 * from an in-memory Blob object URL that is revoked on close/unmount; requests use `cache: no-store` and nothing
 * is kept in the query cache. Loads only on an explicit click because every view is audited server-side.
 */
export function DocumentViewer({ fileId, mime, title, sizeBytes }: { fileId: string; mime?: string | null; title: string; sizeBytes?: number | null }) {
  const [state, setState] = useState<{ url: string; type: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  useEffect(
    () => () => {
      if (state) URL.revokeObjectURL(state.url);
    },
    [state],
  );

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const raw = await fetchFileBlob(fileId);
      // Only inert types are previewed: images, PDF (browser viewer), video. Anything else (e.g. text/html) is never
      // rendered, because a blob: URL inherits the admin origin.
      const t = (raw.type || mime || 'application/octet-stream').toLowerCase();
      const safe = t.startsWith('image/') && t !== 'image/svg+xml' ? t : t === 'application/pdf' || t.startsWith('video/') ? t : 'application/octet-stream';
      const blob = new Blob([raw], { type: safe });
      setState({ url: URL.createObjectURL(blob), type: safe });
    } catch (e) {
      setErr(e);
    } finally {
      setLoading(false);
    }
  };

  const type = state?.type ?? mime ?? '';
  return (
    <figure className="stack stack--sm" style={{ margin: 0 }}>
      <figcaption className="row row--between">
        <span className="row">
          <Icon name="file" size={16} />
          <strong>{title}</strong>
          <span className="muted small">
            {mime ?? 'file'}
            {sizeBytes ? ` · ${formatBytes(sizeBytes)}` : ''}
          </span>
        </span>
        {state ? (
          <Button size="sm" onClick={() => setState(null)} icon="x">
            Tutup
          </Button>
        ) : (
          <Button size="sm" variant="tonal" onClick={() => void load()} loading={loading} icon="eye">
            Buka dokumen
          </Button>
        )}
      </figcaption>
      {err ? <Callout tone="danger">{describeError(err).title}</Callout> : null}
      <div className="doc-viewer">
        {!state ? (
          <span className="muted small row" style={{ padding: 16 }}>
            <Icon name="lock" size={14} /> Dokumen terenkripsi — dibuka lewat API terautentikasi, setiap akses tercatat di audit log.
          </span>
        ) : type.startsWith('image/') ? (
          <img src={state.url} alt={title} />
        ) : type === 'application/pdf' ? (
          <iframe src={state.url} title={title} />
        ) : type.startsWith('video/') ? (
          <video src={state.url} controls aria-label={title} />
        ) : (
          <span className="muted small" style={{ padding: 16 }}>
            Tipe {type} tidak dapat dipratinjau.
          </span>
        )}
      </div>
    </figure>
  );
}
