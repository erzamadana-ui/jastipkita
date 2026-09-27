-- 0006_kyc.sql
-- KYC submissions & documents, encrypted identity records, payout (bank) accounts.
-- The DB never stores plaintext ID numbers, DOB, bank account numbers or images:
-- *_enc = envelope ciphertext (API-side AES-256-GCM, key id in enc_key_id),
-- *_hash = HMAC-SHA256 for dedupe/lookup. Display uses account_mask ('****0961').
BEGIN;

CREATE TABLE IF NOT EXISTS kyc_submissions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id),
  target_level     smallint NOT NULL CHECK (target_level IN (3, 4)),
  id_type          text CHECK (id_type IN ('KTP','PASSPORT')),
  status           text NOT NULL DEFAULT 'DRAFT'
                   CHECK (status IN ('DRAFT','SUBMITTED','IN_REVIEW','APPROVED','REJECTED','RESUBMIT_REQUIRED','EXPIRED')),
  provider         text NOT NULL DEFAULT 'MANUAL' CHECK (provider ~ '^[A-Z][A-Z0-9_]*$'),
  provider_env     text NOT NULL DEFAULT 'TEST' CHECK (provider_env IN ('TEST','LIVE')),
  provider_ref     text,
  provider_result  jsonb NOT NULL DEFAULT '{}',   -- scores/flags only, never PII
  liveness_score   numeric(5,4) CHECK (liveness_score BETWEEN 0 AND 1),
  face_match_score numeric(5,4) CHECK (face_match_score BETWEEN 0 AND 1),
  risk_flags       jsonb NOT NULL DEFAULT '[]',
  submitted_at     timestamptz,
  reviewed_by      uuid REFERENCES users(id),
  reviewed_at      timestamptz,
  decision_reason  text,
  rejection_code   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (reviewed_by IS DISTINCT FROM user_id),
  CHECK (status NOT IN ('APPROVED','REJECTED') OR reviewed_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS kyc_submissions_one_open_uq ON kyc_submissions (user_id, target_level)
  WHERE status IN ('SUBMITTED','IN_REVIEW');
CREATE INDEX IF NOT EXISTS kyc_submissions_user_id_idx ON kyc_submissions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS kyc_submissions_queue_idx ON kyc_submissions (submitted_at) WHERE status IN ('SUBMITTED','IN_REVIEW');
CREATE INDEX IF NOT EXISTS kyc_submissions_reviewed_by_idx ON kyc_submissions (reviewed_by);
SELECT jk_attach_updated_at('kyc_submissions');

CREATE TABLE IF NOT EXISTS kyc_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES kyc_submissions(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  type          text NOT NULL CHECK (type IN ('KTP','PASSPORT','SELFIE','LIVENESS','BANK_PROOF')),
  side          text NOT NULL DEFAULT 'NA' CHECK (side IN ('FRONT','BACK','NA')),
  file_id       uuid REFERENCES files(id),     -- NULL after purge
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACCEPTED','REJECTED','PURGED')),
  purge_after   timestamptz,
  purged_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'PURGED' OR (purged_at IS NOT NULL AND file_id IS NULL)),
  CHECK (status = 'PURGED' OR file_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS kyc_documents_submission_id_idx ON kyc_documents (submission_id);
CREATE INDEX IF NOT EXISTS kyc_documents_user_id_idx ON kyc_documents (user_id);
CREATE INDEX IF NOT EXISTS kyc_documents_file_id_idx ON kyc_documents (file_id);
CREATE INDEX IF NOT EXISTS kyc_documents_purge_idx ON kyc_documents (purge_after) WHERE purged_at IS NULL AND purge_after IS NOT NULL;
SELECT jk_attach_updated_at('kyc_documents');

CREATE TABLE IF NOT EXISTS identity_records (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users(id),
  submission_id        uuid REFERENCES kyc_submissions(id),
  id_type              text NOT NULL CHECK (id_type IN ('KTP','PASSPORT')),
  id_number_enc        bytea NOT NULL,
  id_number_hash       bytea NOT NULL UNIQUE,   -- one identity document => one account
  full_name_enc        bytea NOT NULL,
  dob_enc              bytea,
  nationality          char(2) REFERENCES countries(code),
  enc_key_id           text NOT NULL,
  verified_at          timestamptz,
  purge_after          timestamptz,             -- set on account closure per retention policy
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(id_number_hash) = 32)
);
CREATE UNIQUE INDEX IF NOT EXISTS identity_records_user_uq ON identity_records (user_id);
CREATE INDEX IF NOT EXISTS identity_records_submission_id_idx ON identity_records (submission_id);
CREATE INDEX IF NOT EXISTS identity_records_nationality_idx ON identity_records (nationality);
CREATE INDEX IF NOT EXISTS identity_records_purge_idx ON identity_records (purge_after) WHERE purge_after IS NOT NULL;
SELECT jk_attach_updated_at('identity_records');
INSERT INTO jk_sensitive_columns VALUES ('identity_records','*','KYC identity data') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS payout_accounts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users(id),
  bank_code            text NOT NULL CHECK (bank_code ~ '^[A-Z0-9_]{2,20}$'),
  account_number_enc   bytea,                  -- NULL only after anonymization
  account_number_hash  bytea NOT NULL,
  account_mask         text NOT NULL CHECK (account_mask ~ '^\*{4}[0-9]{2,4}$'),
  holder_name          text NOT NULL,
  enc_key_id           text NOT NULL,
  verification_status  text NOT NULL DEFAULT 'UNVERIFIED'
                       CHECK (verification_status IN ('UNVERIFIED','PENDING','VERIFIED','FAILED','NAME_MISMATCH')),
  verification_ref     text,
  verified_at          timestamptz,
  is_default           boolean NOT NULL DEFAULT false,
  disabled_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),                         -- target of composite FK from payouts
  CHECK (account_number_enc IS NOT NULL OR disabled_at IS NOT NULL),
  CHECK (verification_status <> 'VERIFIED' OR verified_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS payout_accounts_user_number_uq ON payout_accounts (user_id, account_number_hash) WHERE disabled_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payout_accounts_one_default_uq ON payout_accounts (user_id) WHERE is_default AND disabled_at IS NULL;
-- Same bank account on several users is a fraud signal: indexed, not unique.
CREATE INDEX IF NOT EXISTS payout_accounts_number_hash_idx ON payout_accounts (account_number_hash);
SELECT jk_attach_updated_at('payout_accounts');
INSERT INTO jk_sensitive_columns VALUES ('payout_accounts','holder_name','PII') ON CONFLICT DO NOTHING;

COMMIT;
