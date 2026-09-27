/**
 * 11-line price breakdown (docs/00-domain-model.md §10, docs/05 §5.5): fixed order, groups (goods & customs /
 * JastipKita services / deductions / total), "Estimasi" badge on estimated lines, rule/config reference + ledger
 * bucket for every line. Opaque card (never glass).
 */
import type { PriceLine, Quote } from '../api/types';
import { formatBps, formatDateTime, formatDecimalString } from '../lib/format';
import { InfoTip, Money } from './ui';

const ORDER: PriceLine['type'][] = ['ITEM_PRICE', 'TRAVELER_FEE', 'CUSTOMS_DUTY', 'IMPORT_TAX', 'PROTECTION_FEE', 'PLATFORM_FEE', 'SERVICE_TAX', 'PAYMENT_FEE', 'DISCOUNT', 'REFERRAL_CREDIT', 'TOTAL'];
const GROUP_START = new Set<PriceLine['type']>(['PROTECTION_FEE', 'DISCOUNT']);

export function PriceBreakdown({ quote }: { quote: NonNullable<Quote> }) {
  const fx = quote.fx;
  const lines = [...quote.lines].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
  return (
    <div className="stack stack--sm">
      <table className="breakdown" aria-label="Rincian harga 11 baris">
        <tbody>
          {lines.map((l) => {
            const n = ORDER.indexOf(l.type) + 1;
            const total = l.type === 'TOTAL';
            return (
              <tr key={l.type} className={total ? 'total' : GROUP_START.has(l.type) ? 'group-start' : undefined} data-line={l.type}>
                <td className="line-no">{n}</td>
                <td>
                  <span className="row row--tight">
                    {l.labelId}
                    {l.isEstimate ? <span className="estimate">Estimasi</span> : null}
                    {l.ruleRef ? (
                      <InfoTip label={`Sumber aturan ${l.labelId}`}>
                        Aturan <code>{l.ruleRef}</code>
                        {l.isEstimate ? ' — Estimasi, nilai final ditetapkan Bea Cukai.' : ''}
                      </InfoTip>
                    ) : null}
                  </span>
                  <span className="sub">
                    <code>{l.type}</code>
                    {l.bucket ? ` · bucket ${l.bucket}` : ''}
                    {l.originalAmountIdr !== undefined && l.originalAmountIdr !== l.amountIdr ? ` · semula ${l.originalAmountIdr}` : ''}
                  </span>
                </td>
                <td>
                  <Money value={l.amountIdr} emphasize={total} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="small muted">
        {fx ? `Kurs terkunci 1 ${fx.base} = ${formatDecimalString(String(fx.lockedRate))} ${fx.quote} (spot ${formatDecimalString(String(fx.spotRate))} + markup ${formatBps(fx.markupBps)}) · ${formatDateTime(fx.lockedAt)} · ` : 'Tanpa konversi kurs · '}quote {quote.status} · kanal {quote.paymentChannel}
      </p>
    </div>
  );
}
