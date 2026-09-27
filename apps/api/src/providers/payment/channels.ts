/**
 * Payment-channel policy shared by the money services and the Xendit adapter.
 * Source: docs/research/02-xendit-integration.md §1.3 (limits) and §4 (refund support), verified 2026-09-27.
 * Items marked NEEDS_VERIFICATION there are treated conservatively here.
 */

/** Channel groups used by quotes (`pricing.payment_fees.channels`) and the `payments.channel` column. */
export type ChannelGroup = 'VA' | 'QRIS' | 'EWALLET' | 'CARD' | 'RETAIL' | 'MOCK';

export const PAYMENT_CHANNELS: readonly ChannelGroup[] = ['VA', 'QRIS', 'EWALLET', 'CARD', 'RETAIL', 'MOCK'];

/** Per-transaction nominal limits (IDR). QRIS ≤ Rp10.000.000; BCA VA Rp10.000–Rp50.000.000. */
export const CHANNEL_LIMITS: Readonly<Record<string, { minIdr: number; maxIdr: number }>> = {
  QRIS: { minIdr: 1, maxIdr: 10_000_000 },
  VA: { minIdr: 10_000, maxIdr: 50_000_000 },
  EWALLET: { minIdr: 1, maxIdr: 10_000_000 }, // NEEDS_VERIFICATION: per-wallet caps differ; conservative
  CARD: { minIdr: 5_000, maxIdr: 200_000_000 }, // NEEDS_VERIFICATION
};

/**
 * Whether the provider can refund a payment captured on `channel`. VA, retail outlets (Alfamart/Indomaret)
 * and AstraPay cannot be refunded by Xendit → the refund must be disbursed (payout) to a buyer bank account.
 * Unknown channel → false (fail closed: payout path always works).
 */
export function channelSupportsProviderRefund(channel: string | null | undefined): boolean {
  switch (channel) {
    case 'QRIS':
    case 'EWALLET':
    case 'CARD':
    case 'MOCK':
      return true;
    default:
      return false;
  }
}

export function normalizeChannel(raw: string | null | undefined): ChannelGroup | null {
  if (!raw) return null;
  const v = raw.toUpperCase();
  if ((PAYMENT_CHANNELS as readonly string[]).includes(v)) return v as ChannelGroup;
  if (v.endsWith('_VIRTUAL_ACCOUNT') || v.includes('VIRTUAL_ACCOUNT') || v === 'VIRTUAL_ACCOUNT') return 'VA';
  if (v === 'QR_CODE' || v.startsWith('QRIS')) return 'QRIS';
  if (['OVO', 'DANA', 'SHOPEEPAY', 'GOPAY', 'LINKAJA', 'ASTRAPAY', 'EWALLET', 'E_WALLET'].includes(v)) return 'EWALLET';
  if (v === 'CARDS' || v === 'CREDIT_CARD' || v === 'DEBIT_CARD') return 'CARD';
  if (v === 'ALFAMART' || v === 'INDOMARET' || v === 'RETAIL_OUTLET') return 'RETAIL';
  return null;
}
