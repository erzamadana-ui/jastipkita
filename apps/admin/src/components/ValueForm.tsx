/**
 * Form generated from a business-config value's own shape (per key type): objects → fieldsets, numbers → numeric
 * inputs (bps / IDR hints), booleans → checkboxes, strings → text, primitive arrays → comma lists, object arrays →
 * repeatable rows. Validation runs through @jastipkita/core validateBusinessConfig (same validator as the API).
 */
import { useId, useState } from 'react';
import { setIn } from '../lib/diff';
import { formatBps, formatIdr, humanize } from '../lib/format';
import { Button, Checkbox, cx } from './ui';

type Path = (string | number)[];

function label(k: string | number): string {
  if (typeof k === 'number') return `#${k + 1}`;
  return /^[A-Z0-9_]+$/.test(k) ? k : humanize(k.replace(/([a-z])([A-Z])/g, '$1_$2'));
}

function hintFor(key: string | number, v: number): string | null {
  const k = String(key);
  if (/Bps$/i.test(k) || k === 'defaultBps') return formatBps(v);
  if (/Idr$/i.test(k)) return formatIdr(v);
  if (/(^rate$|Rate$|factor$|Factor$|multiplier$)/.test(k) && v <= 1) return `${(v * 100).toFixed(2)} %`;
  return null;
}

function pathStr(p: Path): string {
  return p.reduce<string>((s, k) => (typeof k === 'number' ? `${s}[${k}]` : s ? `${s}.${k}` : k), '');
}

export function ValueForm({ value, onChange, errors = [], rootLabel }: { value: unknown; onChange: (v: unknown) => void; errors?: { path: string; message: string }[]; rootLabel: string }) {
  return (
    <div className="stack" aria-label={rootLabel}>
      <Node value={value} path={[]} root={value} onRoot={onChange} errors={errors} />
    </div>
  );
}

function Node({ value, path, root, onRoot, errors }: { value: unknown; path: Path; root: unknown; onRoot: (v: unknown) => void; errors: { path: string; message: string }[] }) {
  const set = (v: unknown) => onRoot(setIn(root, path, v));
  const key = path[path.length - 1] ?? '';
  const err = errors.filter((e) => e.path === pathStr(path) || e.path.endsWith(`.${pathStr(path)}`)).map((e) => e.message)[0];
  const id = useId();

  if (Array.isArray(value)) {
    const objects = value.length > 0 && value.every((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (!objects) {
      return <PrimitiveList label={label(key)} value={value as (string | number)[]} onChange={set} error={err} />;
    }
    return (
      <fieldset className="fieldset">
        <legend>
          {label(key)} ({value.length})
        </legend>
        <div className="stack">
          {value.map((item, i) => (
            <div key={i} className="stack stack--sm" style={{ borderBottom: '1px dashed var(--jk-color-divider)', paddingBottom: 10 }}>
              <div className="row row--between">
                <strong className="small">
                  {label(key)} #{i + 1}
                </strong>
                <Button size="sm" variant="ghost" onClick={() => set(value.filter((_, j) => j !== i))} aria-label={`Hapus baris ${i + 1}`}>
                  Hapus
                </Button>
              </div>
              <Node value={item} path={[...path, i]} root={root} onRoot={onRoot} errors={errors} />
            </div>
          ))}
          <Button size="sm" icon="plus" onClick={() => set([...value, structuredClone(value[value.length - 1])])}>
            Tambah baris (salin terakhir)
          </Button>
        </div>
      </fieldset>
    );
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const flat = entries.every(([, v]) => v === null || typeof v !== 'object');
    const numericMap = entries.length > 0 && entries.every(([, v]) => typeof v === 'number');
    const body = (
      <div className={cx(flat ? 'form-grid' : 'stack')}>
        {entries.map(([k, v]) => (
          <Node key={k} value={v} path={[...path, k]} root={root} onRoot={onRoot} errors={errors} />
        ))}
        {numericMap ? <AddKey onAdd={(k) => set({ ...(value as Record<string, unknown>), [k]: 0 })} /> : null}
      </div>
    );
    if (!path.length) return body;
    return (
      <fieldset className="fieldset">
        <legend>{label(key)}</legend>
        {body}
      </fieldset>
    );
  }
  if (typeof value === 'boolean') {
    return (
      <div className="field" style={{ justifyContent: 'flex-end' }}>
        <Checkbox checked={value} onChange={set} label={label(key)} />
      </div>
    );
  }
  if (typeof value === 'number') {
    const h = hintFor(key, value);
    return (
      <div className="field">
        <label className="field__label" htmlFor={id}>
          {label(key)}
        </label>
        <input id={id} className="input tabular" type="number" step="any" value={Number.isFinite(value) ? value : ''} onChange={(e) => set(e.target.value === '' ? 0 : Number(e.target.value))} aria-invalid={err ? true : undefined} data-path={pathStr(path)} />
        {h ? <div className="field__help">= {h}</div> : null}
        {err ? <div className="field__error">{err}</div> : null}
      </div>
    );
  }
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label(key)}
      </label>
      {typeof value === 'string' && value.length > 60 ? (
        <textarea id={id} className="textarea" value={value} onChange={(e) => set(e.target.value)} />
      ) : (
        <input id={id} className="input" value={value === null ? '' : String(value)} onChange={(e) => set(value === null && e.target.value === '' ? null : e.target.value)} aria-invalid={err ? true : undefined} data-path={pathStr(path)} />
      )}
      {err ? <div className="field__error">{err}</div> : null}
    </div>
  );
}

function PrimitiveList({ label: l, value, onChange, error }: { label: string; value: (string | number)[]; onChange: (v: unknown) => void; error?: string }) {
  const id = useId();
  const numeric = value.length > 0 && value.every((x) => typeof x === 'number');
  const [text, setText] = useState(value.join(', '));
  return (
    <div className="field" style={{ gridColumn: '1 / -1' }}>
      <label className="field__label" htmlFor={id}>
        {l}
      </label>
      <input
        id={id}
        className="input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const parts = text.split(',').map((x) => x.trim()).filter(Boolean);
          onChange(numeric ? parts.map(Number) : parts);
        }}
      />
      <div className="field__help">Pisahkan dengan koma.</div>
      {error ? <div className="field__error">{error}</div> : null}
    </div>
  );
}

function AddKey({ onAdd }: { onAdd: (k: string) => void }) {
  const [k, setK] = useState('');
  const id = useId();
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        Tambah kunci
      </label>
      <div className="row row--tight">
        <input id={id} className="input input--sm" value={k} onChange={(e) => setK(e.target.value.toUpperCase())} placeholder="mis. USD" style={{ width: 110 }} />
        <Button
          size="sm"
          onClick={() => {
            if (k.trim()) onAdd(k.trim());
            setK('');
          }}
        >
          Tambah
        </Button>
      </div>
    </div>
  );
}
