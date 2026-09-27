import { tripFsm } from '@jastipkita/core';
import type { AppDeps } from '../context';
import { AppError } from '../lib/errors';
import { emitEvent } from '../services/outbox';
import { tx, wibDate } from '../modules/catalog/shared';
import { refreshFxRates } from '../modules/fx/service';
import { closePendingOffers } from '../modules/offers/lifecycle';
import * as reqRepo from '../modules/requests/repository';
import * as tripRepo from '../modules/trips/repository';
import { releaseTripCapacity } from '../modules/trips/service';
import type { JobGroup, OutboxEvent } from './types';

const BATCH = 200;

/** Hourly: provider snapshot → fx_rates (append-only, idempotent per as_of). */
export async function runFxRefresh(deps: AppDeps) {
  return refreshFxRates(deps.sql, deps);
}

/** PENDING offers past expires_at → EXPIRED (+ offer.expired). */
export async function expireOffers(deps: AppDeps) {
  const now = deps.clock.now();
  let expired = 0;
  for (let i = 0; i < 20; i++) {
    const n = await tx(deps.sql, async (t) => {
      const ids = await t<{ id: string }[]>`
        SELECT id FROM offers WHERE status = 'PENDING' AND expires_at <= ${now} ORDER BY expires_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`;
      const closed = await closePendingOffers(t, { offerIds: ids.map((r) => r.id) }, 'EXPIRED', 'OFFER_EXPIRED', now);
      return closed.length;
    });
    expired += n;
    if (n < BATCH) break;
  }
  return { expired };
}

/** DRAFT/OPEN requests past expires_at or needed_by → EXPIRED; their pending offers expire too. */
export async function expireRequests(deps: AppDeps) {
  const now = deps.clock.now();
  const today = wibDate(now);
  let expired = 0;
  for (let i = 0; i < 20; i++) {
    const n = await tx(deps.sql, async (t) => {
      const rows = await t<{ id: string; buyer_id: string; status: string }[]>`
        SELECT id, buyer_id, status FROM requests
         WHERE status IN ('DRAFT','OPEN')
           AND ((status = 'OPEN' AND expires_at <= ${now}) OR needed_by < ${today}::date)
         ORDER BY id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`;
      for (const r of rows) {
        await closePendingOffers(t, { requestId: r.id }, 'EXPIRED', 'REQUEST_EXPIRED', now);
        await reqRepo.setStatus(t, r.id, 'EXPIRED', now);
        await emitEvent(t, 'request', r.id, 'request.expired', { requestId: r.id, buyerId: r.buyer_id, previousStatus: r.status });
      }
      return rows.length;
    });
    expired += n;
    if (n < BATCH) break;
  }
  return { expired };
}

function isRetryable(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return code === 'JK409' || code === '40001' || code === '40P01' || (err instanceof AppError && err.code === 'VERSION_CONFLICT');
}

/**
 * Trip automation (SYSTEM actor, core tripFsm guards, transition_trip):
 *  - ACTIVE/FULL whose departure date (WIB) has come → TRAVELING; pending offers expire
 *  - TRAVELING whose arrival date has passed and whose transactions are all terminal → COMPLETED
 *  - DRAFT/VERIFICATION_PENDING/VERIFIED never published before the departure date → CANCELLED
 */
export async function tripAutomation(deps: AppDeps) {
  const today = wibDate(deps.clock.now());
  const out = { traveling: 0, completed: 0, cancelledUnpublished: 0, skipped: 0 };

  const departing = await deps.sql<{ id: string }[]>`
    SELECT id FROM trips WHERE status IN ('ACTIVE','FULL') AND departure_date <= ${today}::date ORDER BY departure_date, id LIMIT ${BATCH}`;
  for (const { id } of departing) {
    try {
      await tx(deps.sql, async (t) => {
        await t`SELECT id FROM offers WHERE trip_id = ${id} AND status = 'PENDING' ORDER BY id FOR UPDATE`;
        const trip = await tripRepo.getTrip(t, id, { forUpdate: true });
        if (!trip || (trip.status !== 'ACTIVE' && trip.status !== 'FULL')) return;
        if (!tripFsm.canTransition(trip.status, 'TRAVELING', 'SYSTEM', {}).ok) return;
        await tripRepo.transitionTrip(t, trip, 'TRAVELING', 'SYSTEM', null, 'departure date reached', { departureDate: trip.departure_date });
        await closePendingOffers(t, { tripId: trip.id }, 'EXPIRED', 'TRIP_DEPARTED', deps.clock.now());
        out.traveling++;
      });
    } catch (err) {
      if (!isRetryable(err)) throw err;
      out.skipped++;
    }
  }

  const arrived = await deps.sql<{ id: string }[]>`
    SELECT t.id FROM trips t
     WHERE t.status = 'TRAVELING' AND t.arrival_date < ${today}::date
       AND NOT EXISTS (SELECT 1 FROM transactions x WHERE x.trip_id = t.id AND x.status NOT IN ('COMPLETED','CANCELLED','REFUNDED'))
     ORDER BY t.arrival_date, t.id LIMIT ${BATCH}`;
  for (const { id } of arrived) {
    try {
      await tx(deps.sql, async (t) => {
        const trip = await tripRepo.getTrip(t, id, { forUpdate: true });
        if (!trip || trip.status !== 'TRAVELING') return;
        if ((await tripRepo.openTransactionIds(t, id)).length > 0) return;
        if (!tripFsm.canTransition('TRAVELING', 'COMPLETED', 'SYSTEM', {}).ok) return;
        await tripRepo.transitionTrip(t, trip, 'COMPLETED', 'SYSTEM', null, 'arrived and all transactions settled', { arrivalDate: trip.arrival_date });
        out.completed++;
      });
    } catch (err) {
      if (!isRetryable(err)) throw err;
      out.skipped++;
    }
  }

  const stale = await deps.sql<{ id: string }[]>`
    SELECT id FROM trips WHERE status IN ('DRAFT','VERIFICATION_PENDING','VERIFIED') AND departure_date < ${today}::date
     ORDER BY departure_date, id LIMIT ${BATCH}`;
  for (const { id } of stale) {
    try {
      await tx(deps.sql, async (t) => {
        const trip = await tripRepo.getTrip(t, id, { forUpdate: true });
        if (!trip || !['DRAFT', 'VERIFICATION_PENDING', 'VERIFIED'].includes(trip.status)) return;
        const reason = 'departure date passed before publishing';
        await tripRepo.transitionTrip(t, trip, 'CANCELLED', 'SYSTEM', null, reason);
        await emitEvent(t, 'trip', trip.id, 'trip.cancelled', { tripId: trip.id, travelerId: trip.traveler_id, actorType: 'SYSTEM', reason, openTransactionIds: [] });
        out.cancelledUnpublished++;
      });
    } catch (err) {
      if (!isRetryable(err)) throw err;
      out.skipped++;
    }
  }
  return out;
}

/**
 * transaction.status_changed consumer (idempotent):
 *  - CANCELLED / REFUNDED → release the trip capacity reservation (FULL → ACTIVE when space returns)
 *  - CANCELLED → request back to OPEN (or EXPIRED when past its deadline) so it can be re-matched
 *  - REFUNDED / COMPLETED → request CLOSED
 */
export async function onTransactionStatusChanged(deps: AppDeps, event: OutboxEvent): Promise<void> {
  const p = event.payload as { transactionId?: string; to?: string };
  if (!p.transactionId || !p.to || !['CANCELLED', 'REFUNDED', 'COMPLETED'].includes(p.to)) return;
  const to = p.to;
  const transactionId = p.transactionId;
  await tx(deps.sql, async (t) => {
    const [txRow] = await t<{ request_id: string; status: string }[]>`SELECT request_id, status FROM transactions WHERE id = ${transactionId}`;
    if (!txRow) return;
    if (to === 'CANCELLED' || to === 'REFUNDED') {
      await releaseTripCapacity(t, deps, { transactionId, reason: `transaction ${to}` });
    }
    const r = await reqRepo.getRequest(t, txRow.request_id, { forUpdate: true });
    if (!r || r.status !== 'MATCHED') return;
    const [live] = await t<{ n: number }[]>`
      SELECT count(*)::int AS n FROM transactions WHERE request_id = ${r.id} AND status NOT IN ('CANCELLED','REFUNDED','COMPLETED')`;
    if ((live?.n ?? 0) > 0) return;
    const now = deps.clock.now();
    if (to === 'CANCELLED') {
      const today = wibDate(now);
      const stillValid = (!r.expires_at || r.expires_at > now) && (!r.needed_by || r.needed_by >= today);
      await reqRepo.setStatus(t, r.id, stillValid ? 'OPEN' : 'EXPIRED', now);
      await emitEvent(t, 'request', r.id, stillValid ? 'request.reopened' : 'request.expired', {
        requestId: r.id,
        buyerId: r.buyer_id,
        transactionId,
      });
    } else {
      await reqRepo.setStatus(t, r.id, 'CLOSED', now);
    }
  });
}

/** Background jobs for the "marketplace" module group. OWNED by the marketplace agent/team. */
export const marketplaceJobs: JobGroup = {
  outbox: {
    'transaction.status_changed': [onTransactionStatusChanged],
  },
  scheduled: [
    { name: 'marketplace.fx_refresh', everySec: 3600, run: runFxRefresh },
    { name: 'marketplace.expire_offers', everySec: 300, run: expireOffers },
    { name: 'marketplace.expire_requests', everySec: 900, run: expireRequests },
    { name: 'marketplace.trip_automation', everySec: 900, run: tripAutomation },
  ],
  queues: {},
};

