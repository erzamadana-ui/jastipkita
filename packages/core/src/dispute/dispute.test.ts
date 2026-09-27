import { describe, expect, it } from 'vitest';
import { DEFAULT_BUSINESS_CONFIG } from '../config';
import { appealDeadline, canOpenDispute, computeSla, slaBreach, validateDisputeResolution } from './index';

const SLA = DEFAULT_BUSINESS_CONFIG['dispute.sla'];
const T0 = new Date('2026-09-27T00:00:00Z');

describe('computeSla', () => {
  it('derives evidence and review deadlines (72h + 120h)', () => {
    const s = computeSla(T0, SLA);
    expect(s.evidenceDueAt.toISOString()).toBe('2026-09-30T00:00:00.000Z');
    expect(s.reviewDueAt.toISOString()).toBe('2026-10-05T00:00:00.000Z');
    expect(appealDeadline(T0, SLA).toISOString()).toBe('2026-09-30T00:00:00.000Z');
  });

  it('detects SLA breaches by status', () => {
    const s = computeSla(T0, SLA);
    expect(slaBreach('EVIDENCE_COLLECTION', s, new Date('2026-09-30T00:00:01Z'))).toBe('EVIDENCE_OVERDUE');
    expect(slaBreach('UNDER_REVIEW', s, new Date('2026-10-05T00:00:01Z'))).toBe('REVIEW_OVERDUE');
    expect(slaBreach('RESOLVED', s, new Date('2026-12-01T00:00:00Z'))).toBeNull();
  });
});

describe('canOpenDispute', () => {
  it('allows any time before delivery for disputable statuses', () => {
    expect(canOpenDispute('TRAVELING', null, T0, SLA)).toEqual({ ok: true, windowClosesAt: null });
  });

  it('enforces the 72h window after delivery', () => {
    const delivered = new Date('2026-09-27T00:00:00Z');
    expect(canOpenDispute('DELIVERED', delivered, new Date('2026-09-30T00:00:00Z'), SLA).ok).toBe(true);
    const late = canOpenDispute('DELIVERED', delivered, new Date('2026-09-30T00:00:01Z'), SLA);
    expect(late.ok ? '' : late.code).toBe('DISPUTE_WINDOW_CLOSED');
  });

  it('rejects non-disputable statuses', () => {
    for (const s of ['PAYMENT_SECURED', 'BUYER_CONFIRMED', 'COMPLETED'] as const) {
      const r = canOpenDispute(s, null, T0, SLA);
      expect(r.ok ? '' : r.code).toBe('STATUS_NOT_DISPUTABLE');
    }
  });
});

describe('validateDisputeResolution', () => {
  it('full refund must equal the refundable remainder', () => {
    expect(validateDisputeResolution({ resolution: 'REFUND_FULL', refundIdr: 1_000_000, capturedIdr: 1_000_000 }).ok).toBe(true);
    const r = validateDisputeResolution({ resolution: 'REFUND_FULL', refundIdr: 900_000, capturedIdr: 1_000_000 });
    expect(r.errors.map((e) => e.code)).toContain('FULL_REFUND_AMOUNT');
  });

  it('refund can never exceed captured minus already refunded', () => {
    const r = validateDisputeResolution({
      resolution: 'REFUND_PARTIAL',
      refundIdr: 600_000,
      capturedIdr: 1_000_000,
      alreadyRefundedIdr: 500_000,
    });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain('REFUND_EXCEEDS_CAPTURED');
    expect(r.refundableIdr).toBe(500_000);
  });

  it('NO_REFUND goes to BUYER_CONFIRMED; partial goes to REFUND_PENDING', () => {
    expect(validateDisputeResolution({ resolution: 'NO_REFUND', refundIdr: 0, capturedIdr: 10 }).nextTransactionStatus).toBe(
      'BUYER_CONFIRMED',
    );
    const p = validateDisputeResolution({ resolution: 'REFUND_PARTIAL', refundIdr: 5, capturedIdr: 10 });
    expect(p.ok).toBe(true);
    expect(p.nextTransactionStatus).toBe('REFUND_PENDING');
    expect(validateDisputeResolution({ resolution: 'NO_REFUND', refundIdr: 1, capturedIdr: 10 }).ok).toBe(false);
  });
});
