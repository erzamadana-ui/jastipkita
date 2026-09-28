import { describe, expect, it } from 'vitest';
import type { DisputeDetail } from '../../api/types';
import { resolutionPreview } from './DisputeDetailPage';

const detail = (tx: Partial<DisputeDetail['transaction']>) =>
  ({ transaction: { id: 't', number: 'JK-1', status: 'DISPUTED', preDisputeStatus: 'DELIVERED', escrowHeldIdr: 1_000_000, ...tx } }) as DisputeDetail;

describe('dispute resolution money preview', () => {
  it('REFUND_FULL refunds the server cap, not more than what payments can still refund', () => {
    expect(resolutionPreview(detail({ refundableIdr: 800_000 }), 'REFUND_FULL', 0)).toMatchObject({ toBuyer: 800_000, toTraveler: 0, remainsHeld: 200_000 });
    expect(resolutionPreview(detail({}), 'REFUND_FULL', 0)).toMatchObject({ toBuyer: 1_000_000, remainsHeld: 0 }); // older API: escrow held
  });

  it('REFUND_PARTIAL is clamped to the cap; remainder is released to the traveler', () => {
    expect(resolutionPreview(detail({ refundableIdr: 800_000 }), 'REFUND_PARTIAL', 300_000)).toMatchObject({ toBuyer: 300_000, toTraveler: 700_000 });
    expect(resolutionPreview(detail({ refundableIdr: 800_000 }), 'REFUND_PARTIAL', 5_000_000).toBuyer).toBe(800_000);
  });

  it('NO_REFUND before delivery needs an explicit release confirmation; nothing executes once no longer DISPUTED', () => {
    expect(resolutionPreview(detail({ preDisputeStatus: 'PURCHASED' }), 'NO_REFUND', 0)).toMatchObject({ toTraveler: 1_000_000, needsReleaseConfirm: true });
    expect(resolutionPreview(detail({ status: 'REFUNDED' }), 'REFUND_FULL', 0)).toMatchObject({ executes: false, toBuyer: 0 });
  });
});
