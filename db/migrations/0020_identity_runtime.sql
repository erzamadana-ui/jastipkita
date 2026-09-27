-- 0020_identity_runtime.sql
-- Identity module runtime columns (owner: identity group, range 0020-0029).
--   1. otp_challenges: encrypted destination (the API needs the plaintext phone/e-mail at verify time
--      to create/link the account; only envelope ciphertext is stored, bound by AAD to the challenge id).
--   2. files: direct-upload bookkeeping (declared checksum, upload deadline, completion time, scan detail).
--   3. privacy_requests: CANCELLED status (user withdrew a deletion request during the grace period)
--      and scheduled_for (end of the deletion grace period).
-- Forward-only, idempotent (re-applied raw by db/scripts/test-db.sh).
BEGIN;

-- 1. -------------------------------------------------------------------------
ALTER TABLE otp_challenges ADD COLUMN IF NOT EXISTS destination_enc bytea;
ALTER TABLE otp_challenges ADD COLUMN IF NOT EXISTS enc_key_id text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'otp_challenges_destination_enc_key_check') THEN
    ALTER TABLE otp_challenges ADD CONSTRAINT otp_challenges_destination_enc_key_check
      CHECK (destination_enc IS NULL OR enc_key_id IS NOT NULL);
  END IF;
END $$;
COMMENT ON COLUMN otp_challenges.destination_enc IS
  'AES-256-GCM ciphertext of the normalized destination (AAD otp_challenges.destination:<id>); hash in destination_hash';

-- 2. -------------------------------------------------------------------------
ALTER TABLE files ADD COLUMN IF NOT EXISTS declared_sha256 bytea;
ALTER TABLE files ADD COLUMN IF NOT EXISTS upload_expires_at timestamptz;
ALTER TABLE files ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE files ADD COLUMN IF NOT EXISTS scan_engine text;
ALTER TABLE files ADD COLUMN IF NOT EXISTS scan_signature text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'files_declared_sha256_len_check') THEN
    ALTER TABLE files ADD CONSTRAINT files_declared_sha256_len_check
      CHECK (declared_sha256 IS NULL OR octet_length(declared_sha256) = 32);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'files_completed_scan_check') THEN
    ALTER TABLE files ADD CONSTRAINT files_completed_scan_check
      CHECK (completed_at IS NULL OR scan_status <> 'PENDING');
  END IF;
END $$;
-- abandoned uploads (never completed) are purged by the identity retention job
CREATE INDEX IF NOT EXISTS files_upload_pending_idx ON files (upload_expires_at)
  WHERE completed_at IS NULL AND deleted_at IS NULL;

-- 3. -------------------------------------------------------------------------
ALTER TABLE privacy_requests DROP CONSTRAINT IF EXISTS privacy_requests_status_check;
ALTER TABLE privacy_requests ADD CONSTRAINT privacy_requests_status_check
  CHECK (status IN ('RECEIVED','VERIFYING','IN_PROGRESS','COMPLETED','REJECTED','CANCELLED'));
ALTER TABLE privacy_requests ADD COLUMN IF NOT EXISTS scheduled_for timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'privacy_requests_deletion_schedule_check') THEN
    ALTER TABLE privacy_requests ADD CONSTRAINT privacy_requests_deletion_schedule_check
      CHECK (type <> 'DELETION' OR status NOT IN ('IN_PROGRESS') OR scheduled_for IS NOT NULL);
  END IF;
END $$;
-- one open request per user and type (export in progress / deletion scheduled)
CREATE UNIQUE INDEX IF NOT EXISTS privacy_requests_one_open_uq ON privacy_requests (user_id, type)
  WHERE status IN ('RECEIVED','VERIFYING','IN_PROGRESS');
CREATE INDEX IF NOT EXISTS privacy_requests_deletion_due_idx ON privacy_requests (scheduled_for)
  WHERE type = 'DELETION' AND status = 'IN_PROGRESS';

SELECT jk_apply_grants();

COMMIT;
