/**
 * Small component set on the design tokens (no UI kit). Accessibility rules (docs/05 §4): visible labels, status =
 * dot + text, disabled actions stay focusable (aria-disabled) and announce WHY they are disabled.
 */
import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';
import { formatDateTime, formatIdr, formatRelative, humanize, spokenIdr } from '../lib/format';
import { modeTone, STATUS_LABEL, statusTone, type Tone } from '../lib/status';
import { Icon, type AnyIcon } from './Icon';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ------------------------------------------------------------------ buttons

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> {
  variant?: 'primary' | 'secondary' | 'danger' | 'danger-outline' | 'ghost' | 'tonal' | 'success';
  size?: 'sm' | 'md';
  icon?: AnyIcon;
  loading?: boolean;
  /** Disabled with an explanation (kept focusable; reason is announced and shown as tooltip). */
  disabledReason?: string | null;
  disabled?: boolean;
  /** Marks an action that needs a fresh TOTP step-up (lock icon + hint). */
  mfa?: boolean;
}

export function Button({ variant = 'secondary', size = 'md', icon, loading, disabledReason, disabled, mfa, children, className, onClick, type, title, ...rest }: ButtonProps) {
  const reasonId = useId();
  const blocked = !!disabledReason || !!disabled || !!loading;
  return (
    <>
      <button
        {...rest}
        type={type ?? 'button'}
        className={cx('btn', variant !== 'secondary' && `btn--${variant}`, size === 'sm' && 'btn--sm', !children && 'btn--icon', className)}
        aria-disabled={blocked || undefined}
        disabled={!!disabled && !disabledReason}
        aria-busy={loading || undefined}
        aria-describedby={disabledReason ? reasonId : rest['aria-describedby']}
        title={disabledReason ?? title ?? (mfa ? 'Butuh verifikasi MFA (TOTP) ≤ 15 menit' : undefined)}
        onClick={(e) => {
          if (blocked) {
            e.preventDefault();
            return;
          }
          onClick?.(e);
        }}
        style={rest.style}
      >
        {loading ? <span className="spinner" aria-hidden /> : icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
        {children}
        {mfa && !loading ? <Icon name="lock" size={12} label="Butuh MFA" /> : null}
      </button>
      {disabledReason ? (
        <span id={reasonId} className="sr-only">
          {disabledReason}
        </span>
      ) : null}
    </>
  );
}

// ------------------------------------------------------------------ badges

export function Badge({ tone = 'neutral', children, dot = true, className, title }: { tone?: Tone; children: ReactNode; dot?: boolean; className?: string; title?: string }) {
  return (
    <span className={cx('badge', `badge--${tone}`, !dot && 'badge--nodot', className)} title={title}>
      {children}
    </span>
  );
}

export function StatusBadge({ status, tone, label }: { status: string | null | undefined; tone?: Tone; label?: string }) {
  if (!status) return <span className="muted">—</span>;
  return (
    <Badge tone={tone ?? statusTone(status)} title={status}>
      {label ?? STATUS_LABEL[status] ?? humanize(status)}
    </Badge>
  );
}

export function ModeBadge({ name, mode }: { name: string; mode: string }) {
  return (
    <Badge tone={modeTone(mode)} title={`${name}: ${mode}`}>
      {name} · {mode}
    </Badge>
  );
}

// ------------------------------------------------------------------ layout pieces

export function Card({ title, hint, actions, children, footer, flush, className, id }: { title?: ReactNode; hint?: ReactNode; actions?: ReactNode; children?: ReactNode; footer?: ReactNode; flush?: boolean; className?: string; id?: string }) {
  const hid = useId();
  return (
    <section className={cx('card', className)} aria-labelledby={title ? hid : undefined} id={id}>
      {title || actions ? (
        <header className="card__header">
          <div>
            {title ? <h2 id={hid}>{title}</h2> : null}
            {hint ? <div className="hint">{hint}</div> : null}
          </div>
          {actions ? <div className="btn-group">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cx('card__body', flush && 'card__body--flush')}>{children}</div>
      {footer ? <footer className="card__footer">{footer}</footer> : null}
    </section>
  );
}

export function PageHeader({ title, subtitle, actions, breadcrumb }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; breadcrumb?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        {breadcrumb ? <div className="breadcrumb">{breadcrumb}</div> : null}
        <h1 tabIndex={-1} data-page-title>
          {title}
        </h1>
        {subtitle ? <p className="subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="btn-group">{actions}</div> : null}
    </div>
  );
}

export function Callout({ tone = 'info', icon, title, children }: { tone?: 'info' | 'warning' | 'danger' | 'success' | 'neutral'; icon?: AnyIcon; title?: ReactNode; children?: ReactNode }) {
  const ic: AnyIcon = icon ?? (tone === 'danger' ? 'alert' : tone === 'warning' ? 'alert' : tone === 'success' ? 'check' : 'info');
  return (
    <div className={`callout callout--${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      <Icon name={ic} />
      <div>
        {title ? <strong>{title} </strong> : null}
        {children}
      </div>
    </div>
  );
}

export function EmptyState({ title, children, icon = 'search' }: { title: string; children?: ReactNode; icon?: AnyIcon }) {
  return (
    <div className="empty">
      <Icon name={icon} size={28} />
      <div className="empty__title">{title}</div>
      {children ? <div className="small">{children}</div> : null}
    </div>
  );
}

export function Skeleton({ width = '100%', height = 14 }: { width?: number | string; height?: number }) {
  return <span className="skeleton" style={{ width, height }} aria-hidden />;
}

export function LoadingBlock({ rows = 4, label = 'Memuat data…' }: { rows?: number; label?: string }) {
  return (
    <div className="stack stack--sm" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} width={`${90 - i * 9}%`} height={16} />
      ))}
    </div>
  );
}

export function KeyValue({ items, cols = 1 }: { items: [ReactNode, ReactNode][]; cols?: 1 | 2 }) {
  return (
    <dl className={cx('kv', cols === 2 && 'kv--2')}>
      {items.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v ?? <span className="muted">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Meter({ ratio, label, tone }: { ratio: number | null; label: string; tone?: 'warn' | 'danger' }) {
  const pct = ratio === null ? 0 : Math.max(0, Math.min(1, ratio)) * 100;
  return (
    <div className={cx('meter', tone && `meter--${tone}`)} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={label}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

// ------------------------------------------------------------------ values

export function Money({ value, className, emphasize }: { value: number | null | undefined; className?: string; emphasize?: boolean }) {
  return (
    <span className={cx('money', value !== null && value !== undefined && value < 0 && 'money--neg', className)} aria-label={spokenIdr(value)} style={emphasize ? { fontWeight: 600 } : undefined}>
      {formatIdr(value)}
    </span>
  );
}

export function DateTime({ value, relative }: { value: string | null | undefined; relative?: boolean }) {
  if (!value) return <span className="muted">—</span>;
  return (
    <time dateTime={value} title={formatDateTime(value)} className="nowrap">
      {relative ? formatRelative(value) : formatDateTime(value)}
    </time>
  );
}

export function IdText({ id, full }: { id: string | null | undefined; full?: boolean }) {
  if (!id) return <span className="muted">—</span>;
  return (
    <code className="mono" title={id}>
      {full ? id : id.slice(0, 8)}
    </code>
  );
}

export function CopyButton({ value, label = 'Salin' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={done ? 'check' : 'copy'}
      aria-label={`${label}: ${value}`}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    />
  );
}

// ------------------------------------------------------------------ tooltip

export function InfoTip({ children, label = 'Definisi' }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDoc);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDoc);
    };
  }, [open]);
  return (
    <span className="tip" ref={ref} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" className="tip__btn" aria-label={label} aria-describedby={id} aria-expanded={open} onClick={() => setOpen((o) => !o)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
        <Icon name="info" size={14} />
      </button>
      <span role="tooltip" id={id} className="tip__bubble" hidden={!open}>
        {children}
      </span>
    </span>
  );
}

// ------------------------------------------------------------------ form fields

export function Field({ label, hint, error, required, children, className }: { label: ReactNode; hint?: ReactNode; error?: string | null; required?: boolean; children: ReactElement; className?: string }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const child = Children.only(children);
  const describedBy = [hint ? hintId : null, error ? errId : null].filter(Boolean).join(' ') || undefined;
  const control = isValidElement(child)
    ? cloneElement(child as ReactElement<Record<string, unknown>>, {
        id: (child.props as { id?: string }).id ?? id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
        'aria-required': required || undefined,
      })
    : child;
  const controlId = isValidElement(child) ? ((child.props as { id?: string }).id ?? id) : id;
  return (
    <div className={cx('field', className)}>
      <label className="field__label" htmlFor={controlId}>
        {label}
        {required ? (
          <span className="req" aria-hidden>
            {' '}
            *
          </span>
        ) : null}
      </label>
      {control}
      {hint ? (
        <div className="field__help" id={hintId}>
          {hint}
        </div>
      ) : null}
      {error ? (
        <div className="field__error" id={errId}>
          <Icon name="alert" size={13} />
          {error}
        </div>
      ) : null}
    </div>
  );
}

export function Checkbox({ checked, onChange, label, disabled, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean; hint?: ReactNode }) {
  const id = useId();
  return (
    <div>
      <label className="checkbox" htmlFor={id}>
        <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-describedby={hint ? `${id}-h` : undefined} />
        <span>{label}</span>
      </label>
      {hint ? (
        <div className="field__help" id={`${id}-h`} style={{ marginLeft: 24 }}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

export function Select({ value, onChange, options, placeholder, className, id, ...rest }: { value: string; onChange: (v: string) => void; options: (string | { value: string; label: string })[]; placeholder?: string; className?: string; id?: string; 'aria-label'?: string; disabled?: boolean }) {
  return (
    <select id={id} className={cx('select', className)} value={value} onChange={(e) => onChange(e.target.value)} {...rest}>
      {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
      {options.map((o) => {
        const v = typeof o === 'string' ? o : o.value;
        const l = typeof o === 'string' ? humanize(o) : o.label;
        return (
          <option key={v} value={v}>
            {l}
          </option>
        );
      })}
    </select>
  );
}

// ------------------------------------------------------------------ tabs

export function Tabs<K extends string>({ tabs, value, onChange, label }: { tabs: { key: K; label: string; count?: number }[]; value: K; onChange: (k: K) => void; label: string }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button
          key={t.key}
          ref={(el) => {
            refs.current[t.key] = el;
          }}
          role="tab"
          id={`tab-${t.key}`}
          aria-selected={value === t.key}
          aria-controls={`panel-${t.key}`}
          tabIndex={value === t.key ? 0 : -1}
          onClick={() => onChange(t.key)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!;
            onChange(next.key);
            refs.current[next.key]?.focus();
          }}
        >
          {t.label}
          {t.count !== undefined ? <span className="count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} className="stack stack--lg">
      {children}
    </div>
  );
}

export function Segmented<K extends string>({ options, value, onChange, label }: { options: { key: K; label: string }[]; value: K; onChange: (k: K) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.key} type="button" aria-pressed={value === o.key} onClick={() => onChange(o.key)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
