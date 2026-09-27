/**
 * KPI tile: value + unit formatting, the metric `definition` in an accessible tooltip (button + aria-describedby)
 * and the `dataQuality` note rendered next to the number whenever the API marks the sample empty/small
 * (docs/api/admin.md: "the UI must show it next to the number").
 */
import type { ReactNode } from 'react';
import { formatMetric, formatNumber } from '../lib/format';
import { Sparkline } from './charts';
import { Icon } from './Icon';
import { InfoTip, cx } from './ui';

export interface KpiMetric {
  key?: string;
  label: string;
  value: number | null;
  unit: string;
  definition: string;
  sampleSize: number | null;
  dataQuality: string | null;
}

export function KpiTile({ metric, spark, footer }: { metric: KpiMetric; spark?: number[]; footer?: ReactNode }) {
  const formatted = formatMetric(metric.value, metric.unit);
  return (
    <article className="card kpi" aria-label={`${metric.label}: ${formatted}`} data-testid={`kpi-${metric.key ?? metric.label}`}>
      <div className="kpi__label">
        <span>{metric.label}</span>
        <InfoTip label={`Definisi ${metric.label}`}>{metric.definition}</InfoTip>
      </div>
      <div className={cx('kpi__value', metric.unit === 'IDR' && 'kpi__value--idr')}>{formatted}</div>
      {metric.dataQuality ? (
        <div className="kpi__quality" role="note">
          <Icon name="alert" size={12} />
          <span>{metric.dataQuality}</span>
        </div>
      ) : null}
      <div className="kpi__meta">
        <span>{metric.sampleSize !== null ? `n = ${formatNumber(metric.sampleSize)}` : 'snapshot'}</span>
        {spark && spark.length > 1 ? <Sparkline values={spark} label={`Tren ${metric.label}`} /> : footer}
      </div>
    </article>
  );
}
