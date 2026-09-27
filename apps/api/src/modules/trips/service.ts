/**
 * Trips (§3 / §15.1). Status changes only via transition_trip() after the core tripFsm guard.
 *
 * Exported for other groups:
 *   reserveTripCapacity(tx, deps, {...})   — used by offer acceptance (marketplace)
 *   releaseTripCapacity(tx, deps, {...})   — idempotent; used by the transaction.status_changed consumer
 */
import { formatIdr, tripFsm } from '@jastipkita/core';
import type { AppDeps, AuthContext } from '../../context';
import type { Db, TxSql } from '../../db/sql';
import { AppError, Errors } from '../../lib/errors';
import { emitEvent } from '../../services/outbox';
import { assertCategories, assertDestinationCountry, assertOriginCountry } from '../catalog/service';
import { addDaysIso, ceilKg, decodeKeyset, encodeKeyset, badCursor, iso, isIsoDate, num, tx, wibDate } from '../catalog/shared';
import { type PublicProfileDto, loadUserSignals, publicProfile } from '../matching/signals';
import { closePendingOffers } from '../offers/lifecycle';
import * as repo from './repository';
import type { FeeType, TripRow, TripStatus } from './repository';

type Deps = Pick<AppDeps, 'sql' | 'config' | 'clock' | 'logger'>;

export const PUBLIC_TRIP_STATUSES: readonly TripStatus[] = ['ACTIVE', 'FULL', 'TRAVELING', 'COMPLETED'];
const TERMINAL: readonly TripStatus[] = ['COMPLETED', 'CANCELLED'];

export interface TripFeeDto {
  type: FeeType;
  /** IDR for FIXED / PER_KG; bps for PERCENT */
  value: number;
  label: string;
}

export interface TripOwnerDto {
  id: string;
  travelerId: string;
  status: TripStatus;
  version: number;
  originCountry: string;
  originCity: string;
  destinationCountry: string;
  destinationCity: string;
  departureDate: string;
  arrivalDate: string;
  returnDate: string | null;
  capacityKg: number;
  reservedKg: number;
  remainingCapacityKg: number;
  maxItems: number | null;
  reservedItems: number;
  fee: TripFeeDto;
  excludedCategories: string[];
  notes: string | null;
  verified: boolean;
  verifiedAt: string | null;
  publishedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelledReason: string | null;
  verifications: { id: string; docType: string; status: string; fileId: string | null; flightNumber: string | null; flightDate: string | null; createdAt: string; reviewedAt: string | null }[];
  allowedActions: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TripPublicDto {
  id: string;
  status: TripStatus;
  originCountry: string;
  originCity: string;
  destinationCountry: string;
  destinationCity: string;
  departureDate: string;
  arrivalDate: string;
  capacityRemainingKg: number;
  itemsRemaining: number | null;
  fee: TripFeeDto;
  excludedCategories: string[];
  verified: boolean;
  traveler: PublicProfileDto;
}

export function remainingKg(t: Pick<TripRow, 'capacity_kg' | 'reserved_kg'>): number {
  return Math.max(0, Math.round((num(t.capacity_kg) - num(t.reserved_kg)) * 100) / 100);
}

/** Capacity that can still be promised: 0 when the item count is exhausted. */
export function effectiveRemainingKg(t: Pick<TripRow, 'capacity_kg' | 'reserved_kg' | 'max_items' | 'reserved_items'>): number {
  if (t.max_items !== null && t.reserved_items >= t.max_items) return 0;
  return remainingKg(t);
}

export function feeDto(t: Pick<TripRow, 'fee_type' | 'fee_value'>): TripFeeDto {
  const value = num(t.fee_value);
  const label =
    t.fee_type === 'PERCENT'
      ? `${(value / 100).toLocaleString('id-ID', { maximumFractionDigits: 2 })}% dari harga barang`
      : t.fee_type === 'PER_KG'
        ? `${formatIdr(value)}/kg`
        : formatIdr(value);
  return { type: t.fee_type, value, label };
}

export function feeSpec(t: Pick<TripRow, 'fee_type' | 'fee_value'>) {
  const v = num(t.fee_value);
  return t.fee_type === 'PERCENT'
    ? ({ type: 'PERCENT', rateBps: v } as const)
    : t.fee_type === 'PER_KG'
      ? ({ type: 'PER_KG', perKgIdr: v } as const)
      : ({ type: 'FIXED', amountIdr: v } as const);
}

async function ownerDto(db: Db, deps: Deps, t: TripRow): Promise<TripOwnerDto> {
  const verifications = await repo.listVerifications(db, t.id);
  const cfg = await deps.config.get('trips');
  const next = tripFsm.nextAllowed(t.status, 'TRAVELER');
  const actions: string[] = [];
  if (!TERMINAL.includes(t.status)) actions.push('EDIT', 'CANCEL');
  if (t.status === 'DRAFT' || t.status === 'VERIFICATION_PENDING') actions.push('UPLOAD_VERIFICATION');
  if (next.includes('ACTIVE') && (t.status === 'VERIFIED' || cfg.allowUnverifiedActive) && t.status !== 'FULL') actions.push('PUBLISH');
  if (next.includes('TRAVELING')) actions.push('DEPART');
  if (next.includes('COMPLETED')) actions.push('COMPLETE');
  return {
    id: t.id,
    travelerId: t.traveler_id,
    status: t.status,
    version: t.version,
    originCountry: t.origin_country,
    originCity: t.origin_city,
    destinationCountry: t.destination_country,
    destinationCity: t.destination_city,
    departureDate: t.departure_date,
    arrivalDate: t.arrival_date,
    returnDate: t.return_date,
    capacityKg: num(t.capacity_kg),
    reservedKg: num(t.reserved_kg),
    remainingCapacityKg: remainingKg(t),
    maxItems: t.max_items,
    reservedItems: t.reserved_items,
    fee: feeDto(t),
    excludedCategories: t.excluded_categories,
    notes: t.notes,
    verified: t.verified_at !== null,
    verifiedAt: iso(t.verified_at),
    publishedAt: iso(t.published_at),
    completedAt: iso(t.completed_at),
    cancelledAt: iso(t.cancelled_at),
    cancelledReason: t.cancelled_reason,
    verifications: verifications.map((v) => ({
      id: v.id,
      docType: v.doc_type,
      status: v.status,
      fileId: v.file_id,
      flightNumber: v.flight_number,
      flightDate: v.flight_date,
      createdAt: v.created_at.toISOString(),
      reviewedAt: iso(v.reviewed_at),
    })),
    allowedActions: actions,
    createdAt: t.created_at.toISOString(),
    updatedAt: t.updated_at.toISOString(),
  };
}

export function publicTripDto(t: TripRow, traveler: PublicProfileDto): TripPublicDto {
  return {
    id: t.id,
    status: t.status,
    originCountry: t.origin_country,
    originCity: t.origin_city,
    destinationCountry: t.destination_country,
    destinationCity: t.destination_city,
    departureDate: t.departure_date,
    arrivalDate: t.arrival_date,
    capacityRemainingKg: effectiveRemainingKg(t),
    itemsRemaining: t.max_items === null ? null : Math.max(0, t.max_items - t.reserved_items),
    fee: feeDto(t),
    excludedCategories: t.excluded_categories,
    verified: t.verified_at !== null,
    traveler,
  };
}

export async function publicTrips(db: Db, rows: TripRow[]): Promise<TripPublicDto[]> {
  const signals = await loadUserSignals(db, rows.map((r) => r.traveler_id));
  return rows.map((r) => publicTripDto(r, publicProfile(signals.get(r.traveler_id), r.traveler_id, 'TRAVELER')));
}

// ------------------------------------------------------------------------------------ validation

export interface TripInput {
  originCountry: string;
  originCity: string;
  destinationCountry: string;
  destinationCity: string;
  departureDate: string;
  arrivalDate: string;
  returnDate?: string | null;
  capacityKg: number;
  maxItems?: number | null;
  fee: { type: FeeType; value: number };
  excludedCategories?: string[];
  notes?: string | null;
}

async function validateFee(deps: Deps, fee: { type: FeeType; value: number }) {
  if (!Number.isSafeInteger(fee.value) || fee.value < 0) throw Errors.unprocessable('FEE_INVALID', 'Fee tidak valid', { fee });
  if (fee.type === 'PERCENT') {
    const bounds = await deps.config.get('pricing.traveler_fee_bounds');
    if (fee.value > bounds.maxRateBps) {
      throw Errors.unprocessable('FEE_OUT_OF_BOUNDS', `Fee persentase maksimal ${bounds.maxRateBps / 100}% dari harga barang`, {
        maxRateBps: bounds.maxRateBps,
      });
    }
  } else if (fee.value > 100_000_000) {
    throw Errors.unprocessable('FEE_OUT_OF_BOUNDS', 'Fee terlalu besar', { maxIdr: 100_000_000 });
  }
}

async function validateCapacity(deps: Deps, capacityKg: number) {
  const cfg = await deps.config.get('trips');
  if (!(capacityKg > 0) || Math.round(capacityKg * 100) !== capacityKg * 100) {
    throw Errors.unprocessable('CAPACITY_INVALID', 'Kapasitas harus > 0 kg (maks. 2 desimal)');
  }
  if (capacityKg > cfg.maxCapacityKg) {
    throw Errors.unprocessable('CAPACITY_TOO_LARGE', `Kapasitas maksimal ${cfg.maxCapacityKg} kg per trip`, { maxCapacityKg: cfg.maxCapacityKg });
  }
}

function validateDates(today: string, departure: string, arrival: string, returnDate: string | null | undefined, checkPast: boolean) {
  for (const [field, v] of [
    ['departureDate', departure],
    ['arrivalDate', arrival],
    ...(returnDate ? [['returnDate', returnDate] as const] : []),
  ] as const) {
    if (!isIsoDate(v)) throw Errors.validation({ issues: [{ path: field, code: 'invalid_date', message: 'Format tanggal YYYY-MM-DD' }] });
  }
  if (checkPast && departure < today) throw Errors.unprocessable('DATE_IN_PAST', 'Tanggal keberangkatan sudah lewat', { departureDate: departure, today });
  if (arrival < departure) throw Errors.unprocessable('ARRIVAL_BEFORE_DEPARTURE', 'Tanggal tiba harus sama atau setelah tanggal berangkat');
  if (returnDate && returnDate < departure) throw Errors.unprocessable('RETURN_BEFORE_DEPARTURE', 'Tanggal kembali harus setelah tanggal berangkat');
}

// ------------------------------------------------------------------------------------ commands

async function loadOwned(db: Db, id: string, auth: AuthContext, forUpdate = true): Promise<TripRow> {
  const t = await repo.getTrip(db, id, { forUpdate });
  if (!t || t.traveler_id !== auth.userId) throw Errors.notFound('Trip', 'TRIP_NOT_FOUND');
  return t;
}

export async function createTrip(deps: Deps, auth: AuthContext, input: TripInput): Promise<TripOwnerDto> {
  const today = wibDate(deps.clock.now());
  validateDates(today, input.departureDate, input.arrivalDate, input.returnDate, true);
  await validateCapacity(deps, input.capacityKg);
  await validateFee(deps, input.fee);
  if (input.originCountry === input.destinationCountry) throw Errors.unprocessable('SAME_COUNTRY', 'Negara asal dan tujuan harus berbeda');
  await assertOriginCountry(deps.sql, input.originCountry);
  await assertDestinationCountry(deps.sql, input.destinationCountry);
  await assertCategories(deps.sql, input.excludedCategories ?? []);
  const cfg = await deps.config.get('trips');
  return tx(deps.sql, async (t) => {
    // serialize per traveler so the active-trip limit cannot be raced
    await t`SELECT pg_advisory_xact_lock(hashtextextended(${`trips:create:${auth.userId}`}, 0))`;
    const live = await repo.countLiveTrips(t, auth.userId);
    if (live >= cfg.maxActiveTripsPerTraveler) {
      throw Errors.unprocessable('MAX_ACTIVE_TRIPS', `Maksimal ${cfg.maxActiveTripsPerTraveler} trip aktif per traveler`, {
        max: cfg.maxActiveTripsPerTraveler,
      });
    }
    const row = await repo.insertTrip(t, {
      travelerId: auth.userId,
      originCountry: input.originCountry,
      originCity: input.originCity.trim(),
      destinationCountry: input.destinationCountry,
      destinationCity: input.destinationCity.trim(),
      departureDate: input.departureDate,
      arrivalDate: input.arrivalDate,
      returnDate: input.returnDate ?? null,
      capacityKg: input.capacityKg,
      maxItems: input.maxItems ?? null,
      feeType: input.fee.type,
      feeValue: input.fee.value,
      excludedCategories: [...new Set(input.excludedCategories ?? [])],
      notes: input.notes ?? null,
    });
    return ownerDto(t, deps, row);
  });
}

const ALL_FIELDS = [
  'originCountry',
  'originCity',
  'destinationCountry',
  'destinationCity',
  'departureDate',
  'arrivalDate',
  'returnDate',
  'capacityKg',
  'maxItems',
  'fee',
  'excludedCategories',
  'notes',
] as const;
type TripField = (typeof ALL_FIELDS)[number];
const OPERATIONAL: TripField[] = ['returnDate', 'capacityKg', 'maxItems', 'fee', 'excludedCategories', 'notes'];

/** Route & dates are locked once documents are submitted (they are what gets verified). */
export const EDITABLE_FIELDS: Record<TripStatus, readonly TripField[]> = {
  DRAFT: ALL_FIELDS,
  VERIFICATION_PENDING: OPERATIONAL,
  VERIFIED: OPERATIONAL,
  ACTIVE: OPERATIONAL,
  FULL: OPERATIONAL,
  TRAVELING: ['notes'],
  COMPLETED: [],
  CANCELLED: [],
};

export type TripPatch = Partial<Omit<TripInput, 'fee'>> & { fee?: { type: FeeType; value: number } };

export async function updateTrip(deps: Deps, auth: AuthContext, id: string, patch: TripPatch): Promise<TripOwnerDto> {
  const fields = (Object.keys(patch) as TripField[]).filter((k) => patch[k] !== undefined);
  if (fields.length === 0) throw Errors.badRequest('EMPTY_PATCH', 'Tidak ada perubahan');
  return tx(deps.sql, async (t) => {
    const trip = await loadOwned(t, id, auth);
    const allowed = EDITABLE_FIELDS[trip.status];
    const locked = fields.filter((f) => !allowed.includes(f));
    if (locked.length) {
      throw Errors.conflict('TRIP_FIELD_LOCKED', `Field tidak dapat diubah saat trip berstatus ${trip.status}`, { fields: locked, status: trip.status });
    }
    const today = wibDate(deps.clock.now());
    const departure = patch.departureDate ?? trip.departure_date;
    const arrival = patch.arrivalDate ?? trip.arrival_date;
    const ret = patch.returnDate !== undefined ? patch.returnDate : trip.return_date;
    validateDates(today, departure, arrival, ret, patch.departureDate !== undefined);
    if (patch.capacityKg !== undefined) {
      await validateCapacity(deps, patch.capacityKg);
      if (patch.capacityKg < num(trip.reserved_kg)) {
        throw Errors.unprocessable('CAPACITY_BELOW_RESERVED', `Kapasitas tidak boleh di bawah yang sudah dipesan (${num(trip.reserved_kg)} kg)`, {
          reservedKg: num(trip.reserved_kg),
        });
      }
    }
    if (patch.maxItems !== undefined && patch.maxItems !== null && patch.maxItems < trip.reserved_items) {
      throw Errors.unprocessable('MAX_ITEMS_BELOW_RESERVED', 'Jumlah barang maksimal di bawah yang sudah dipesan', { reservedItems: trip.reserved_items });
    }
    if (patch.fee) await validateFee(deps, patch.fee);
    const origin = patch.originCountry ?? trip.origin_country;
    const dest = patch.destinationCountry ?? trip.destination_country;
    if (origin === dest) throw Errors.unprocessable('SAME_COUNTRY', 'Negara asal dan tujuan harus berbeda');
    if (patch.originCountry) await assertOriginCountry(t, patch.originCountry);
    if (patch.destinationCountry) await assertDestinationCountry(t, patch.destinationCountry);
    if (patch.excludedCategories) await assertCategories(t, patch.excludedCategories);

    await repo.updateTripFields(t, trip.id, {
      ...(patch.originCountry ? { originCountry: patch.originCountry } : {}),
      ...(patch.originCity ? { originCity: patch.originCity.trim() } : {}),
      ...(patch.destinationCountry ? { destinationCountry: patch.destinationCountry } : {}),
      ...(patch.destinationCity ? { destinationCity: patch.destinationCity.trim() } : {}),
      ...(patch.departureDate ? { departureDate: patch.departureDate } : {}),
      ...(patch.arrivalDate ? { arrivalDate: patch.arrivalDate } : {}),
      ...(patch.returnDate !== undefined ? { returnDate: patch.returnDate } : {}),
      ...(patch.capacityKg !== undefined ? { capacityKg: patch.capacityKg } : {}),
      ...(patch.maxItems !== undefined ? { maxItems: patch.maxItems } : {}),
      ...(patch.fee ? { feeType: patch.fee.type, feeValue: patch.fee.value } : {}),
      ...(patch.excludedCategories ? { excludedCategories: [...new Set(patch.excludedCategories)] } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    });
    await syncTripFullness(t, trip.id);
    return ownerDto(t, deps, (await repo.getTrip(t, trip.id))!);
  });
}

export interface VerificationInput {
  docType: 'ETICKET' | 'ITINERARY' | 'BOARDING_PASS';
  fileId: string;
  flightNumber?: string | null;
  flightDate?: string | null;
}

export async function submitVerification(deps: Deps, auth: AuthContext, id: string, input: VerificationInput): Promise<TripOwnerDto> {
  return tx(deps.sql, async (t) => {
    const trip = await loadOwned(t, id, auth);
    if (trip.status !== 'DRAFT' && trip.status !== 'VERIFICATION_PENDING') {
      throw Errors.conflict('TRIP_NOT_VERIFIABLE', `Dokumen hanya bisa diunggah untuk trip DRAFT/VERIFICATION_PENDING (sekarang ${trip.status})`);
    }
    const file = await repo.getFile(t, input.fileId);
    if (!file || file.owner_id !== auth.userId || file.deleted_at) throw Errors.notFound('File', 'FILE_NOT_FOUND');
    if (file.purpose !== 'TRIP_DOC') throw Errors.unprocessable('FILE_PURPOSE_MISMATCH', 'File harus diunggah dengan purpose TRIP_DOC', { purpose: file.purpose });
    if (file.scan_status !== 'CLEAN') throw Errors.unprocessable('FILE_NOT_READY', 'File belum selesai diproses atau tidak lolos pemindaian', { scanStatus: file.scan_status });
    if (input.flightDate && !isIsoDate(input.flightDate)) {
      throw Errors.validation({ issues: [{ path: 'flightDate', code: 'invalid_date', message: 'Format tanggal YYYY-MM-DD' }] });
    }
    const v = await repo.insertVerification(t, {
      tripId: trip.id,
      docType: input.docType,
      fileId: file.id,
      flightNumber: input.flightNumber ? input.flightNumber.toUpperCase().replace(/\s+/g, '') : null,
      flightDate: input.flightDate ?? null,
    });
    if (trip.status === 'DRAFT') {
      const check = tripFsm.canTransition('DRAFT', 'VERIFICATION_PENDING', 'TRAVELER', {});
      if (!check.ok) throw Errors.conflict('ILLEGAL_TRANSITION', check.message);
      await repo.transitionTrip(t, trip, 'VERIFICATION_PENDING', 'TRAVELER', auth.userId, 'travel document uploaded', { verificationId: v.id, docType: v.doc_type });
    }
    return ownerDto(t, deps, (await repo.getTrip(t, trip.id))!);
  });
}

function guardFailure(code: string, message: string): AppError {
  switch (code) {
    case 'UNVERIFIED_ACTIVE_NOT_ALLOWED':
      return Errors.unprocessable('TRIP_NOT_VERIFIED', 'Trip harus terverifikasi (dokumen perjalanan disetujui) sebelum dipublikasikan', { guard: code });
    case 'NO_CAPACITY':
      return Errors.unprocessable('NO_CAPACITY', 'Kapasitas trip sudah habis', { guard: code });
    case 'INVALID_TRANSITION':
    case 'TERMINAL_STATUS':
    case 'ACTOR_NOT_ALLOWED':
      return Errors.conflict('ILLEGAL_TRANSITION', message, { guard: code });
    default:
      return Errors.unprocessable(code, message);
  }
}

export async function publishTrip(deps: Deps, auth: AuthContext, id: string): Promise<TripOwnerDto> {
  if (auth.kycLevel < 3) throw Errors.kycRequired(3, auth.kycLevel);
  const cfg = await deps.config.get('trips');
  return tx(deps.sql, async (t) => {
    const trip = await loadOwned(t, id, auth);
    const today = wibDate(deps.clock.now());
    if (trip.departure_date < today) throw Errors.unprocessable('DATE_IN_PAST', 'Tanggal keberangkatan sudah lewat');
    const check = tripFsm.canTransition(trip.status, 'ACTIVE', 'TRAVELER', {
      allowUnverifiedActive: cfg.allowUnverifiedActive,
      remainingCapacityKg: effectiveRemainingKg(trip),
      travelDocumentVerified: trip.verified_at !== null,
    });
    if (!check.ok) throw guardFailure(check.code, check.message);
    await repo.transitionTrip(t, trip, 'ACTIVE', 'TRAVELER', auth.userId, 'publish', { unverified: trip.status !== 'VERIFIED' });
    return ownerDto(t, deps, (await repo.getTrip(t, trip.id))!);
  });
}

export async function departTrip(deps: Deps, auth: AuthContext, id: string): Promise<TripOwnerDto> {
  return tx(deps.sql, async (t) => {
    // lock pending offers before the trip (same order as offer acceptance: offer → trip)
    await t`SELECT id FROM offers WHERE trip_id = ${id} AND status = 'PENDING' ORDER BY id FOR UPDATE`;
    const trip = await loadOwned(t, id, auth);
    const today = wibDate(deps.clock.now());
    if (today < addDaysIso(trip.departure_date, -1)) {
      throw Errors.unprocessable('TOO_EARLY_TO_DEPART', 'Trip belum bisa ditandai berangkat sebelum tanggal keberangkatan', { departureDate: trip.departure_date });
    }
    const check = tripFsm.canTransition(trip.status, 'TRAVELING', 'TRAVELER', {});
    if (!check.ok) throw guardFailure(check.code, check.message);
    await repo.transitionTrip(t, trip, 'TRAVELING', 'TRAVELER', auth.userId, 'departed');
    await closePendingOffers(t, { tripId: trip.id }, 'EXPIRED', 'TRIP_DEPARTED', deps.clock.now());
    return ownerDto(t, deps, (await repo.getTrip(t, trip.id))!);
  });
}

export async function completeTrip(deps: Deps, auth: AuthContext, id: string): Promise<TripOwnerDto> {
  return tx(deps.sql, async (t) => {
    const trip = await loadOwned(t, id, auth);
    const check = tripFsm.canTransition(trip.status, 'COMPLETED', 'TRAVELER', {});
    if (!check.ok) throw guardFailure(check.code, check.message);
    const pending = await repo.unhandedTransactionIds(t, trip.id);
    if (pending.length) {
      throw Errors.conflict('TRIP_HAS_OPEN_TRANSACTIONS', 'Masih ada titipan yang belum diserahkan', { transactionIds: pending });
    }
    await repo.transitionTrip(t, trip, 'COMPLETED', 'TRAVELER', auth.userId, 'all handovers finished');
    return ownerDto(t, deps, (await repo.getTrip(t, trip.id))!);
  });
}

/**
 * Cancels a trip. Pending offers are withdrawn. Open transactions are NOT refunded here: a
 * `trip.cancelled` event lists them for the money group (cancellation matrix / refunds).
 */
export async function cancelTrip(deps: Deps, auth: AuthContext, id: string, reason: string): Promise<TripOwnerDto> {
  return tx(deps.sql, async (t) => {
    await t`SELECT id FROM offers WHERE trip_id = ${id} AND status = 'PENDING' ORDER BY id FOR UPDATE`;
    const trip = await loadOwned(t, id, auth);
    const check = tripFsm.canTransition(trip.status, 'CANCELLED', 'TRAVELER', {});
    if (!check.ok) throw guardFailure(check.code, check.message);
    const open = await repo.openTransactionIds(t, trip.id);
    await repo.transitionTrip(t, trip, 'CANCELLED', 'TRAVELER', auth.userId, reason, { openTransactionIds: open });
    await closePendingOffers(t, { tripId: trip.id }, 'WITHDRAWN', 'TRIP_CANCELLED', deps.clock.now());
    await emitEvent(t, 'trip', trip.id, 'trip.cancelled', {
      tripId: trip.id,
      travelerId: trip.traveler_id,
      actorType: 'TRAVELER',
      reason,
      openTransactionIds: open,
    });
    return ownerDto(t, deps, (await repo.getTrip(t, trip.id))!);
  });
}

// ------------------------------------------------------------------------------------ capacity

/**
 * ACTIVE ↔ FULL automation (SYSTEM) from effective remaining capacity, via the core guard
 * MARK_FULL / HAS_CAPACITY and transition_trip(). Call inside the transaction that changed capacity.
 */
export async function syncTripFullness(db: Db, tripId: string): Promise<TripStatus> {
  const trip = await repo.getTrip(db, tripId, { forUpdate: true });
  if (!trip) return 'CANCELLED';
  const remaining = effectiveRemainingKg(trip);
  if (trip.status === 'ACTIVE' && remaining <= 0) {
    const check = tripFsm.canTransition('ACTIVE', 'FULL', 'SYSTEM', { remainingCapacityKg: 0 });
    if (check.ok) {
      await repo.transitionTrip(db, trip, 'FULL', 'SYSTEM', null, 'capacity exhausted', { reservedKg: num(trip.reserved_kg), reservedItems: trip.reserved_items });
      return 'FULL';
    }
  } else if (trip.status === 'FULL' && remaining > 0) {
    const check = tripFsm.canTransition('FULL', 'ACTIVE', 'SYSTEM', { remainingCapacityKg: remaining });
    if (check.ok) {
      await repo.transitionTrip(db, trip, 'ACTIVE', 'SYSTEM', null, 'capacity available', { remainingKg: remaining });
      return 'ACTIVE';
    }
  }
  return trip.status;
}

/**
 * Reserves capacity for a new transaction on a LOCKED trip row (caller holds FOR UPDATE). Throws
 * CAPACITY_INSUFFICIENT when the (ceil-to-0.01) weight or item count does not fit.
 */
export async function reserveTripCapacity(
  db: TxSql,
  input: { trip: TripRow; transactionId: string; offerId: string | null; kg: number; items: number },
): Promise<{ status: TripStatus; remainingKg: number }> {
  const kg = ceilKg(input.kg);
  const remaining = remainingKg(input.trip);
  if (kg > remaining + 1e-9) {
    throw Errors.unprocessable('CAPACITY_INSUFFICIENT', `Butuh ${kg} kg, sisa kapasitas ${remaining} kg`, { neededKg: kg, remainingKg: remaining });
  }
  if (input.trip.max_items !== null && input.trip.reserved_items + input.items > input.trip.max_items) {
    throw Errors.unprocessable('CAPACITY_INSUFFICIENT', 'Jumlah barang melebihi kapasitas item trip', {
      maxItems: input.trip.max_items,
      reservedItems: input.trip.reserved_items,
    });
  }
  await repo.insertReservation(db, { transactionId: input.transactionId, tripId: input.trip.id, offerId: input.offerId, kg, items: input.items });
  const status = await syncTripFullness(db, input.trip.id);
  const after = await repo.getTrip(db, input.trip.id);
  return { status, remainingKg: after ? remainingKg(after) : 0 };
}

/** Releases a transaction's reservation once (idempotent) and re-opens a FULL trip if capacity returns. */
export async function releaseTripCapacity(db: Db, deps: Pick<AppDeps, 'clock'>, input: { transactionId: string; reason: string }): Promise<boolean> {
  const r = await repo.getReservationForUpdate(db, input.transactionId);
  if (!r || r.released_at) return false;
  await db`SELECT id FROM trips WHERE id = ${r.trip_id} FOR UPDATE`;
  await repo.markReleased(db, r, input.reason, deps.clock.now());
  await syncTripFullness(db, r.trip_id);
  return true;
}

// ------------------------------------------------------------------------------------ queries

export async function getTripView(deps: Deps, auth: AuthContext | undefined, id: string): Promise<{ view: 'OWNER'; trip: TripOwnerDto } | { view: 'PUBLIC'; trip: TripPublicDto }> {
  const trip = await repo.getTrip(deps.sql, id);
  if (!trip) throw Errors.notFound('Trip', 'TRIP_NOT_FOUND');
  if (auth && auth.userId === trip.traveler_id) return { view: 'OWNER', trip: await ownerDto(deps.sql, deps, trip) };
  if (!PUBLIC_TRIP_STATUSES.includes(trip.status)) throw Errors.notFound('Trip', 'TRIP_NOT_FOUND');
  const [dto] = await publicTrips(deps.sql, [trip]);
  return { view: 'PUBLIC', trip: dto! };
}

export async function listMyTrips(
  deps: Deps,
  auth: AuthContext,
  q: { limit: number; cursor?: string | undefined; status?: TripStatus | undefined },
): Promise<{ data: TripOwnerDto[]; nextCursor: string | null }> {
  const cur = decodeKeyset(q.cursor);
  if (q.cursor && !cur) throw badCursor();
  const db = deps.sql;
  const rows = await db<repo.TripRow[]>`
    SELECT ${repo.tripCols(db)} FROM trips t
     WHERE t.traveler_id = ${auth.userId}
       ${q.status ? db`AND t.status = ${q.status}` : db``}
       ${cur ? db`AND (t.created_at, t.id) < (${cur.t}::timestamptz, ${cur.id}::uuid)` : db``}
     ORDER BY t.created_at DESC, t.id DESC
     LIMIT ${q.limit + 1}`;
  const page = rows.slice(0, q.limit);
  const data: TripOwnerDto[] = [];
  for (const r of page) data.push(await ownerDto(db, deps, r));
  const last = page[page.length - 1];
  return { data, nextCursor: rows.length > q.limit && last ? encodeKeyset(last.created_at.toISOString(), last.id) : null };
}

export interface DiscoveryQuery {
  limit: number;
  cursor?: string | undefined;
  originCountry?: string | undefined;
  originCity?: string | undefined;
  destinationCountry?: string | undefined;
  destinationCity?: string | undefined;
  departureFrom?: string | undefined;
  departureTo?: string | undefined;
  arrivalBy?: string | undefined;
  categoryCode?: string | undefined;
  minCapacityKg?: number | undefined;
  verifiedOnly?: boolean | undefined;
}

/** Public discovery: ACTIVE, not yet departed, traveler account ACTIVE. No PII in the output. */
export async function discoverTrips(deps: Deps, q: DiscoveryQuery): Promise<{ data: TripPublicDto[]; nextCursor: string | null }> {
  const cur = decodeKeyset(q.cursor);
  if (q.cursor && (!cur || !isIsoDate(cur.t))) throw badCursor();
  for (const [k, v] of Object.entries({ departureFrom: q.departureFrom, departureTo: q.departureTo, arrivalBy: q.arrivalBy })) {
    if (v !== undefined && !isIsoDate(v)) throw Errors.validation({ issues: [{ path: k, code: 'invalid_date', message: 'Format tanggal YYYY-MM-DD' }] });
  }
  const today = wibDate(deps.clock.now());
  const from = q.departureFrom && q.departureFrom > today ? q.departureFrom : today;
  const db = deps.sql;
  const rows = await db<repo.TripRow[]>`
    SELECT ${repo.tripCols(db)} FROM trips t
      JOIN users u ON u.id = t.traveler_id AND u.status = 'ACTIVE'
     WHERE t.status = 'ACTIVE'
       AND t.departure_date >= ${from}::date
       ${q.departureTo ? db`AND t.departure_date <= ${q.departureTo}::date` : db``}
       ${q.arrivalBy ? db`AND t.arrival_date <= ${q.arrivalBy}::date` : db``}
       ${q.originCountry ? db`AND t.origin_country = ${q.originCountry}` : db``}
       ${q.originCity ? db`AND lower(t.origin_city) = lower(${q.originCity.trim()})` : db``}
       ${q.destinationCountry ? db`AND t.destination_country = ${q.destinationCountry}` : db``}
       ${q.destinationCity ? db`AND lower(t.destination_city) = lower(${q.destinationCity.trim()})` : db``}
       ${q.categoryCode ? db`AND NOT (${q.categoryCode} = ANY (t.excluded_categories))` : db``}
       ${q.minCapacityKg !== undefined ? db`AND (t.capacity_kg - t.reserved_kg) >= ${q.minCapacityKg}` : db``}
       ${q.verifiedOnly ? db`AND t.verified_at IS NOT NULL` : db``}
       ${cur ? db`AND (t.departure_date, t.id) > (${cur.t}::date, ${cur.id}::uuid)` : db``}
     ORDER BY t.departure_date, t.id
     LIMIT ${q.limit + 1}`;
  const page = rows.slice(0, q.limit);
  const data = await publicTrips(db, page);
  const last = page[page.length - 1];
  return { data, nextCursor: rows.length > q.limit && last ? encodeKeyset(last.departure_date, last.id) : null };
}
