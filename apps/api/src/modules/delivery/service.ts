/**
 * Delivery & handover (§11): MEETUP PIN/QR (only hashes stored; the plaintext is revealed to the buyer
 * alone and rotated on every reveal), COURIER / PARTNER_LOGISTICS shipping, idempotent confirmations,
 * buyer confirmation and auto-confirm.
 */
import { autoConfirmAt, constantTimeEqual, generatePin, pinRandomBytesNeeded, qrExpiresAt, verifyPinAttempt } from '@jastipkita/core';
import type { AppDeps, AuthContext } from '../../context';
import { camel, type Db, type TxSql } from '../../db/sql';
import { bytesToHex, randomBytes, randomToken } from '../../lib/crypto';
import { AppError, Errors } from '../../lib/errors';
import { audit } from '../../services/audit';
import { emitEvent } from '../../services/outbox';
import { recordRiskAssessment } from '../../services/risk';
import { completeTransaction } from '../transactions/completion';
import { assertOwnedFiles, guardedTransition, loadTx, requireParty, setDbActor, type TxRow } from '../transactions/common';

export interface DeliveryRow {
  id: string;
  transactionId: string;
  method: 'MEETUP' | 'COURIER' | 'PARTNER_LOGISTICS';
  courierName: string | null;
  trackingNumber: string | null;
  addressEnc: Buffer | null;
  addressCity: string | null;
  meetupPoint: string | null;
  scheduledAt: Date | null;
  pinHash: Buffer | null;
  pinAttempts: number;
  pinMaxAttempts: number;
  pinLockedAt: Date | null;
  qrTokenHash: Buffer | null;
  qrExpiresAt: Date | null;
  confirmedAt: Date | null;
  confirmedVia: string | null;
  confirmedBy: string | null;
  proofFileIds: string[];
  status: 'PENDING' | 'SCHEDULED' | 'IN_TRANSIT' | 'DELIVERED' | 'FAILED' | 'CANCELLED';
  createdAt: Date;
}

export async function liveDelivery(db: Db, transactionId: string, forUpdate = false): Promise<DeliveryRow | null> {
  const rows = forUpdate
    ? await db<Record<string, unknown>[]>`SELECT * FROM deliveries WHERE transaction_id = ${transactionId} AND status NOT IN ('FAILED','CANCELLED') FOR UPDATE`
    : await db<Record<string, unknown>[]>`SELECT * FROM deliveries WHERE transaction_id = ${transactionId} AND status NOT IN ('FAILED','CANCELLED')`;
  return rows[0] ? camel<DeliveryRow>(rows[0]) : null;
}

const PIN_REVEALABLE_TX_STATUSES = ['PURCHASED', 'TRAVELING', 'ARRIVED', 'CUSTOMS_PROCESS', 'READY_FOR_HANDOVER'];

/**
 * Public delivery view — never exposes PIN/QR hashes or the encrypted address. With `txStatus`, the buyer's view
 * carries `pinAvailable` (a PIN/QR can be revealed now via GET /delivery/pin).
 */
export function deliveryView(d: DeliveryRow | null, role: 'BUYER' | 'TRAVELER', txStatus?: string) {
  if (!d) return null;
  const pinAvailable =
    role === 'BUYER' && txStatus !== undefined
      ? {
          pinAvailable:
            d.method === 'MEETUP' && d.status !== 'DELIVERED' && !d.pinLockedAt && PIN_REVEALABLE_TX_STATUSES.includes(txStatus),
        }
      : {};
  return {
    ...pinAvailable,
    id: d.id,
    method: d.method,
    status: d.status,
    courierName: d.courierName,
    trackingNumber: d.trackingNumber,
    addressCity: d.addressCity,
    meetupPoint: d.meetupPoint,
    scheduledAt: d.scheduledAt ? new Date(d.scheduledAt).toISOString() : null,
    confirmedAt: d.confirmedAt ? new Date(d.confirmedAt).toISOString() : null,
    confirmedVia: d.confirmedVia,
    proofFileIds: d.proofFileIds ?? [],
    pin: d.method === 'MEETUP'
      ? {
          locked: !!d.pinLockedAt,
          attemptsRemaining: Math.max(0, d.pinMaxAttempts - d.pinAttempts),
          // The PIN itself is only returned by GET /delivery/pin to the buyer.
          ...(role === 'BUYER' ? { revealEndpoint: `/v1/transactions/${d.transactionId}/delivery/pin` } : {}),
        }
      : null,
  };
}

const SETTABLE = ['PURCHASED', 'TRAVELING', 'ARRIVED', 'CUSTOMS_PROCESS', 'READY_FOR_HANDOVER'];

export interface SetDeliveryInput {
  method: 'MEETUP' | 'COURIER' | 'PARTNER_LOGISTICS';
  courierName?: string | undefined;
  trackingNumber?: string | undefined;
  meetupPoint?: string | undefined;
  scheduledAt?: string | undefined;
  address?: string | undefined;
  addressCity?: string | undefined;
}

async function pinHash(deps: AppDeps, deliveryId: string, pin: string) {
  return deps.crypto.hashIdentifier('delivery_pin', `${deliveryId}:${pin}`);
}
async function qrHash(deps: AppDeps, deliveryId: string, token: string) {
  return deps.crypto.hashIdentifier('delivery_qr', `${deliveryId}:${token}`);
}

async function issueSecrets(deps: AppDeps, db: TxSql, d: Pick<DeliveryRow, 'id'>): Promise<{ pin: string; qrToken: string; qrExpiresAt: Date }> {
  const cfg = await deps.config.get('delivery');
  const pin = generatePin(randomBytes(pinRandomBytesNeeded(cfg.pinLength)), cfg.pinLength);
  const qrToken = randomToken(24);
  const expires = qrExpiresAt(deps.clock.now(), cfg.qrTtlMinutes);
  await db`UPDATE deliveries SET pin_hash = ${Buffer.from(await pinHash(deps, d.id, pin))}, qr_token_hash = ${Buffer.from(await qrHash(deps, d.id, qrToken))},
             qr_expires_at = ${expires} WHERE id = ${d.id}`;
  return { pin, qrToken, qrExpiresAt: expires };
}

export async function setDelivery(deps: AppDeps, auth: AuthContext, id: string, input: SetDeliveryInput) {
  const cfg = await deps.config.get('delivery');
  return deps.sql.begin(async (db) => {
    await setDbActor(db, 'TRAVELER', auth.userId);
    const { tx } = await requireParty(db, id, auth, { role: 'TRAVELER', forUpdate: true });
    if (!SETTABLE.includes(tx.status)) throw Errors.unprocessable('DELIVERY_NOT_EDITABLE', 'Metode pengiriman tidak dapat diubah pada status ini', { status: tx.status });
    if (input.method === 'MEETUP' && !input.meetupPoint) throw Errors.validation({ meetupPoint: 'required for MEETUP' });
    const existing = await liveDelivery(db, tx.id, true);
    if (existing && existing.status !== 'PENDING' && existing.status !== 'SCHEDULED') {
      throw Errors.unprocessable('DELIVERY_IN_PROGRESS', 'Pengiriman sudah berjalan', { status: existing.status });
    }
    if (existing?.pinLockedAt) throw new AppError(423, 'PIN_LOCKED', 'Serah terima dikunci; hubungi Pusat Bantuan');
    if (existing) await db`UPDATE deliveries SET status = 'CANCELLED' WHERE id = ${existing.id}`;
    const deliveryId = crypto.randomUUID();
    const addressEnc = input.address ? Buffer.from(await deps.crypto.encrypt(input.address, `deliveries.address:${deliveryId}`)) : null;
    await db`
      INSERT INTO deliveries (id, transaction_id, method, courier_name, tracking_number, address_enc, enc_key_id, address_city, meetup_point,
                              scheduled_at, pin_attempts, pin_max_attempts, status)
      VALUES (${deliveryId}, ${tx.id}, ${input.method}, ${input.courierName ?? null}, ${input.trackingNumber ?? null}, ${addressEnc},
              ${addressEnc ? deps.crypto.activeKeyId : null}, ${input.addressCity ?? null}, ${input.meetupPoint ?? null},
              ${input.scheduledAt ? new Date(input.scheduledAt) : null}, ${existing?.pinAttempts ?? 0},
              ${Math.min(5, Math.max(1, cfg.maxPinAttempts))}, ${input.scheduledAt ? 'SCHEDULED' : 'PENDING'})`;
    await db`UPDATE transactions SET delivery_method = ${input.method} WHERE id = ${tx.id}`;
    if (input.method === 'MEETUP') {
      await issueSecrets(deps, db, { id: deliveryId });
      // PIN is NOT in the payload (or any e-mail): the buyer opens the app to reveal it.
      await emitEvent(db, 'transaction', tx.id, 'delivery.pin_ready', { transactionId: tx.id, buyerId: tx.buyerId });
    }
    await audit(db, { actorType: 'TRAVELER', actorId: auth.userId, action: 'delivery.method_set', entityType: 'delivery', entityId: deliveryId, meta: { transactionId: tx.id, method: input.method } });
    return deliveryView((await liveDelivery(db, tx.id))!, 'TRAVELER')!;
  });
}

/** Buyer-only: reveals a fresh PIN + QR token (rotated on each reveal; attempts are NOT reset). */
export async function revealPin(deps: AppDeps, auth: AuthContext, id: string) {
  return deps.sql.begin(async (db) => {
    const { tx } = await requireParty(db, id, auth, { role: 'BUYER', forUpdate: true });
    const d = await liveDelivery(db, tx.id, true);
    if (!d || d.method !== 'MEETUP') throw Errors.unprocessable('PIN_NOT_AVAILABLE', 'PIN hanya untuk serah terima langsung (MEETUP)');
    if (d.status === 'DELIVERED' || ['DELIVERED', 'BUYER_CONFIRMED', 'COMPLETED'].includes(tx.status)) {
      throw Errors.unprocessable('ALREADY_DELIVERED', 'Barang sudah diserahterimakan');
    }
    if (d.pinLockedAt) throw new AppError(423, 'PIN_LOCKED', 'PIN terkunci karena terlalu banyak percobaan; hubungi Pusat Bantuan');
    const s = await issueSecrets(deps, db, d);
    return {
      pin: s.pin,
      qrToken: s.qrToken,
      qrPayload: `jastipkita://handover/${tx.id}?t=${s.qrToken}`,
      qrExpiresAt: s.qrExpiresAt.toISOString(),
      attemptsRemaining: Math.max(0, d.pinMaxAttempts - d.pinAttempts),
      note: 'Tunjukkan PIN/QR hanya saat barang sudah Anda terima dan periksa.',
    };
  });
}

type VerifyOutcome =
  | { kind: 'DELIVERED'; status: string; confirmedVia: string; alreadyConfirmed: boolean }
  | { kind: 'WRONG'; attemptsRemaining: number }
  | { kind: 'LOCKED' };

/** Traveler verifies the buyer's PIN or QR (MEETUP). Duplicate confirmations are idempotent. */
export async function verifyHandover(deps: AppDeps, auth: AuthContext, id: string, body: { pin?: string | undefined; qrToken?: string | undefined }) {
  if (!body.pin && !body.qrToken) throw Errors.validation({ pin: 'pin or qrToken required' });
  const cfg = await deps.config.get('delivery');
  const now = deps.clock.now();
  const outcome = await deps.sql.begin(async (db): Promise<VerifyOutcome> => {
    await setDbActor(db, 'TRAVELER', auth.userId);
    const { tx } = await requireParty(db, id, auth, { role: 'TRAVELER', forUpdate: true });
    const d = await liveDelivery(db, tx.id, true);
    if (d?.status === 'DELIVERED' && ['DELIVERED', 'BUYER_CONFIRMED', 'COMPLETED'].includes(tx.status)) {
      return { kind: 'DELIVERED', status: tx.status, confirmedVia: d.confirmedVia ?? 'PIN', alreadyConfirmed: true };
    }
    if (!d || d.method !== 'MEETUP') throw Errors.unprocessable('DELIVERY_METHOD_INVALID', 'Verifikasi PIN hanya untuk metode MEETUP');
    if (tx.status !== 'READY_FOR_HANDOVER') throw Errors.unprocessable('INVALID_TRANSACTION_STATUS', 'Barang belum siap diserahterimakan', { status: tx.status });
    const maxAttempts = Math.min(d.pinMaxAttempts, cfg.maxPinAttempts);
    if (d.pinLockedAt || d.pinAttempts >= maxAttempts) return { kind: 'LOCKED' };
    let matches = false;
    let via: 'PIN' | 'QR' = 'PIN';
    if (body.qrToken && d.qrTokenHash) {
      via = 'QR';
      const h = bytesToHex(await qrHash(deps, d.id, body.qrToken));
      matches = constantTimeEqual(h, bytesToHex(new Uint8Array(d.qrTokenHash))) && !!d.qrExpiresAt && new Date(d.qrExpiresAt).getTime() > now.getTime();
    } else if (body.pin && d.pinHash) {
      const h = bytesToHex(await pinHash(deps, d.id, body.pin));
      matches = constantTimeEqual(h, bytesToHex(new Uint8Array(d.pinHash)));
    }
    const r = verifyPinAttempt({ attempts: d.pinAttempts, maxAttempts, matches });
    if (r.code === 'VERIFIED') {
      await db`UPDATE deliveries SET status = 'DELIVERED', confirmed_at = ${now}, confirmed_via = ${via}, confirmed_by = ${auth.userId} WHERE id = ${d.id}`;
      const next = await guardedTransition(db, tx, 'DELIVERED', 'TRAVELER', auth.userId, { deliveryMethod: 'MEETUP', pinVerified: true }, `Serah terima terverifikasi (${via})`, {
        confirmedVia: via,
      });
      await db`UPDATE transactions SET auto_confirm_at = ${autoConfirmAt(now, cfg.autoConfirmHours)} WHERE id = ${tx.id}`;
      await audit(db, { actorType: 'TRAVELER', actorId: auth.userId, action: 'delivery.confirmed', entityType: 'delivery', entityId: d.id, meta: { transactionId: tx.id, via } });
      return { kind: 'DELIVERED', status: next.status, confirmedVia: via, alreadyConfirmed: false };
    }
    await db`UPDATE deliveries SET pin_attempts = ${r.attempts}, pin_locked_at = ${r.locked ? now : null} WHERE id = ${d.id}`;
    if (r.locked) {
      await recordRiskAssessment(
        db,
        'TRANSACTION',
        tx.id,
        { score: 50, decision: 'REVIEW', reasons: [{ code: 'DELIVERY_PIN_BRUTE_FORCE', weight: 50, message: `PIN salah ${r.attempts}x; serah terima dikunci` }] },
        { deliveryId: d.id, attempts: r.attempts },
        'money-v1',
      );
      await db`INSERT INTO security_events (user_id, type, severity, meta)
               VALUES (${auth.userId}, 'DELIVERY_PIN_LOCKED', 'HIGH', ${db.json({ transactionId: tx.id, deliveryId: d.id } as never)})`;
      await audit(db, { actorType: 'TRAVELER', actorId: auth.userId, action: 'delivery.pin_locked', entityType: 'delivery', entityId: d.id, meta: { transactionId: tx.id } });
      return { kind: 'LOCKED' };
    }
    return { kind: 'WRONG', attemptsRemaining: r.attemptsRemaining };
  });
  if (outcome.kind === 'LOCKED') throw new AppError(423, 'PIN_LOCKED', 'Terlalu banyak percobaan PIN; serah terima dikunci. Hubungi Pusat Bantuan.');
  if (outcome.kind === 'WRONG') throw new AppError(422, 'PIN_INVALID', 'PIN/QR tidak cocok', { attemptsRemaining: outcome.attemptsRemaining });
  return { transactionStatus: outcome.status, confirmedVia: outcome.confirmedVia, alreadyConfirmed: outcome.alreadyConfirmed };
}

export async function markShipped(deps: AppDeps, auth: AuthContext, id: string, body: { trackingNumber: string; courierName?: string | undefined }) {
  return deps.sql.begin(async (db) => {
    await setDbActor(db, 'TRAVELER', auth.userId);
    const { tx } = await requireParty(db, id, auth, { role: 'TRAVELER', forUpdate: true });
    const d = await liveDelivery(db, tx.id, true);
    if (tx.status === 'OUT_FOR_DELIVERY' && d?.trackingNumber === body.trackingNumber) {
      return { transactionStatus: tx.status, delivery: deliveryView(d, 'TRAVELER'), alreadyShipped: true };
    }
    if (!d) throw Errors.unprocessable('DELIVERY_NOT_SET', 'Tentukan metode pengiriman terlebih dahulu');
    const next = await guardedTransition(db, tx, 'OUT_FOR_DELIVERY', 'TRAVELER', auth.userId, { deliveryMethod: d.method, trackingNumber: body.trackingNumber }, 'Barang dikirim');
    await db`UPDATE deliveries SET status = 'IN_TRANSIT', tracking_number = ${body.trackingNumber}, courier_name = coalesce(${body.courierName ?? null}, courier_name) WHERE id = ${d.id}`;
    return { transactionStatus: next.status, delivery: deliveryView((await liveDelivery(db, tx.id))!, 'TRAVELER'), alreadyShipped: false };
  });
}

export async function markDelivered(deps: AppDeps, auth: AuthContext, id: string, body: { proofFileIds: string[] }) {
  const cfg = await deps.config.get('delivery');
  const now = deps.clock.now();
  return deps.sql.begin(async (db) => {
    await setDbActor(db, 'TRAVELER', auth.userId);
    const { tx } = await requireParty(db, id, auth, { role: 'TRAVELER', forUpdate: true });
    if (['DELIVERED', 'BUYER_CONFIRMED', 'COMPLETED'].includes(tx.status)) {
      return { transactionStatus: tx.status, alreadyDelivered: true };
    }
    const d = await liveDelivery(db, tx.id, true);
    if (!d) throw Errors.unprocessable('DELIVERY_NOT_SET', 'Tentukan metode pengiriman terlebih dahulu');
    await assertOwnedFiles(db, body.proofFileIds, auth.userId, ['DELIVERY_PROOF', 'EVIDENCE', 'PRODUCT_PHOTO'], 'proofFileIds');
    const next = await guardedTransition(db, tx, 'DELIVERED', 'TRAVELER', auth.userId, { deliveryProofProvided: body.proofFileIds.length > 0 }, 'Barang terkirim (bukti kirim)');
    await db`UPDATE deliveries SET proof_file_ids = ${body.proofFileIds}::uuid[] WHERE id = ${d.id}`;
    await db`UPDATE transactions SET auto_confirm_at = ${autoConfirmAt(now, cfg.autoConfirmHours)} WHERE id = ${tx.id}`;
    return { transactionStatus: next.status, alreadyDelivered: false };
  });
}

async function markDeliveryConfirmed(db: TxSql, txId: string, via: 'BUYER_APP' | 'AUTO', by: string | null, now: Date) {
  const d = await liveDelivery(db, txId, true);
  if (d && d.status !== 'DELIVERED') {
    await db`UPDATE deliveries SET status = 'DELIVERED', confirmed_at = ${now}, confirmed_via = ${via}, confirmed_by = ${by},
               tracking_number = coalesce(tracking_number, CASE WHEN method = 'MEETUP' THEN NULL ELSE 'N/A' END) WHERE id = ${d.id}`;
  }
}

/** Buyer confirms receipt (💰) → BUYER_CONFIRMED, then SYSTEM completion. Idempotent on repeated calls. */
export async function confirmReceipt(deps: AppDeps, auth: AuthContext, id: string) {
  const now = deps.clock.now();
  const r = await deps.sql.begin(async (db) => {
    await setDbActor(db, 'BUYER', auth.userId);
    const { tx } = await requireParty(db, id, auth, { role: 'BUYER', forUpdate: true });
    if (tx.status === 'BUYER_CONFIRMED' || tx.status === 'COMPLETED') return { tx, already: true };
    const [dispute] = await db`SELECT 1 FROM disputes WHERE transaction_id = ${tx.id} AND status <> 'CLOSED' LIMIT 1`;
    const next = await guardedTransition(db, tx, 'BUYER_CONFIRMED', 'BUYER', auth.userId, { disputeOpen: !!dispute }, 'Penitip mengonfirmasi barang diterima');
    await markDeliveryConfirmed(db, tx.id, 'BUYER_APP', auth.userId, now);
    await audit(db, { actorType: 'BUYER', actorId: auth.userId, action: 'transaction.receipt_confirmed', entityType: 'transaction', entityId: tx.id });
    return { tx: next, already: false };
  });
  const completion = await completeTransaction(deps, id);
  const fresh = (await loadTx(deps.sql, id))!;
  return {
    transactionStatus: fresh.status,
    alreadyConfirmed: r.already,
    completion: completion.completed ? { completed: true, payoutId: completion.payoutId } : { completed: fresh.status === 'COMPLETED', reason: completion.reason },
  };
}

/** Job: DELIVERED past auto_confirm_at with no open dispute → BUYER_CONFIRMED (SYSTEM) → completion. */
export async function autoConfirmDeliveries(deps: AppDeps): Promise<{ confirmed: number }> {
  const now = deps.clock.now();
  const due = await deps.sql<{ id: string }[]>`
    SELECT id FROM transactions WHERE status = 'DELIVERED' AND auto_confirm_at IS NOT NULL AND auto_confirm_at <= ${now}
     ORDER BY auto_confirm_at LIMIT 100`;
  let confirmed = 0;
  for (const { id } of due) {
    const ok = await deps.sql.begin(async (db) => {
      await setDbActor(db, 'SYSTEM', null);
      const tx: TxRow | null = await loadTx(db, id, { forUpdate: true });
      if (!tx || tx.status !== 'DELIVERED') return false;
      const [dispute] = await db`SELECT 1 FROM disputes WHERE transaction_id = ${tx.id} AND status <> 'CLOSED' LIMIT 1`;
      if (dispute) return false;
      await guardedTransition(db, tx, 'BUYER_CONFIRMED', 'SYSTEM', null, { disputeOpen: false, autoConfirmDue: true }, 'Konfirmasi otomatis setelah batas waktu');
      await markDeliveryConfirmed(db, tx.id, 'AUTO', null, now);
      return true;
    });
    if (ok) {
      confirmed++;
      await completeTransaction(deps, id);
    }
  }
  return { confirmed };
}
