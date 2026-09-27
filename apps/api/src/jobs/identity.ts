import type { AppDeps } from '../context';
import { recomputeKycLevel } from '../modules/kyc/level';
import { EXPORT_QUEUE, finalizeDueDeletions, runExport } from '../modules/privacy/service';
import { purgeExpiredOtpAndIdempotency, retentionPurge } from '../modules/privacy/retention';
import type { JobGroup, OutboxEvent } from './types';

/**
 * Background jobs for the "identity" module group. OWNED by the identity agent/team.
 * Outbox consumers are idempotent: level recomputation only raises the level and emits nothing when unchanged.
 */
async function recomputeFor(deps: AppDeps, userId: unknown, trigger: string) {
  if (typeof userId !== 'string' || !/^[0-9a-f-]{36}$/i.test(userId)) return;
  await deps.sql.begin((tx) => recomputeKycLevel(deps, tx, userId, trigger));
}

export const identityJobs: JobGroup = {
  outbox: {
    // level 4 = level 3 + verified payout account + ≥ 1 trip that reached VERIFIED
    'trip.verified': [(deps, e: OutboxEvent) => recomputeFor(deps, e.payload.travelerId, `trip.verified:${e.eventId}`)],
    // transition_trip() emits trip.status_changed; admin/system may not emit trip.verified separately
    'trip.status_changed': [
      async (deps, e: OutboxEvent) => {
        if (e.payload.to === 'VERIFIED') await recomputeFor(deps, e.payload.travelerId, `trip.status_changed:${e.eventId}`);
      },
    ],
    'payout_account.verified': [(deps, e: OutboxEvent) => recomputeFor(deps, e.payload.userId, `payout_account.verified:${e.eventId}`)],
  },
  scheduled: [
    { name: 'identity.privacy.finalize_deletions', everySec: 3600, run: (deps) => finalizeDueDeletions(deps) },
    { name: 'identity.auth.purge_otp_idempotency', everySec: 3600, run: (deps) => purgeExpiredOtpAndIdempotency(deps) },
    { name: 'identity.privacy.retention_purge', everySec: 86400, run: (deps) => retentionPurge(deps) },
  ],
  queues: {
    [EXPORT_QUEUE]: async (deps, payload) => {
      if (typeof payload.requestId !== 'string') throw new Error('privacy export job without requestId');
      return runExport(deps, payload.requestId);
    },
  },
};
