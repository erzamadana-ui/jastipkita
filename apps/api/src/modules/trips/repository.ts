import type { Db } from '../../db/sql';

export type TripStatus = 'DRAFT' | 'VERIFICATION_PENDING' | 'VERIFIED' | 'ACTIVE' | 'FULL' | 'TRAVELING' | 'COMPLETED' | 'CANCELLED';
export type FeeType = 'FIXED' | 'PERCENT' | 'PER_KG';

export interface TripRow {
  id: string;
  traveler_id: string;
  origin_country: string;
  origin_city: string;
  destination_country: string;
  destination_city: string;
  departure_date: string;
  arrival_date: string;
  return_date: string | null;
  capacity_kg: string;
  reserved_kg: string;
  max_items: number | null;
  reserved_items: number;
  fee_type: FeeType;
  fee_value: number;
  excluded_categories: string[];
  notes: string | null;
  status: TripStatus;
  verified_at: Date | null;
  published_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  cancelled_reason: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export const tripCols = (db: Db) => db`
  t.id, t.traveler_id, t.origin_country, t.origin_city, t.destination_country, t.destination_city,
  t.departure_date::text AS departure_date, t.arrival_date::text AS arrival_date, t.return_date::text AS return_date,
  t.capacity_kg::text AS capacity_kg, t.reserved_kg::text AS reserved_kg, t.max_items, t.reserved_items,
  t.fee_type, t.fee_value, t.excluded_categories, t.notes, t.status, t.verified_at, t.published_at, t.completed_at,
  t.cancelled_at, t.cancelled_reason, t.version, t.created_at, t.updated_at`;

export async function getTrip(db: Db, id: string, opts: { forUpdate?: boolean } = {}): Promise<TripRow | null> {
  const [row] = opts.forUpdate
    ? await db<TripRow[]>`SELECT ${tripCols(db)} FROM trips t WHERE t.id = ${id} FOR UPDATE`
    : await db<TripRow[]>`SELECT ${tripCols(db)} FROM trips t WHERE t.id = ${id}`;
  return row ?? null;
}

export interface NewTrip {
  travelerId: string;
  originCountry: string;
  originCity: string;
  destinationCountry: string;
  destinationCity: string;
  departureDate: string;
  arrivalDate: string;
  returnDate: string | null;
  capacityKg: number;
  maxItems: number | null;
  feeType: FeeType;
  feeValue: number;
  excludedCategories: string[];
  notes: string | null;
}

export async function insertTrip(db: Db, t: NewTrip): Promise<TripRow> {
  const [row] = await db<{ id: string }[]>`
    INSERT INTO trips (traveler_id, origin_country, origin_city, destination_country, destination_city, departure_date,
                       arrival_date, return_date, capacity_kg, max_items, fee_type, fee_value, excluded_categories, notes)
    VALUES (${t.travelerId}, ${t.originCountry}, ${t.originCity}, ${t.destinationCountry}, ${t.destinationCity},
            ${t.departureDate}::date, ${t.arrivalDate}::date, ${t.returnDate}::date, ${t.capacityKg}, ${t.maxItems},
            ${t.feeType}, ${t.feeValue}, ${t.excludedCategories}::text[], ${t.notes})
    RETURNING id`;
  return (await getTrip(db, row!.id))!;
}

export async function countLiveTrips(db: Db, travelerId: string): Promise<number> {
  const [row] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM trips WHERE traveler_id = ${travelerId} AND status NOT IN ('COMPLETED','CANCELLED')`;
  return row?.n ?? 0;
}

export async function updateTripFields(db: Db, id: string, f: Partial<NewTrip>): Promise<void> {
  await db`
    UPDATE trips SET
      origin_country      = coalesce(${f.originCountry ?? null}, origin_country),
      origin_city         = coalesce(${f.originCity ?? null}, origin_city),
      destination_country = coalesce(${f.destinationCountry ?? null}, destination_country),
      destination_city    = coalesce(${f.destinationCity ?? null}, destination_city),
      departure_date      = coalesce(${f.departureDate ?? null}::date, departure_date),
      arrival_date        = coalesce(${f.arrivalDate ?? null}::date, arrival_date),
      return_date         = CASE WHEN ${f.returnDate !== undefined} THEN ${f.returnDate ?? null}::date ELSE return_date END,
      capacity_kg         = coalesce(${f.capacityKg ?? null}::numeric, capacity_kg),
      max_items           = CASE WHEN ${f.maxItems !== undefined} THEN ${f.maxItems ?? null}::int ELSE max_items END,
      fee_type            = coalesce(${f.feeType ?? null}, fee_type),
      fee_value           = coalesce(${f.feeValue ?? null}::bigint, fee_value),
      excluded_categories = coalesce(${f.excludedCategories ?? null}::text[], excluded_categories),
      notes               = CASE WHEN ${f.notes !== undefined} THEN ${f.notes ?? null} ELSE notes END
    WHERE id = ${id}`;
}

export async function transitionTrip(
  db: Db,
  trip: Pick<TripRow, 'id' | 'version'>,
  to: TripStatus,
  actorType: 'TRAVELER' | 'SYSTEM' | 'ADMIN',
  actorId: string | null,
  reason: string | null,
  meta: Record<string, unknown> = {},
): Promise<void> {
  await db`SELECT id FROM transition_trip(${trip.id}, ${trip.version}, ${to}, ${actorType}, ${actorId}, ${reason}, ${db.json(meta as never)}::jsonb)`;
}

export interface VerificationRow {
  id: string;
  trip_id: string;
  doc_type: 'ETICKET' | 'ITINERARY' | 'BOARDING_PASS';
  file_id: string | null;
  flight_number: string | null;
  flight_date: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  reviewed_at: Date | null;
  notes: string | null;
  created_at: Date;
}

export async function listVerifications(db: Db, tripId: string): Promise<VerificationRow[]> {
  return db<VerificationRow[]>`
    SELECT id, trip_id, doc_type, file_id, flight_number, flight_date::text AS flight_date, status, reviewed_at, notes, created_at
      FROM trip_verifications WHERE trip_id = ${tripId} ORDER BY created_at, id`;
}

export async function insertVerification(
  db: Db,
  v: { tripId: string; docType: string; fileId: string; flightNumber: string | null; flightDate: string | null },
): Promise<VerificationRow> {
  const [row] = await db<VerificationRow[]>`
    INSERT INTO trip_verifications (trip_id, doc_type, file_id, flight_number, flight_date)
    VALUES (${v.tripId}, ${v.docType}, ${v.fileId}, ${v.flightNumber}, ${v.flightDate}::date)
    RETURNING id, trip_id, doc_type, file_id, flight_number, flight_date::text AS flight_date, status, reviewed_at, notes, created_at`;
  return row!;
}

export interface FileRow {
  id: string;
  owner_id: string | null;
  purpose: string;
  storage_key: string;
  scan_status: string;
  deleted_at: Date | null;
}

export async function getFile(db: Db, id: string): Promise<FileRow | null> {
  const [row] = await db<FileRow[]>`SELECT id, owner_id, purpose, storage_key, scan_status, deleted_at FROM files WHERE id = ${id}`;
  return row ?? null;
}

export async function openTransactionIds(db: Db, tripId: string): Promise<string[]> {
  const rows = await db<{ id: string }[]>`
    SELECT id FROM transactions WHERE trip_id = ${tripId} AND status NOT IN ('COMPLETED','CANCELLED','REFUNDED') ORDER BY created_at`;
  return rows.map((r) => r.id);
}

export async function unhandedTransactionIds(db: Db, tripId: string): Promise<string[]> {
  const rows = await db<{ id: string }[]>`
    SELECT id FROM transactions WHERE trip_id = ${tripId}
       AND status NOT IN ('DELIVERED','BUYER_CONFIRMED','COMPLETED','CANCELLED','REFUNDED')`;
  return rows.map((r) => r.id);
}

// --------------------------------------------------------------------------- capacity reservations

export interface ReservationRow {
  transaction_id: string;
  trip_id: string;
  kg: string;
  items: number;
  released_at: Date | null;
}

export async function insertReservation(
  db: Db,
  r: { transactionId: string; tripId: string; offerId: string | null; kg: number; items: number },
): Promise<void> {
  await db`
    INSERT INTO trip_capacity_reservations (transaction_id, trip_id, offer_id, kg, items)
    VALUES (${r.transactionId}, ${r.tripId}, ${r.offerId}, ${r.kg}, ${r.items})`;
  await db`UPDATE trips SET reserved_kg = reserved_kg + ${r.kg}::numeric, reserved_items = reserved_items + ${r.items}
            WHERE id = ${r.tripId}`;
}

export async function getReservationForUpdate(db: Db, transactionId: string): Promise<ReservationRow | null> {
  const [row] = await db<ReservationRow[]>`
    SELECT transaction_id, trip_id, kg::text AS kg, items, released_at FROM trip_capacity_reservations
     WHERE transaction_id = ${transactionId} FOR UPDATE`;
  return row ?? null;
}

export async function markReleased(db: Db, r: ReservationRow, reason: string, now: Date): Promise<void> {
  await db`UPDATE trip_capacity_reservations SET released_at = ${now}, release_reason = ${reason.slice(0, 200)}
            WHERE transaction_id = ${r.transaction_id} AND released_at IS NULL`;
  await db`UPDATE trips SET reserved_kg = greatest(0, reserved_kg - ${r.kg}::numeric), reserved_items = greatest(0, reserved_items - ${r.items})
            WHERE id = ${r.trip_id}`;
}
