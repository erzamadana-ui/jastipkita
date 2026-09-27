/**
 * JSON-Schema-driven form (schemas extracted from docs/api/openapi.json into src/api/form-schemas.json by
 * `pnpm gen:api`). Renders object/oneOf(kind)/string/enum/number/integer/boolean/string[] fields with inline
 * validation (required, enum, pattern, min/max, exclusiveMinimum, lengths) — so operators never edit raw JSON for
 * promotion conditions/benefits or rule versions, and the form cannot drift from the API contract.
 */
import { useId, useState, type ReactNode } from 'react';
import formSchemas from '../api/form-schemas.json';
import { formatBps, formatIdr, humanize } from '../lib/format';
import { Checkbox, Field, cx } from './ui';

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: (string | number | boolean | null)[];
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  pattern?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  minLength?: number;
  maxLength?: number;
  description?: string;
  default?: unknown;
  example?: unknown;
}

export const SCHEMAS = (formSchemas as unknown as { schemas: Record<string, JsonSchema> }).schemas;

export type FormValue = Record<string, unknown>;

function types(s: JsonSchema): string[] {
  if (s.anyOf) return s.anyOf.flatMap(types);
  return Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
}
function baseType(s: JsonSchema): string {
  return types(s).find((t) => t !== 'null') ?? 'string';
}
function nullable(s: JsonSchema): boolean {
  return types(s).includes('null');
}
function variantOf(s: JsonSchema, v: FormValue): JsonSchema | null {
  if (!s.oneOf) return null;
  const kind = v.kind;
  return s.oneOf.find((o) => o.properties?.kind?.enum?.[0] === kind) ?? null;
}

// ------------------------------------------------------------------ validation

export function validateAgainst(schema: JsonSchema, value: unknown, path = ''): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  if (schema.oneOf) {
    const v = (value ?? {}) as FormValue;
    const variant = variantOf(schema, v);
    if (!variant) return [{ path: path ? `${path}.kind` : 'kind', message: 'Pilih jenis' }];
    return validateAgainst(variant, v, path);
  }
  const t = baseType(schema);
  if (value === undefined || value === null || value === '') {
    return out;
  }
  if (t === 'object' && schema.properties) {
    const v = value as FormValue;
    for (const req of schema.required ?? []) {
      if (v[req] === undefined || v[req] === '' || v[req] === null) out.push({ path: path ? `${path}.${req}` : req, message: 'Wajib diisi' });
    }
    for (const [k, sub] of Object.entries(schema.properties)) out.push(...validateAgainst(sub, v[k], path ? `${path}.${k}` : k));
    return out;
  }
  if (t === 'integer' || t === 'number') {
    const n = value as number;
    if (typeof n !== 'number' || Number.isNaN(n)) return [{ path, message: 'Harus angka' }];
    if (t === 'integer' && !Number.isInteger(n)) out.push({ path, message: 'Harus bilangan bulat' });
    if (schema.minimum !== undefined && n < schema.minimum) out.push({ path, message: `Minimal ${schema.minimum}` });
    if (schema.maximum !== undefined && n > schema.maximum) out.push({ path, message: `Maksimal ${schema.maximum}` });
    if (schema.exclusiveMinimum !== undefined && n <= schema.exclusiveMinimum) out.push({ path, message: `Harus > ${schema.exclusiveMinimum}` });
    return out;
  }
  if (t === 'array') {
    const arr = value as unknown[];
    arr.forEach((x, i) => schema.items && out.push(...validateAgainst(schema.items, x, `${path}[${i}]`)));
    return out;
  }
  if (t === 'string') {
    const s = String(value);
    if (schema.enum && !schema.enum.includes(s)) out.push({ path, message: 'Nilai tidak dikenal' });
    if (schema.pattern && !new RegExp(schema.pattern).test(s)) out.push({ path, message: `Format tidak valid (${schema.pattern})` });
    if (schema.format === 'uuid' && !/^[0-9a-f-]{36}$/i.test(s)) out.push({ path, message: 'Harus UUID' });
    if (schema.minLength !== undefined && s.length < schema.minLength) out.push({ path, message: `Minimal ${schema.minLength} karakter` });
    if (schema.maxLength !== undefined && s.length > schema.maxLength) out.push({ path, message: `Maksimal ${schema.maxLength} karakter` });
  }
  return out;
}

/** Drops empty optional values so PATCH/POST bodies only carry what the operator set. */
export function cleanValue(schema: JsonSchema, value: FormValue): FormValue {
  const s = schema.oneOf ? (variantOf(schema, value) ?? schema) : schema;
  const out: FormValue = {};
  for (const [k, sub] of Object.entries(s.properties ?? {})) {
    const v = value[k];
    if (v === undefined || v === '') continue;
    if (Array.isArray(v) && v.length === 0 && !(s.required ?? []).includes(k)) continue;
    if (v === null && !nullable(sub)) continue;
    out[k] = baseType(sub) === 'object' && sub.properties && v && typeof v === 'object' ? cleanValue(sub, v as FormValue) : v;
  }
  return out;
}

// ------------------------------------------------------------------ rendering

export interface SchemaFormProps {
  schema: JsonSchema;
  value: FormValue;
  onChange: (v: FormValue) => void;
  labels?: Record<string, string>;
  hints?: Record<string, ReactNode>;
  hidden?: string[];
  readOnly?: string[];
  /** Known option lists for free-text arrays/strings (e.g. countries, categories). */
  options?: Record<string, { value: string; label: string }[]>;
  errors?: { path: string; message: string }[];
  pathPrefix?: string;
  columns?: boolean;
}

export function SchemaForm({ schema, value, onChange, labels = {}, hints = {}, hidden = [], readOnly = [], options = {}, errors = [], pathPrefix = '', columns = true }: SchemaFormProps) {
  if (schema.oneOf) {
    const kinds = schema.oneOf.map((o) => String(o.properties?.kind?.enum?.[0]));
    const variant = variantOf(schema, value);
    return (
      <div className="stack">
        <Field label={labels.kind ?? 'Jenis'} required>
          <select className="select" value={String(value.kind ?? '')} onChange={(e) => onChange({ kind: e.target.value })} data-field="kind">
            <option value="">— pilih —</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {labels[`kind:${k}`] ?? humanize(k)}
              </option>
            ))}
          </select>
        </Field>
        {variant ? <SchemaForm schema={{ ...variant, properties: Object.fromEntries(Object.entries(variant.properties ?? {}).filter(([k]) => k !== 'kind')) }} value={value} onChange={(v) => onChange({ ...v, kind: value.kind })} labels={labels} hints={hints} hidden={hidden} readOnly={readOnly} options={options} errors={errors} pathPrefix={pathPrefix} columns={columns} /> : null}
      </div>
    );
  }
  const props = Object.entries(schema.properties ?? {}).filter(([k]) => !hidden.includes(k));
  const req = new Set(schema.required ?? []);
  return (
    <div className={cx(columns ? 'form-grid' : 'stack')}>
      {props.map(([k, sub]) => {
        const path = pathPrefix ? `${pathPrefix}.${k}` : k;
        const err = errors.find((e) => e.path === path)?.message ?? null;
        return (
          <PropField
            key={k}
            name={k}
            schema={sub}
            value={value[k]}
            required={req.has(k)}
            label={labels[k] ?? humanize(k.replace(/([a-z])([A-Z])/g, '$1_$2'))}
            hint={hints[k]}
            readOnly={readOnly.includes(k)}
            options={options[k]}
            error={err}
            onChange={(v) => onChange({ ...value, [k]: v })}
          />
        );
      })}
    </div>
  );
}

function autoHint(name: string, schema: JsonSchema, value: unknown): ReactNode {
  const parts: ReactNode[] = [];
  if (typeof value === 'number' && /Bps$/.test(name)) parts.push(`= ${formatBps(value)}`);
  if (typeof value === 'number' && /Idr$/.test(name)) parts.push(`= ${formatIdr(value)}`);
  if (schema.description) parts.push(schema.description);
  if (schema.example !== undefined && typeof value !== 'number') parts.push(`contoh: ${String(schema.example)}`);
  return parts.length ? parts.join(' · ') : null;
}

function PropField({ name, schema, value, required, label, hint, readOnly, options, error, onChange }: { name: string; schema: JsonSchema; value: unknown; required: boolean; label: string; hint?: ReactNode; readOnly: boolean; options?: { value: string; label: string }[]; error: string | null; onChange: (v: unknown) => void }) {
  const t = baseType(schema);
  const help = hint ?? autoHint(name, schema, value);
  const isNull = nullable(schema);
  if (t === 'boolean') {
    return (
      <div className="field" style={{ justifyContent: 'flex-end' }}>
        <Checkbox checked={value === true} onChange={(v) => onChange(v)} label={label} disabled={readOnly} hint={help} />
      </div>
    );
  }
  if (t === 'array') {
    return <ArrayField label={label} schema={schema} value={(value as string[] | undefined) ?? []} onChange={onChange} options={options} hint={help} error={error} required={required} readOnly={readOnly} />;
  }
  if (t === 'integer' || t === 'number') {
    return (
      <Field label={label} hint={help} error={error} required={required}>
        <input
          className="input tabular"
          type="number"
          inputMode="numeric"
          step={t === 'integer' ? 1 : 'any'}
          min={schema.minimum}
          max={schema.maximum}
          value={value === undefined || value === null ? '' : String(value)}
          readOnly={readOnly}
          onChange={(e) => onChange(e.target.value === '' ? (isNull ? null : undefined) : Number(e.target.value))}
          data-field={name}
        />
      </Field>
    );
  }
  const enumVals = schema.enum?.filter((x): x is string => typeof x === 'string');
  if (enumVals?.length || options?.length) {
    const opts = enumVals?.length ? enumVals.map((v) => ({ value: v, label: humanize(v) })) : options!;
    return (
      <Field label={label} hint={help} error={error} required={required}>
        <select className="select" value={value === undefined || value === null ? '' : String(value)} disabled={readOnly} onChange={(e) => onChange(e.target.value === '' ? (isNull ? null : undefined) : e.target.value)} data-field={name}>
          <option value="">{required ? '— pilih —' : '(kosong)'}</option>
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
    );
  }
  const isDate = schema.format === 'date' || schema.pattern === '^\\d{4}-\\d{2}-\\d{2}$';
  const isDateTime = schema.format === 'date-time';
  return (
    <Field label={label} hint={help} error={error} required={required}>
      <input
        className="input"
        type={isDate ? 'date' : isDateTime ? 'datetime-local' : 'text'}
        value={value === undefined || value === null ? '' : isDateTime ? String(value).slice(0, 16) : String(value)}
        readOnly={readOnly}
        maxLength={schema.maxLength}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '') onChange(isNull ? null : undefined);
          else onChange(isDateTime ? new Date(v).toISOString() : v);
        }}
        spellCheck={false}
        data-field={name}
      />
    </Field>
  );
}

function ArrayField({ label, schema, value, onChange, options, hint, error, required, readOnly }: { label: string; schema: JsonSchema; value: string[]; onChange: (v: unknown) => void; options?: { value: string; label: string }[]; hint?: ReactNode; error: string | null; required: boolean; readOnly: boolean }) {
  const [draft, setDraft] = useState('');
  const id = useId();
  const itemEnum = schema.items?.enum?.filter((x): x is string => typeof x === 'string');
  const choices = itemEnum?.length ? itemEnum.map((v) => ({ value: v, label: humanize(v) })) : options;
  const add = (raw: string) => {
    const items = raw
      .split(/[,\n]/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => (schema.items?.pattern && /\[A-Z\]/.test(schema.items.pattern) ? x.toUpperCase() : x));
    if (items.length) onChange([...new Set([...value, ...items])]);
    setDraft('');
  };
  return (
    <div className="field" style={{ gridColumn: '1 / -1' }}>
      <label className="field__label" htmlFor={id}>
        {label}
        {required ? <span className="req"> *</span> : null}
      </label>
      <div className="row row--tight" aria-live="polite">
        {value.length === 0 ? <span className="muted small">(kosong — berlaku untuk semua)</span> : null}
        {value.map((v) => (
          <span key={v} className="chip">
            {choices?.find((c) => c.value === v)?.label ?? v}
            {!readOnly ? (
              <button type="button" aria-label={`Hapus ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}>
                ×
              </button>
            ) : null}
          </span>
        ))}
      </div>
      {!readOnly ? (
        choices?.length ? (
          <select id={id} className="select" value="" onChange={(e) => e.target.value && add(e.target.value)} aria-describedby={hint ? `${id}-h` : undefined}>
            <option value="">+ tambah…</option>
            {choices
              .filter((c) => !value.includes(c.value))
              .map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
          </select>
        ) : (
          <input
            id={id}
            className="input"
            value={draft}
            placeholder="Ketik lalu Enter (pisahkan dengan koma)"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add(draft);
              }
            }}
            onBlur={() => draft && add(draft)}
            aria-describedby={hint ? `${id}-h` : undefined}
          />
        )
      ) : null}
      {hint ? (
        <div className="field__help" id={`${id}-h`}>
          {hint}
        </div>
      ) : null}
      {error ? <div className="field__error">{error}</div> : null}
    </div>
  );
}
