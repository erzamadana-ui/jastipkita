/**
 * Accessible SVG charts without a chart library. Every chart has a text alternative: an aria-label summary plus a
 * visually-hidden data table (screen readers) and keyboard inspection of points (arrow keys) on the line chart.
 */
import { useId, useMemo, useState, type ReactNode } from 'react';
import type { Tone } from '../lib/status';
import { cx } from './ui';

function niceStep(range: number, ticks: number): number {
  const raw = range / Math.max(1, ticks);
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * mag;
}

export function niceTicks(min: number, max: number, count = 4): number[] {
  if (max === min) max = min + 1;
  const step = niceStep(max - min, count);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

export interface LinePoint {
  x: string;
  y: number;
  n?: number;
}

export function LineChart({ points, label, formatY, formatX, height = 220, emptyText = 'Belum ada data pada periode ini.' }: { points: LinePoint[]; label: string; formatY: (v: number) => string; formatX: (x: string) => string; height?: number; emptyText?: string }) {
  const W = 720;
  const H = height;
  const m = { t: 12, r: 16, b: 28, l: 76 };
  const [active, setActive] = useState<number | null>(null);
  const tableId = useId();
  const liveId = useId();
  const ys = points.map((p) => p.y);
  const maxY = Math.max(0, ...ys);
  const minY = Math.min(0, ...ys);
  const ticks = niceTicks(minY, maxY, 4);
  const y0 = ticks[0]!;
  const y1 = ticks[ticks.length - 1]!;
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const xAt = (i: number) => m.l + (points.length <= 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const yAt = (v: number) => m.t + ih - ((v - y0) / (y1 - y0 || 1)) * ih;
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${xAt(i).toFixed(1)},${yAt(p.y).toFixed(1)}`).join(' ');
  const area = points.length ? `${path} L${xAt(points.length - 1).toFixed(1)},${yAt(y0).toFixed(1)} L${xAt(0).toFixed(1)},${yAt(y0).toFixed(1)} Z` : '';
  const every = Math.max(1, Math.ceil(points.length / 8));
  const total = ys.reduce((a, b) => a + b, 0);
  const peak = points.reduce<LinePoint | null>((b, p) => (!b || p.y > b.y ? p : b), null);
  const summary = points.length
    ? `${label}: ${points.length} titik dari ${formatX(points[0]!.x)} sampai ${formatX(points[points.length - 1]!.x)}, total ${formatY(total)}, puncak ${peak ? `${formatY(peak.y)} pada ${formatX(peak.x)}` : '-'}.`
    : `${label}: ${emptyText}`;
  const act = active !== null ? points[active] : null;

  return (
    <figure className="chart" style={{ margin: 0 }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={summary}
        aria-describedby={tableId}
        tabIndex={points.length ? 0 : -1}
        onKeyDown={(e) => {
          if (!points.length) return;
          if (e.key === 'ArrowRight') setActive((a) => Math.min(points.length - 1, (a ?? -1) + 1));
          else if (e.key === 'ArrowLeft') setActive((a) => Math.max(0, (a ?? points.length) - 1));
          else if (e.key === 'Escape') setActive(null);
        }}
        onMouseMove={(e) => {
          if (!points.length) return;
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const x = ((e.clientX - r.left) / r.width) * W;
          const i = Math.round(((x - m.l) / iw) * (points.length - 1));
          setActive(Math.max(0, Math.min(points.length - 1, i)));
        }}
        onMouseLeave={() => setActive(null)}
        onBlur={() => setActive(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid-line" x1={m.l} x2={W - m.r} y1={yAt(t)} y2={yAt(t)} />
            <text className="axis-label" x={m.l - 8} y={yAt(t) + 3.5} textAnchor="end">
              {formatY(t)}
            </text>
          </g>
        ))}
        {points.map((p, i) =>
          // regular ticks every `every` points, plus the last one — dropping a regular tick that would collide with it
          i === points.length - 1 || (i % every === 0 && points.length - 1 - i >= every * 0.6) ? (
            <text key={p.x} className="axis-label" x={xAt(i)} y={H - 8} textAnchor="middle">
              {formatX(p.x)}
            </text>
          ) : null,
        )}
        {points.length ? (
          <>
            <path className="series-area" d={area} />
            <path className="series-line" d={path} />
          </>
        ) : (
          <text className="axis-label" x={W / 2} y={H / 2} textAnchor="middle">
            {emptyText}
          </text>
        )}
        {points.length <= 45 ? points.map((p, i) => <circle key={p.x} className="series-point" cx={xAt(i)} cy={yAt(p.y)} r={active === i ? 4.5 : 2.5} />) : null}
        {act && active !== null ? (
          <g>
            <line className="hover-line" x1={xAt(active)} x2={xAt(active)} y1={m.t} y2={m.t + ih} />
            <circle className="series-point" cx={xAt(active)} cy={yAt(act.y)} r={5} />
          </g>
        ) : null}
      </svg>
      <figcaption className="legend-note row row--between" style={{ minHeight: 20 }}>
        <span id={liveId} aria-live="polite">
          {act ? (
            <>
              <strong>{formatX(act.x)}</strong> · {formatY(act.y)}
              {act.n !== undefined ? ` · n=${act.n}` : ''}
            </>
          ) : (
            'Arahkan kursor atau fokus grafik + tombol panah untuk melihat nilai.'
          )}
        </span>
      </figcaption>
      <table className="sr-only" id={tableId}>
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">Periode</th>
            <th scope="col">Nilai</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.x}>
              <td>{formatX(p.x)}</td>
              <td>{formatY(p.y)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export function Sparkline({ values, label, width = 96, height = 28 }: { values: number[]; label: string; width?: number; height?: number }) {
  const d = useMemo(() => {
    if (values.length < 2) return '';
    const max = Math.max(...values);
    const min = Math.min(...values);
    return values
      .map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * width).toFixed(1)},${(height - 2 - ((v - min) / (max - min || 1)) * (height - 4)).toFixed(1)}`)
      .join(' ');
  }, [values, width, height]);
  return (
    <svg className="chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      <path className="series-line" d={d} style={{ strokeWidth: 1.6 }} />
    </svg>
  );
}

export interface BarItem {
  key: string;
  label: ReactNode;
  value: number;
  display?: ReactNode;
  tone?: Tone;
  sub?: ReactNode;
}

const TONE_DOT: Record<Tone, string> = {
  neutral: 'var(--jk-status-closed-dot)',
  info: 'var(--jk-status-open-dot)',
  success: 'var(--jk-status-secured-dot)',
  warning: 'var(--jk-status-action-required-dot)',
  danger: 'var(--jk-status-disputed-dot)',
  violet: 'var(--jk-status-in-transit-dot)',
  teal: 'var(--jk-status-delivered-dot)',
  sky: 'var(--jk-status-refund-dot)',
  completed: 'var(--jk-status-completed-dot)',
  amber: 'var(--jk-kyc-level5-dot)',
  navy: 'var(--jk-kyc-level4-dot)',
};

export interface FunnelStepItem {
  key: string;
  label: ReactNode;
  count: number;
  /** Ratio vs the previous step (null for the first step). */
  conversion: number | null;
  tone?: Tone;
  note?: ReactNode;
}

/**
 * Funnel as an ordered list: each step shows its count and conversion from the previous step in text, with a
 * full-width bar scaled to the first step. Screen readers get the same text (bars are decorative).
 */
export function Funnel({ steps, label, formatCount, formatRatio }: { steps: FunnelStepItem[]; label: string; formatCount: (n: number) => string; formatRatio: (r: number) => string }) {
  const top = Math.max(1, ...steps.map((s) => s.count));
  return (
    <ol className="funnel" aria-label={label}>
      {steps.map((s) => (
        <li key={s.key}>
          <div className="funnel__head">
            <span className="funnel__label">{s.label}</span>
            <span className="funnel__val">
              <strong>{formatCount(s.count)}</strong>
              {s.conversion !== null ? <span className="funnel__conv">{formatRatio(s.conversion)} dari langkah sebelumnya</span> : <span className="funnel__conv">langkah awal</span>}
            </span>
          </div>
          <span className="track" aria-hidden>
            <span className="fill" style={{ width: `${Math.max(s.count > 0 ? 1 : 0, (s.count / top) * 100)}%`, ['--b-dot' as string]: TONE_DOT[s.tone ?? 'info'] }} />
          </span>
          {s.note ? <span className="funnel__note">{s.note}</span> : null}
        </li>
      ))}
    </ol>
  );
}

/** Horizontal bar list (HTML) — each row reads as "label, value" for assistive tech. */
export function BarList({ items, label, max, className }: { items: BarItem[]; label: string; max?: number; className?: string }) {
  const top = max ?? Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className={cx('bars', className)} aria-label={label}>
      {items.map((i) => (
        <li key={i.key}>
          <span className="truncate">
            {i.label}
            {i.sub ? <span className="cell-sub">{i.sub}</span> : null}
          </span>
          <span className="track" aria-hidden>
            <span className="fill" style={{ width: `${Math.max(i.value > 0 ? 1.5 : 0, (i.value / top) * 100)}%`, ['--b-dot' as string]: TONE_DOT[i.tone ?? 'info'] }} />
          </span>
          <span className="val">{i.display ?? i.value}</span>
        </li>
      ))}
    </ul>
  );
}
