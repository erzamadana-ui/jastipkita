/**
 * Admin · Trip verification (§15.1): queue of VERIFICATION_PENDING trips, detail with the uploaded travel
 * document (TRIP_DOC — envelope-encrypted, streamed by GET /v1/files/{id}/content, view audited by identity),
 * approve → transition_trip(VERIFIED, ADMIN) + `trip.verified` (identity recomputes level 4, engagement notifies),
 * reject → transition_trip(DRAFT, ADMIN) with reason.
 */
import { tripFsm } from '@jastipkita/core';
import type { Db } from '../../../db/sql';
import { AppError, Errors } from '../../../lib/errors';
import { emitEvent } from '../../../services/outbox';
import { type AdminCtx, adminAudit, decodeKey, encodeKey, inAdminTx, iso, maskName } from '../common';

interface TripRow {
  id: string;
  traveler_id: string;
  origin_country: string;
  origin_city: string;
  destination_country: string;
  destination_city: string;
  departure_date: string;
  arrival_date: string;
  capacity_kg: string;
  status: string;
  version: number;
  verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
  display_name?: string | null;
  kyc_level?: number;
}

function tripDto(t: TripRow) {
  return {
    id: t.id,
    travelerId: t.traveler_id,
    travelerDisplayName: maskName(t.display_name ?? null),
    travelerKycLevel: t.kyc_level ?? null,
    route: { originCountry: t.origin_country, originCity: t.origin_city, destinationCountry: t.destination_country, destinationCity: t.destination_city },
    departureDate: t.departure_date,
    arrivalDate: t.arrival_date,
    capacityKg: Number(t.capacity_kg),
    status: t.status,
    version: t.version,
    verifiedAt: iso(t.verified_at),
    createdAt: iso(t.created_at)!,
    updatedAt: iso(t.updated_at)!,
  };
}

export async function verificationQueue(ctx: AdminCtx, q: { limit: number; cursor?: string | undefined }) {
  const db = ctx.deps.sql;
  const cursor = decodeKey(q.cursor);
  const r = await db<(TripRow & { submitted_at: Date; docs: number })[]>`
    SELECT t.id, t.traveler_id, t.origin_country, t.origin_city, t.destination_country, t.destination_city,
           t.departure_date::text AS departure_date, t.arrival_date::text AS arrival_date, t.capacity_kg::text AS capacity_kg,
           t.status, t.version, t.verified_at, t.created_at, t.updated_at, u.display_name, u.kyc_level,
           min(v.created_at) AS submitted_at, count(v.id)::int AS docs
      FROM trips t JOIN users u ON u.id = t.traveler_id
      JOIN trip_verifications v ON v.trip_id = t.id AND v.status = 'PENDING'
     WHERE t.status = 'VERIFICATION_PENDING'
     GROUP BY t.id, u.display_name, u.kyc_level
    HAVING ${cursor ? db`(min(v.created_at), t.id) > (${cursor.t}::timestamptz, ${cursor.id}::uuid)` : db`true`}
     ORDER BY min(v.created_at), t.id LIMIT ${q.limit + 1}`;
  const now = ctx.deps.clock.now();
  const more = r.length > q.limit;
  const data = r.slice(0, q.limit);
  const last = data[data.length - 1];
  return {
    data: data.map((t) => ({ ...tripDto(t), pendingDocuments: t.docs, submittedAt: iso(t.submitted_at)!, waitingHours: Math.round(((now.getTime() - t.submitted_at.getTime()) / 3600_000) * 10) / 10 })),
    nextCursor: more && last ? encodeKey({ t: last.submitted_at.toISOString(), id: last.id }) : null,
  };
}

const TRIP_COLS = (db: Db) => db`t.id, t.traveler_id, t.origin_country, t.origin_city, t.destination_country, t.destination_city,
  t.departure_date::text AS departure_date, t.arrival_date::text AS arrival_date, t.capacity_kg::text AS capacity_kg,
  t.status, t.version, t.verified_at, t.created_at, t.updated_at`;

async function loadTrip(db: Db, id: string, forUpdate = false): Promise<TripRow> {
  const [t] = forUpdate
    ? await db<TripRow[]>`SELECT ${TRIP_COLS(db)} FROM trips t WHERE t.id = ${id} FOR UPDATE`
    : await db<TripRow[]>`SELECT ${TRIP_COLS(db)}, u.display_name, u.kyc_level FROM trips t JOIN users u ON u.id = t.traveler_id WHERE t.id = ${id}`;
  if (!t) throw Errors.notFound('Trip', 'TRIP_NOT_FOUND');
  return t;
}

export async function tripDetail(ctx: AdminCtx, id: string) {
  const db = ctx.deps.sql;
  const t = await loadTrip(db, id);
  const docs = await db<{ id: string; doc_type: string; file_id: string | null; flight_number: string | null; flight_date: string | null; extracted: unknown; status: string; reviewed_by: string | null; reviewed_at: Date | null; notes: string | null; created_at: Date; mime: string | null }[]>`
    SELECT v.id, v.doc_type, v.file_id, v.flight_number, v.flight_date::text AS flight_date, v.extracted, v.status, v.reviewed_by, v.reviewed_at, v.notes, v.created_at, f.mime
      FROM trip_verifications v LEFT JOIN files f ON f.id = v.file_id WHERE v.trip_id = ${id} ORDER BY v.created_at, v.id`;
  const events = await db<{ from_status: string | null; to_status: string; actor_type: string; reason: string | null; created_at: Date }[]>`
    SELECT from_status, to_status, actor_type, reason, created_at FROM trip_events WHERE trip_id = ${id} ORDER BY id`;
  return {
    ...tripDto(t),
    documents: docs.map((d) => ({
      id: d.id,
      docType: d.doc_type,
      fileId: d.file_id,
      mime: d.mime,
      flightNumber: d.flight_number,
      flightDate: d.flight_date,
      extracted: d.extracted,
      status: d.status,
      reviewedBy: d.reviewed_by,
      reviewedAt: iso(d.reviewed_at),
      notes: d.notes,
      createdAt: iso(d.created_at)!,
      content: d.file_id ? { url: `${ctx.deps.env.API_BASE_URL}/v1/files/${d.file_id}/content`, method: 'GET', requiresAuth: true, audited: true } : null,
    })),
    timeline: events.map((e) => ({ from: e.from_status, to: e.to_status, actorType: e.actor_type, reason: e.reason, at: iso(e.created_at)! })),
    allowedActions: t.status === 'VERIFICATION_PENDING' ? ['APPROVE', 'REJECT'] : [],
  };
}

export async function approveTrip(ctx: AdminCtx, id: string, note?: string) {
  const now = ctx.deps.clock.now();
  const out = await inAdminTx(ctx, async (tx) => {
    const t = await loadTrip(tx, id, true);
    if (t.traveler_id === ctx.auth.userId) throw Errors.forbidden('Tidak dapat memverifikasi trip sendiri', 'MAKER_CHECKER_VIOLATION');
    if (t.status !== 'VERIFICATION_PENDING') throw Errors.unprocessable('TRIP_NOT_PENDING_VERIFICATION', 'Trip tidak menunggu verifikasi', { status: t.status });
    const pending = await tx<{ id: string }[]>`SELECT id FROM trip_verifications WHERE trip_id = ${id} AND status = 'PENDING' FOR UPDATE`;
    if (!pending.length) throw Errors.unprocessable('TRIP_DOCUMENT_MISSING', 'Tidak ada dokumen perjalanan yang menunggu verifikasi');
    const check = tripFsm.canTransition('VERIFICATION_PENDING', 'VERIFIED', 'ADMIN', { travelDocumentVerified: true });
    if (!check.ok) throw new AppError(422, check.code, check.message);
    await tx`UPDATE trip_verifications SET status = 'APPROVED', reviewed_by = ${ctx.auth.userId}, reviewed_at = ${now}, notes = ${note ?? null}
              WHERE trip_id = ${id} AND status = 'PENDING'`;
    const [row] = await tx<{ version: number; status: string }[]>`
      SELECT version, status FROM transition_trip(${id}, ${t.version}, 'VERIFIED', 'ADMIN', ${ctx.auth.userId}, ${note ?? 'documents approved'}, ${tx.json({ verificationIds: pending.map((p) => p.id) } as never)}::jsonb)`;
    await emitEvent(tx, 'trip', id, 'trip.verified', { tripId: id, travelerId: t.traveler_id, verifiedBy: 'ADMIN' });
    await adminAudit(tx, ctx, { action: 'trips.verified', entityType: 'trip', entityId: id, before: { status: t.status }, after: { status: 'VERIFIED' }, meta: { travelerId: t.traveler_id, verificationIds: pending.map((p) => p.id), note: note ?? null } });
    return row!;
  });
  return { id, status: out.status, version: out.version };
}

export async function rejectTrip(ctx: AdminCtx, id: string, reason: string) {
  const now = ctx.deps.clock.now();
  const out = await inAdminTx(ctx, async (tx) => {
    const t = await loadTrip(tx, id, true);
    if (t.status !== 'VERIFICATION_PENDING') throw Errors.unprocessable('TRIP_NOT_PENDING_VERIFICATION', 'Trip tidak menunggu verifikasi', { status: t.status });
    const check = tripFsm.canTransition('VERIFICATION_PENDING', 'DRAFT', 'ADMIN', {});
    if (!check.ok) throw new AppError(422, check.code, check.message);
    await tx`UPDATE trip_verifications SET status = 'REJECTED', reviewed_by = ${ctx.auth.userId}, reviewed_at = ${now}, notes = ${reason}
              WHERE trip_id = ${id} AND status = 'PENDING'`;
    const [row] = await tx<{ version: number; status: string }[]>`
      SELECT version, status FROM transition_trip(${id}, ${t.version}, 'DRAFT', 'ADMIN', ${ctx.auth.userId}, ${reason}, '{}'::jsonb)`;
    await adminAudit(tx, ctx, { action: 'trips.verification_rejected', entityType: 'trip', entityId: id, before: { status: t.status }, after: { status: 'DRAFT' }, meta: { travelerId: t.traveler_id, reason } });
    return row!;
  });
  return { id, status: out.status, version: out.version };
}
