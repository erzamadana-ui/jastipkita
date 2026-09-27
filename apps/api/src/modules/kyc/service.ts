/**
 * KYC (level 3 identity verification) and payout accounts.
 *  - Identity data (ID number, full name, DOB) is stored only as AES-GCM ciphertext (AAD bound to the
 *    identity_records row) + an HMAC of the normalized ID number for dedupe (one ID = one account).
 *  - Submission FSM §15.4: PENDING → IN_REVIEW → APPROVED | REJECTED. The provider decides the second
 *    step (MOCK: automatic; manual: stays IN_REVIEW for the admin queue). Guards via core kycSubmissionFsm.
 *  - Payout accounts (K3+): number encrypted + HMAC + mask ****1234, name inquiry through the payment
 *    provider; only VERIFIED accounts can be default / receive payouts. Responses show the mask only.
 */
import { assessRisk, kycSubmissionFsm } from '@jastipkita/core';
import type { AppDeps, AuthContext } from '../../context';
import { Errors } from '../../lib/errors';
import { audit } from '../../services/audit';
import { emitEvent } from '../../services/outbox';
import { recordRiskAssessment } from '../../services/risk';
import { buf, securityEvent, u8, type RequestMeta } from '../auth/common';
import { inTx } from '../auth/repository';
import { hasGrantedConsent } from '../me/repository';
import { LEVEL_CODES, loadLevelEvidence, recomputeKycLevel } from './level';
import * as repo from './repository';

// =================================================================== status
export async function kycStatus(deps: AppDeps, auth: AuthContext) {
  const [u] = await deps.sql<{ kyc_level: number; trust_score: number }[]>`SELECT kyc_level, trust_score FROM users WHERE id = ${auth.userId}`;
  const level = u!.kyc_level;
  const ev = await loadLevelEvidence(deps.sql, auth.userId);
  const consent = await hasGrantedConsent(deps.sql, auth.userId, 'KYC');
  const subs = await repo.listSubmissions(deps.sql, auth.userId);
  const open = subs.some((s) => s.status === 'PENDING' || s.status === 'IN_REVIEW');
  let next: { level: number; levelCode: string; evaluatedBy: 'USER_ACTION' | 'SYSTEM'; requirements: { code: string; met: boolean; description: string }[] } | null = null;
  if (level === 1) {
    next = { level: 2, levelCode: LEVEL_CODES[2]!, evaluatedBy: 'USER_ACTION', requirements: [{ code: 'PHONE_VERIFIED', met: ev.phoneVerified, description: 'Verifikasi nomor HP dengan kode OTP' }] };
  } else if (level === 2) {
    next = {
      level: 3,
      levelCode: LEVEL_CODES[3]!,
      evaluatedBy: 'USER_ACTION',
      requirements: [
        { code: 'KYC_CONSENT', met: consent, description: 'Setujui pemrosesan data KYC (persetujuan terpisah)' },
        { code: 'IDENTITY_SUBMITTED', met: open || ev.identityApproved, description: 'Unggah KTP/paspor, selfie, dan liveness' },
        { code: 'IDENTITY_APPROVED', met: ev.identityApproved, description: 'Identitas disetujui' },
      ],
    };
  } else if (level === 3) {
    next = {
      level: 4,
      levelCode: LEVEL_CODES[4]!,
      evaluatedBy: 'USER_ACTION',
      requirements: [
        { code: 'PAYOUT_ACCOUNT_VERIFIED', met: ev.payoutVerified, description: 'Tambahkan rekening payout yang terverifikasi' },
        { code: 'TRIP_VERIFIED', met: ev.tripVerified, description: 'Minimal 1 trip dengan dokumen perjalanan terverifikasi' },
      ],
    };
  } else if (level === 4) {
    const [s] = await deps.sql<{ completed: number; disputed: number; total: number }[]>`
      SELECT count(*) FILTER (WHERE t.status = 'COMPLETED')::int AS completed,
             count(DISTINCT d.transaction_id)::int AS disputed,
             count(DISTINCT t.id)::int AS total
        FROM transactions t LEFT JOIN disputes d ON d.transaction_id = t.id
       WHERE t.traveler_id = ${auth.userId}`;
    const rate = s && s.total > 0 ? s.disputed / s.total : 0;
    next = {
      level: 5,
      levelCode: LEVEL_CODES[5]!,
      evaluatedBy: 'SYSTEM',
      requirements: [
        { code: 'COMPLETED_TRANSACTIONS', met: (s?.completed ?? 0) >= 10, description: 'Minimal 10 transaksi selesai' },
        { code: 'TRUST_SCORE', met: u!.trust_score >= 80, description: 'Trust Score minimal 80' },
        { code: 'DISPUTE_RATE', met: rate < 0.03, description: 'Tingkat sengketa di bawah 3%' },
      ],
    };
  }
  return { level, levelCode: LEVEL_CODES[level]!, next, kycConsentGranted: consent, submissions: subs.map(repo.toSubmissionDto) };
}

// =================================================================== submission
export interface KycSubmitInput {
  idType: 'KTP' | 'PASSPORT';
  idNumber: string;
  fullName: string;
  dateOfBirth: string;
  nationality?: string | undefined;
  documents: { idFront: string; idBack?: string | undefined; selfie: string; liveness?: string | undefined };
}

const MIN_AGE_YEARS = 17; // ASSUMPTION: KTP eligibility age; confirm the platform minimum age with counsel

function normalizeIdNumber(idType: 'KTP' | 'PASSPORT', raw: string): string {
  const v = raw.replace(/[\s.\-]/g, '').toUpperCase();
  if (idType === 'KTP' && !/^\d{16}$/.test(v)) throw Errors.unprocessable('ID_NUMBER_INVALID', 'NIK harus 16 digit angka');
  if (idType === 'PASSPORT' && !/^[A-Z0-9]{6,9}$/.test(v)) throw Errors.unprocessable('ID_NUMBER_INVALID', 'Nomor paspor tidak valid');
  return v;
}

function validateDob(dob: string, now: Date) {
  const d = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== dob || d > now) throw Errors.unprocessable('DOB_INVALID', 'Tanggal lahir tidak valid');
  const limit = new Date(Date.UTC(now.getUTCFullYear() - MIN_AGE_YEARS, now.getUTCMonth(), now.getUTCDate()));
  if (d > limit) throw Errors.unprocessable('KYC_AGE_REQUIREMENT', `Usia minimal ${MIN_AGE_YEARS} tahun`);
}

export async function submitKyc(deps: AppDeps, auth: AuthContext, input: KycSubmitInput, req: RequestMeta) {
  const now = deps.clock.now();
  const userId = auth.userId;
  const [u] = await deps.sql<{ kyc_level: number }[]>`SELECT kyc_level FROM users WHERE id = ${userId}`;
  if (u!.kyc_level >= 3) throw Errors.conflict('KYC_ALREADY_VERIFIED', 'Identitas Anda sudah terverifikasi');
  if (!(await hasGrantedConsent(deps.sql, userId, 'KYC'))) {
    throw Errors.unprocessable('CONSENT_REQUIRED', 'Setujui pemrosesan data KYC terlebih dahulu', { required: ['KYC'] });
  }
  const idNumber = normalizeIdNumber(input.idType, input.idNumber);
  validateDob(input.dateOfBirth, now);
  let nationality: string | null = input.nationality ?? null;
  if (input.idType === 'KTP') {
    if (nationality && nationality !== 'ID') throw Errors.unprocessable('NATIONALITY_INVALID', 'KTP hanya untuk WNI (kewarganegaraan ID)');
    nationality = 'ID';
  } else if (!nationality) {
    throw Errors.unprocessable('NATIONALITY_REQUIRED', 'Kewarganegaraan wajib diisi untuk paspor');
  }
  const [country] = await deps.sql`SELECT 1 FROM countries WHERE code = ${nationality}`;
  if (!country) throw Errors.unprocessable('NATIONALITY_INVALID', 'Kode negara tidak dikenal');

  // documents: own, purpose KYC, READY (scanned + encrypted)
  const docs: { type: string; side: 'FRONT' | 'BACK' | 'NA'; fileId: string }[] = [
    { type: input.idType, side: input.idType === 'KTP' ? 'FRONT' : 'NA', fileId: input.documents.idFront },
    ...(input.documents.idBack ? [{ type: input.idType, side: 'BACK' as const, fileId: input.documents.idBack }] : []),
    { type: 'SELFIE', side: 'NA', fileId: input.documents.selfie },
    ...(input.documents.liveness ? [{ type: 'LIVENESS', side: 'NA' as const, fileId: input.documents.liveness }] : []),
  ];
  if (new Set(docs.map((d) => d.fileId)).size !== docs.length) throw Errors.unprocessable('KYC_DOCUMENTS_INVALID', 'Setiap dokumen harus file yang berbeda');
  const files = await deps.sql<{ id: string; storage_key: string }[]>`
    SELECT id, storage_key FROM files
     WHERE id IN ${deps.sql(docs.map((d) => d.fileId))} AND owner_id = ${userId} AND purpose = 'KYC'
       AND scan_status = 'CLEAN' AND completed_at IS NOT NULL AND deleted_at IS NULL AND encrypted`;
  if (files.length !== docs.length) {
    throw Errors.unprocessable('KYC_DOCUMENTS_INVALID', 'Dokumen KYC belum diunggah atau tidak valid', { missing: docs.map((d) => d.fileId).filter((id) => !files.some((f) => f.id === id)) });
  }
  const keyOf = (id: string) => files.find((f) => f.id === id)!.storage_key;

  const idHash = await deps.crypto.hashIdentifier('kyc_id', `${input.idType}:${nationality}:${idNumber}`);
  const [dup] = await deps.sql<{ user_id: string }[]>`SELECT user_id FROM identity_records WHERE id_number_hash = ${buf(idHash)}`;
  if (dup && dup.user_id !== userId) await rejectDuplicate(deps, userId, req);

  const [open] = await deps.sql`SELECT 1 FROM kyc_submissions WHERE user_id = ${userId} AND status IN ('PENDING','IN_REVIEW')`;
  if (open) throw Errors.conflict('KYC_SUBMISSION_OPEN', 'Pengajuan KYC Anda sedang diproses');

  const provider = deps.providers.kyc;
  const providerCode = provider.name.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const providerEnv = provider.mode === 'LIVE' && deps.env.APP_ENV === 'production' ? 'LIVE' : 'TEST';

  let submissionId: string;
  try {
    submissionId = await inTx(deps, async (tx) => {
      const [s] = await tx<{ id: string }[]>`
        INSERT INTO kyc_submissions (user_id, target_level, id_type, status, provider, provider_env, submitted_at, created_at)
        VALUES (${userId}, 3, ${input.idType}, 'PENDING', ${providerCode}, ${providerEnv}, ${now}, ${now}) RETURNING id`;
      const sid = s!.id;
      for (const d of docs) {
        await tx`INSERT INTO kyc_documents (submission_id, user_id, type, side, file_id) VALUES (${sid}, ${userId}, ${d.type}, ${d.side}, ${d.fileId})`;
      }
      const [existing] = await tx<{ id: string }[]>`SELECT id FROM identity_records WHERE user_id = ${userId} FOR UPDATE`;
      const recId = existing?.id ?? crypto.randomUUID();
      const idEnc = await deps.crypto.encrypt(idNumber, `identity_records.id_number:${recId}`);
      const nameEnc = await deps.crypto.encrypt(input.fullName.trim(), `identity_records.full_name:${recId}`);
      const dobEnc = await deps.crypto.encrypt(input.dateOfBirth, `identity_records.dob:${recId}`);
      await tx`
        INSERT INTO identity_records (id, user_id, submission_id, id_type, id_number_enc, id_number_hash, full_name_enc, dob_enc, nationality, enc_key_id)
        VALUES (${recId}, ${userId}, ${sid}, ${input.idType}, ${buf(idEnc)}, ${buf(idHash)}, ${buf(nameEnc)}, ${buf(dobEnc)}, ${nationality}, ${deps.crypto.activeKeyId})
        ON CONFLICT (user_id) DO UPDATE
           SET submission_id = EXCLUDED.submission_id, id_type = EXCLUDED.id_type, id_number_enc = EXCLUDED.id_number_enc,
               id_number_hash = EXCLUDED.id_number_hash, full_name_enc = EXCLUDED.full_name_enc, dob_enc = EXCLUDED.dob_enc,
               nationality = EXCLUDED.nationality, enc_key_id = EXCLUDED.enc_key_id, verified_at = NULL`;
      await emitEvent(tx, 'kyc_submission', sid, 'kyc.submitted', { userId, submissionId: sid, targetLevel: 3 });
      await audit(tx, {
        actorType: 'USER',
        actorId: userId,
        action: 'kyc.submitted',
        entityType: 'kyc_submission',
        entityId: sid,
        after: { status: 'PENDING', idType: input.idType, documents: docs.map((d) => d.type) },
      });
      return sid;
    });
  } catch (err) {
    // concurrent duplicate identity (UNIQUE id_number_hash)
    if ((err as { code?: string; constraint_name?: string }).code === '23505' && String((err as { constraint_name?: string }).constraint_name ?? '').includes('id_number_hash')) {
      await rejectDuplicate(deps, userId, req);
    }
    throw err;
  }

  let result: Awaited<ReturnType<typeof provider.verify>>;
  try {
    result = await provider.verify({
      submissionId,
      documentType: input.idType,
      documentFileKey: keyOf(input.documents.idFront),
      selfieFileKey: keyOf(input.documents.selfie),
      ...(input.documents.liveness ? { livenessFileKey: keyOf(input.documents.liveness) } : {}),
    });
  } catch (err) {
    deps.logger.error('kyc.provider_error', { submissionId, error: err instanceof Error ? err.message : String(err) });
    result = { status: 'MANUAL_REVIEW', reasons: ['PROVIDER_ERROR'] };
  }
  await applyProviderResult(deps, submissionId, userId, result);
  const sub = await repo.getSubmission(deps.sql, submissionId);
  const [lvl] = await deps.sql<{ kyc_level: number }[]>`SELECT kyc_level FROM users WHERE id = ${userId}`;
  return { submission: repo.toSubmissionDto(sub!), kycLevel: lvl!.kyc_level };
}

async function rejectDuplicate(deps: AppDeps, userId: string, req: RequestMeta): Promise<never> {
  const thresholds = await deps.config.get('risk.thresholds');
  const signals = { sharedIdentityHashAccounts: 1 };
  const assessment = assessRisk('USER', signals, thresholds);
  await inTx(deps, async (tx) => {
    await recordRiskAssessment(tx, 'USER', userId, assessment, { ...signals, stage: 'KYC_SUBMISSION' }, assessment.engineVersion);
    await securityEvent(deps, tx, { userId, type: 'KYC_DUPLICATE_IDENTITY', severity: 'HIGH', req, meta: { decision: assessment.decision } });
  });
  throw Errors.conflict('IDENTITY_ALREADY_REGISTERED', 'Identitas ini sudah terdaftar pada akun lain. Hubungi dukungan pelanggan.');
}

type ProviderResult = { status: 'PASSED' | 'FAILED' | 'MANUAL_REVIEW'; livenessScore?: number; faceMatchScore?: number; reasons: string[]; providerRef?: string };

/** PENDING → IN_REVIEW (SYSTEM), then APPROVED / REJECTED when the provider decided (guards: core FSM). */
export async function applyProviderResult(deps: AppDeps, submissionId: string, userId: string, r: ProviderResult) {
  const now = deps.clock.now();
  await inTx(deps, async (tx) => {
    const [s] = await tx<{ status: string }[]>`SELECT status FROM kyc_submissions WHERE id = ${submissionId} FOR UPDATE`;
    if (!s || s.status !== 'PENDING') return;
    kycSubmissionFsm.assertTransition('PENDING', 'IN_REVIEW', 'SYSTEM', {});
    await tx`
      UPDATE kyc_submissions
         SET status = 'IN_REVIEW', provider_ref = ${r.providerRef ?? null},
             provider_result = ${tx.json({ status: r.status, reasons: r.reasons } as never)},
             liveness_score = ${r.livenessScore ?? null}, face_match_score = ${r.faceMatchScore ?? null}
       WHERE id = ${submissionId}`;
    if (r.status === 'MANUAL_REVIEW') return;

    let approve = r.status === 'PASSED';
    let reason = r.reasons.join(', ') || 'PROVIDER_REJECTED';
    let code = r.reasons[0] ?? 'PROVIDER_REJECTED';
    if (approve) {
      const check = kycSubmissionFsm.canTransition('IN_REVIEW', 'APPROVED', 'SYSTEM', {
        livenessPassed: r.livenessScore === undefined || r.livenessScore >= 0.8,
        documentMatches: r.faceMatchScore === undefined || r.faceMatchScore >= 0.8,
        notDuplicate: true, // enforced above (UNIQUE id_number_hash)
      });
      if (!check.ok) {
        approve = false;
        reason = check.message;
        code = check.code;
      }
    }
    if (approve) {
      await tx`UPDATE kyc_submissions SET status = 'APPROVED', reviewed_at = ${now}, decision_reason = 'AUTO_APPROVED_BY_PROVIDER' WHERE id = ${submissionId}`;
      await tx`UPDATE identity_records SET verified_at = ${now} WHERE user_id = ${userId} AND submission_id = ${submissionId}`;
      await tx`UPDATE kyc_documents SET status = 'ACCEPTED' WHERE submission_id = ${submissionId}`;
      await emitEvent(tx, 'kyc_submission', submissionId, 'kyc.approved', { userId, submissionId, targetLevel: 3 });
      await recomputeKycLevel(deps, tx, userId, 'kyc.approved');
      await audit(tx, { actorType: 'SYSTEM', actorId: null, action: 'kyc.approved', entityType: 'kyc_submission', entityId: submissionId, before: { status: 'IN_REVIEW' }, after: { status: 'APPROVED' }, meta: { provider: 'automatic' } });
    } else {
      kycSubmissionFsm.assertTransition('IN_REVIEW', 'REJECTED', 'SYSTEM', { reason });
      await tx`UPDATE kyc_submissions SET status = 'REJECTED', reviewed_at = ${now}, decision_reason = ${reason.slice(0, 500)}, rejection_code = ${code.slice(0, 60)} WHERE id = ${submissionId}`;
      await tx`UPDATE kyc_documents SET status = 'REJECTED' WHERE submission_id = ${submissionId}`;
      await emitEvent(tx, 'kyc_submission', submissionId, 'kyc.rejected', { userId, submissionId, targetLevel: 3, reason: code });
      await audit(tx, { actorType: 'SYSTEM', actorId: null, action: 'kyc.rejected', entityType: 'kyc_submission', entityId: submissionId, before: { status: 'IN_REVIEW' }, after: { status: 'REJECTED', rejectionCode: code } });
    }
  });
}

// =================================================================== payout accounts
function nameTokens(s: string): string[] {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z ]/g, ' ')
    .split(/\s+/)
    .filter((x) => x.length > 0);
}

/** Tolerant name comparison for bank name inquiry (banks truncate/abbreviate names). */
export function namesMatch(a: string, b: string): boolean {
  const A = nameTokens(a);
  const B = nameTokens(b);
  if (!A.length || !B.length) return false;
  const [short, long] = A.length <= B.length ? [A, B] : [B, A];
  return short.every((tok) => long.some((l) => l === tok || (tok.length >= 3 && l.startsWith(tok)) || (l.length >= 3 && tok.startsWith(l))));
}

export async function listPayoutAccounts(deps: AppDeps, auth: AuthContext) {
  return (await repo.listPayoutAccounts(deps.sql, auth.userId)).map(repo.toPayoutDto);
}

export async function addPayoutAccount(
  deps: AppDeps,
  auth: AuthContext,
  input: { bankCode: string; accountNumber: string; holderName: string; makeDefault?: boolean | undefined },
  req: RequestMeta,
) {
  const userId = auth.userId;
  const now = deps.clock.now();
  const hash = await deps.crypto.hashIdentifier('bank_account', `${input.bankCode}:${input.accountNumber}`);
  const mask = `****${input.accountNumber.slice(-4)}`;
  const [mine] = await deps.sql`SELECT 1 FROM payout_accounts WHERE user_id = ${userId} AND account_number_hash = ${buf(hash)} AND disabled_at IS NULL`;
  if (mine) throw Errors.conflict('PAYOUT_ACCOUNT_EXISTS', 'Rekening ini sudah terdaftar');
  const [shared] = await deps.sql<{ n: number }[]>`
    SELECT count(DISTINCT user_id)::int AS n FROM payout_accounts WHERE account_number_hash = ${buf(hash)} AND user_id <> ${userId}`;
  const signals = { sharedPaymentInstrumentAccounts: shared?.n ?? 0 };
  const risk = assessRisk('PAYOUT', signals, await deps.config.get('risk.thresholds'));
  if (risk.decision === 'BLOCK') {
    await inTx(deps, (tx) => recordRiskAssessment(tx, 'USER', userId, risk, { ...signals, stage: 'PAYOUT_ACCOUNT' }, risk.engineVersion));
    throw Errors.forbidden('Rekening tidak dapat ditambahkan. Hubungi dukungan pelanggan.', 'PAYOUT_ACCOUNT_BLOCKED');
  }

  // name inquiry (SANDBOX/MOCK in dev & test — see provider mode)
  let inquiry: { valid: boolean; holderName?: string } | null = null;
  try {
    inquiry = await deps.providers.payment.validateBankAccount({ bankCode: input.bankCode, accountNumber: input.accountNumber });
  } catch (err) {
    deps.logger.warn('kyc.bank_inquiry_unavailable', { error: err instanceof Error ? err.message : String(err) });
  }
  if (inquiry && !inquiry.valid) {
    await securityEvent(deps, deps.sql, { userId, type: 'PAYOUT_ACCOUNT_INVALID', req, meta: { bankCode: input.bankCode, mask } });
    throw Errors.unprocessable('BANK_ACCOUNT_INVALID', 'Nomor rekening tidak ditemukan di bank tujuan');
  }
  // the verified identity name is the reference; fall back to the name the user typed
  const [ir] = await deps.sql<{ id: string; full_name_enc: Buffer }[]>`
    SELECT id, full_name_enc FROM identity_records WHERE user_id = ${userId} AND verified_at IS NOT NULL`;
  const expected = ir ? await deps.crypto.decryptString(u8(ir.full_name_enc), `identity_records.full_name:${ir.id}`) : input.holderName;
  let status: 'VERIFIED' | 'PENDING' = 'PENDING';
  const holderName = inquiry?.holderName ?? input.holderName;
  if (inquiry?.holderName) {
    if (!namesMatch(inquiry.holderName, expected)) {
      await securityEvent(deps, deps.sql, { userId, type: 'PAYOUT_ACCOUNT_NAME_MISMATCH', severity: 'MEDIUM', req, meta: { bankCode: input.bankCode, mask } });
      throw Errors.unprocessable('BANK_ACCOUNT_NAME_MISMATCH', 'Nama pemilik rekening tidak sesuai dengan identitas terverifikasi');
    }
    status = 'VERIFIED';
  }

  const id = crypto.randomUUID();
  const enc = await deps.crypto.encrypt(input.accountNumber, `payout_accounts.account_number:${id}`);
  const row = await inTx(deps, async (tx) => {
    const [hasDefault] = await tx`SELECT 1 FROM payout_accounts WHERE user_id = ${userId} AND is_default AND disabled_at IS NULL FOR UPDATE`;
    const makeDefault = status === 'VERIFIED' && (input.makeDefault === true || !hasDefault);
    if (makeDefault) await tx`UPDATE payout_accounts SET is_default = false WHERE user_id = ${userId} AND is_default`;
    await tx`
      INSERT INTO payout_accounts (id, user_id, bank_code, account_number_enc, account_number_hash, account_mask, holder_name, enc_key_id,
                                   verification_status, verified_at, is_default, created_at)
      VALUES (${id}, ${userId}, ${input.bankCode}, ${buf(enc)}, ${buf(hash)}, ${mask}, ${holderName.slice(0, 120)}, ${deps.crypto.activeKeyId},
              ${status}, ${status === 'VERIFIED' ? now : null}, ${makeDefault}, ${now})`;
    if (signals.sharedPaymentInstrumentAccounts > 0 || risk.decision !== 'ALLOW') {
      await recordRiskAssessment(tx, 'USER', userId, risk, { ...signals, stage: 'PAYOUT_ACCOUNT', payoutAccountId: id }, risk.engineVersion);
    }
    if (status === 'VERIFIED') {
      await emitEvent(tx, 'payout_account', id, 'payout_account.verified', { userId, payoutAccountId: id });
      await recomputeKycLevel(deps, tx, userId, 'payout_account.verified');
    }
    await audit(tx, {
      actorType: 'USER',
      actorId: userId,
      action: 'kyc.payout_account_added',
      entityType: 'payout_account',
      entityId: id,
      after: { bankCode: input.bankCode, accountMask: mask, verificationStatus: status, isDefault: makeDefault },
    });
    return (await repo.getPayoutAccount(tx, userId, id))!;
  });
  return repo.toPayoutDto(row);
}

export async function removePayoutAccount(deps: AppDeps, auth: AuthContext, id: string) {
  const now = deps.clock.now();
  await inTx(deps, async (tx) => {
    const acc = await repo.getPayoutAccount(tx, auth.userId, id, true);
    if (!acc) throw Errors.notFound('Rekening', 'PAYOUT_ACCOUNT_NOT_FOUND');
    const [busy] = await tx`SELECT 1 FROM payouts WHERE payout_account_id = ${id} AND status IN ('SCHEDULED','ON_HOLD','PROCESSING','FAILED') LIMIT 1`;
    if (busy) throw Errors.conflict('PAYOUT_ACCOUNT_IN_USE', 'Rekening masih dipakai untuk payout yang belum selesai');
    await tx`UPDATE payout_accounts SET disabled_at = ${now}, is_default = false WHERE id = ${id}`;
    if (acc.is_default) {
      await tx`UPDATE payout_accounts SET is_default = true
                WHERE id = (SELECT id FROM payout_accounts WHERE user_id = ${auth.userId} AND disabled_at IS NULL AND verification_status = 'VERIFIED'
                             ORDER BY created_at LIMIT 1)`;
    }
    await audit(tx, { actorType: 'USER', actorId: auth.userId, action: 'kyc.payout_account_removed', entityType: 'payout_account', entityId: id, before: { accountMask: acc.account_mask, isDefault: acc.is_default } });
  });
}

export async function setDefaultPayoutAccount(deps: AppDeps, auth: AuthContext, id: string) {
  const row = await inTx(deps, async (tx) => {
    const acc = await repo.getPayoutAccount(tx, auth.userId, id, true);
    if (!acc) throw Errors.notFound('Rekening', 'PAYOUT_ACCOUNT_NOT_FOUND');
    if (acc.verification_status !== 'VERIFIED') throw Errors.unprocessable('PAYOUT_ACCOUNT_NOT_VERIFIED', 'Hanya rekening terverifikasi yang dapat dijadikan utama');
    if (!acc.is_default) {
      await tx`UPDATE payout_accounts SET is_default = false WHERE user_id = ${auth.userId} AND is_default`;
      await tx`UPDATE payout_accounts SET is_default = true WHERE id = ${id}`;
      await audit(tx, { actorType: 'USER', actorId: auth.userId, action: 'kyc.payout_account_default_changed', entityType: 'payout_account', entityId: id, after: { accountMask: acc.account_mask } });
    }
    return (await repo.getPayoutAccount(tx, auth.userId, id))!;
  });
  return repo.toPayoutDto(row);
}

