-- 0014_privacy_ops.sql
-- Privacy requests (UU PDP), retention policies, anonymize_user(), analytics events,
-- DB operations log (maker-checker), health checks.
BEGIN;

CREATE TABLE IF NOT EXISTS privacy_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id),
  type             text NOT NULL CHECK (type IN ('EXPORT','DELETION','CORRECTION','CONSENT_WITHDRAWAL')),
  status           text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','VERIFYING','IN_PROGRESS','COMPLETED','REJECTED')),
  details          jsonb NOT NULL DEFAULT '{}',
  -- ASSUMPTION: 72h response target (UU PDP 27/2022 uses 3x24h windows for several
  -- data-subject rights). Verify with counsel; the API sets due_at from config.
  due_at           timestamptz NOT NULL DEFAULT now() + interval '72 hours',
  verified_at      timestamptz,
  handled_by       uuid REFERENCES users(id),
  completed_at     timestamptz,
  rejection_reason text,
  export_file_id   uuid REFERENCES files(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'COMPLETED' OR completed_at IS NOT NULL),
  CHECK (status <> 'REJECTED' OR rejection_reason IS NOT NULL),
  CHECK (type <> 'EXPORT' OR status <> 'COMPLETED' OR export_file_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS privacy_requests_open_idx ON privacy_requests (due_at) WHERE status NOT IN ('COMPLETED','REJECTED');
CREATE INDEX IF NOT EXISTS privacy_requests_user_idx ON privacy_requests (user_id);
CREATE INDEX IF NOT EXISTS privacy_requests_handled_by_idx ON privacy_requests (handled_by);
CREATE INDEX IF NOT EXISTS privacy_requests_export_file_idx ON privacy_requests (export_file_id);
SELECT jk_attach_updated_at('privacy_requests');

CREATE TABLE IF NOT EXISTS data_retention_policies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity         text NOT NULL UNIQUE CHECK (entity ~ '^[a-z_]+(\.[a-z_]+)?$'),
  retention_days integer NOT NULL CHECK (retention_days > 0),
  trigger_event  text NOT NULL CHECK (trigger_event IN ('CREATED','EXPIRED','ACCOUNT_CLOSED','TRANSACTION_CLOSED','TRIP_COMPLETED','PUBLISHED','PROCESSED')),
  action         text NOT NULL CHECK (action IN ('DELETE','ANONYMIZE')),
  legal_basis    text NOT NULL,
  is_assumption  boolean NOT NULL DEFAULT true,
  enabled        boolean NOT NULL DEFAULT true,
  notes          text,
  updated_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS data_retention_policies_updated_by_idx ON data_retention_policies (updated_by);
SELECT jk_attach_updated_at('data_retention_policies');

-- ---------------------------------------------------------------------------
-- anonymize_user(): right-to-erasure while keeping financial & audit records.
--
-- Reasoning (document of record: docs/03-database.md §Privacy):
--  * Financial records (transactions, payments, refunds, payouts, ledger, credit
--    entries, quotes) and audit/event logs are retained: tax bookkeeping and
--    dispute/chargeback evidence obligations override erasure (UU PDP allows
--    retention for legal obligations). They reference the user only by UUID; once
--    the users row is scrubbed they are pseudonymous.
--  * Contact data, credentials, sessions, devices links, notifications, chat text,
--    delivery addresses, free-text notes and analytics are removed/scrubbed now.
--  * KYC identity data (encrypted) is scheduled for purge after the retention period
--    in data_retention_policies('identity_records') unless p_purge_kyc = true.
--  * Messages referenced as dispute evidence are kept (legal hold).
--  * Remaining (non-withdrawable) credit is forfeited with an EXPIRY entry.
-- Preconditions: no non-terminal transactions, open disputes, pending payouts or
-- in-flight refunds (JK423).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION anonymize_user(p_user uuid, p_actor uuid DEFAULT NULL, p_purge_kyc boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_user users%ROWTYPE;
  v_blockers jsonb;
  v_kyc_days integer;
  v_purge_at timestamptz;
  v_credit bigint;
  v_counts jsonb := '{}';
  v_n integer;
BEGIN
  SELECT * INTO v_user FROM users WHERE id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'JK404', MESSAGE = format('user %s not found', p_user);
  END IF;
  IF v_user.anonymized_at IS NOT NULL THEN
    RETURN jsonb_build_object('userId', p_user, 'alreadyAnonymized', true);
  END IF;

  SELECT jsonb_strip_nulls(jsonb_build_object(
    'activeTransactions', nullif((SELECT count(*) FROM transactions
                                   WHERE (buyer_id = p_user OR traveler_id = p_user)
                                     AND status NOT IN ('COMPLETED','CANCELLED','REFUNDED')), 0),
    'openDisputes', nullif((SELECT count(*) FROM disputes d JOIN transactions t ON t.id = d.transaction_id
                             WHERE d.status <> 'CLOSED' AND (t.buyer_id = p_user OR t.traveler_id = p_user)), 0),
    'pendingPayouts', nullif((SELECT count(*) FROM payouts
                               WHERE traveler_id = p_user AND status IN ('SCHEDULED','ON_HOLD','PROCESSING')), 0),
    'inflightRefunds', nullif((SELECT count(*) FROM refunds r JOIN transactions t ON t.id = r.transaction_id
                                WHERE t.buyer_id = p_user AND r.status NOT IN ('SUCCEEDED','REJECTED','CANCELLED')), 0)))
    INTO v_blockers;
  IF v_blockers <> '{}'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE = 'JK423',
      MESSAGE = format('user %s cannot be anonymized yet', p_user), DETAIL = v_blockers::text;
  END IF;

  SELECT retention_days INTO v_kyc_days FROM data_retention_policies WHERE entity = 'identity_records' AND enabled;
  v_purge_at := CASE WHEN p_purge_kyc THEN now() ELSE now() + make_interval(days => coalesce(v_kyc_days, 1825)) END;

  -- 1. Profile & contact data
  UPDATE users
     SET email = NULL, email_verified_at = NULL, phone_e164 = NULL, phone_verified_at = NULL,
         password_hash = NULL, display_name = NULL, avatar_file_id = NULL, transaction_email = NULL,
         last_login_at = NULL, suspension_reason = NULL,
         status = 'DELETED', deleted_at = coalesce(deleted_at, now()), anonymized_at = now()
   WHERE id = p_user;

  -- 2. Credentials, sessions, device links, personal settings, inbox
  DELETE FROM auth_identities WHERE user_id = p_user;          GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('authIdentities', v_n);
  DELETE FROM refresh_tokens WHERE user_id = p_user;           GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('refreshTokens', v_n);
  DELETE FROM otp_challenges WHERE user_id = p_user;
  DELETE FROM mfa_recovery_codes WHERE user_id = p_user;
  DELETE FROM mfa_factors WHERE user_id = p_user;
  DELETE FROM user_devices WHERE user_id = p_user;
  DELETE FROM notification_preferences WHERE user_id = p_user;
  DELETE FROM notifications WHERE user_id = p_user;            GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('notifications', v_n);
  DELETE FROM idempotency_keys WHERE user_id = p_user;
  DELETE FROM experiment_assignments WHERE user_id = p_user;
  DELETE FROM analytics_events WHERE user_id = p_user;         GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('analyticsEvents', v_n);
  UPDATE user_roles SET revoked_at = now(), revoked_by = p_actor, reason = 'account anonymized'
   WHERE user_id = p_user AND revoked_at IS NULL;

  -- 3. Bank accounts: keep hash + mask (payout history, fraud dedupe), drop ciphertext & name
  UPDATE payout_accounts
     SET account_number_enc = NULL, holder_name = 'REDACTED', is_default = false,
         disabled_at = coalesce(disabled_at, now())
   WHERE user_id = p_user;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('payoutAccounts', v_n);

  -- 4. KYC: purge now or schedule per retention policy
  IF p_purge_kyc THEN
    DELETE FROM identity_records WHERE user_id = p_user;
  ELSE
    UPDATE identity_records SET purge_after = v_purge_at WHERE user_id = p_user;
  END IF;
  UPDATE kyc_documents SET purge_after = v_purge_at WHERE user_id = p_user AND purged_at IS NULL;
  UPDATE files SET retention_until = v_purge_at WHERE owner_id = p_user AND purpose = 'KYC' AND deleted_at IS NULL;

  -- 5. Personal files (avatar, chat attachments, exports) -> purge job deletes objects
  UPDATE files SET retention_until = now()
   WHERE owner_id = p_user AND purpose IN ('AVATAR','CHAT','EXPORT') AND deleted_at IS NULL;

  -- 6. Free text written by the user
  UPDATE messages m
     SET body = NULL, attachments = '[]', meta = '{}', deleted_at = coalesce(m.deleted_at, now())
   WHERE m.sender_id = p_user
     AND NOT EXISTS (SELECT 1 FROM dispute_evidence de WHERE de.message_id = m.id);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('messagesScrubbed', v_n);
  UPDATE ticket_messages SET body = '[dihapus atas permintaan pengguna]', attachments = '[]' WHERE author_id = p_user;
  UPDATE support_tickets SET subject = '[dihapus]' WHERE user_id = p_user;
  UPDATE ratings SET comment = NULL WHERE rater_id = p_user AND comment IS NOT NULL;
  UPDATE requests SET notes = NULL, extraction = '{}' WHERE buyer_id = p_user;
  UPDATE trips SET notes = NULL WHERE traveler_id = p_user AND notes IS NOT NULL;

  -- 7. Delivery addresses / meetup points / one-time secrets
  UPDATE deliveries d
     SET address_enc = NULL, enc_key_id = NULL, meetup_point = NULL, pin_hash = NULL, qr_token_hash = NULL
    FROM transactions t
   WHERE t.id = d.transaction_id AND t.buyer_id = p_user;

  -- 8. Forfeit remaining JastipKita Credit (non-withdrawable by policy)
  SELECT coalesce(sum(amount_idr), 0) INTO v_credit FROM credit_entries WHERE user_id = p_user;
  IF v_credit > 0 THEN
    INSERT INTO credit_entries (user_id, amount_idr, reason, reference_type, reference_id, note)
    VALUES (p_user, -v_credit, 'EXPIRY', 'account_deletion', p_user, 'forfeited on account anonymization');
  END IF;
  v_counts := v_counts || jsonb_build_object('creditForfeitedIdr', v_credit);

  -- 9. Record (no PII) + notify downstream processors (storage purge, email/push providers)
  PERFORM jk_outbox('user', p_user::text, 'user.anonymized',
                    jsonb_build_object('userId', p_user, 'kycPurgeAt', v_purge_at));
  PERFORM jk_audit(CASE WHEN p_actor IS NULL THEN 'SYSTEM' ELSE 'ADMIN' END, p_actor, 'privacy.user_anonymized',
                   'user', p_user::text, NULL, v_counts,
                   jsonb_build_object('purgeKycNow', p_purge_kyc, 'kycPurgeAt', v_purge_at));
  RETURN jsonb_build_object('userId', p_user, 'anonymizedAt', now(), 'kycPurgeAt', v_purge_at) || v_counts;
END $$;

-- ---------------------------------------------------------------------------
-- Analytics events (high volume; no FK on user_id to keep ingestion cheap and to
-- allow deletion on anonymization). Candidate for monthly partitioning later.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analytics_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_name   text NOT NULL CHECK (event_name ~ '^[a-z][a-z0-9_]*$'),
  user_id      uuid,
  anonymous_id text,
  session_id   text,
  platform     text CHECK (platform IN ('IOS','ANDROID','WEB','ADMIN','SERVER')),
  app_version  text,
  properties   jsonb NOT NULL DEFAULT '{}',
  occurred_at  timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR anonymous_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS analytics_events_name_time_idx ON analytics_events (event_name, occurred_at);
CREATE INDEX IF NOT EXISTS analytics_events_user_idx ON analytics_events (user_id, occurred_at) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS analytics_events_received_brin ON analytics_events USING brin (received_at);

-- ---------------------------------------------------------------------------
-- Ops
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS db_operations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type         text NOT NULL CHECK (type IN ('BACKUP','RESTORE','RESTORE_TEST','EXPORT','IMPORT','MIGRATION','CONNECTION_TEST','SWITCH','ROLLBACK')),
  status       text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','APPROVED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  environment  text NOT NULL DEFAULT 'DEVELOPMENT' CHECK (environment IN ('DEVELOPMENT','STAGING','PRODUCTION')),
  provider     text,                           -- NEON / SUPABASE / RDS / CLOUDSQL / LOCAL
  requested_by uuid REFERENCES users(id),      -- NULL = scheduler
  approved_by  uuid REFERENCES users(id),
  approved_at  timestamptz,
  reason       text,
  params       jsonb NOT NULL DEFAULT '{}',    -- never secrets; secret_ref pointers only
  result       jsonb,
  error        text,
  started_at   timestamptz,
  finished_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT db_operations_maker_checker CHECK (approved_by IS NULL OR approved_by IS DISTINCT FROM requested_by),
  -- destructive operations need a second person before they can run
  CHECK (type NOT IN ('RESTORE','IMPORT','SWITCH','ROLLBACK') OR status IN ('REQUESTED','CANCELLED') OR approved_by IS NOT NULL),
  CHECK (params::text !~* '(password|secret|token)"\s*:\s*"[^"]{6,}')
);
CREATE INDEX IF NOT EXISTS db_operations_recent_idx ON db_operations (type, created_at DESC);
CREATE INDEX IF NOT EXISTS db_operations_requested_by_idx ON db_operations (requested_by);
CREATE INDEX IF NOT EXISTS db_operations_approved_by_idx ON db_operations (approved_by);
SELECT jk_attach_updated_at('db_operations');

CREATE TABLE IF NOT EXISTS app_health_checks (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  component  text NOT NULL CHECK (component ~ '^[A-Z][A-Z0-9_]*$'),   -- DB, API, XENDIT, STORAGE, EMAIL, PUSH, FX, ...
  status     text NOT NULL CHECK (status IN ('UP','DEGRADED','DOWN')),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  is_sandbox boolean NOT NULL DEFAULT true,
  details    jsonb NOT NULL DEFAULT '{}',
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_health_checks_latest_idx ON app_health_checks (component, checked_at DESC);

CREATE OR REPLACE VIEW v_app_health_latest AS
SELECT DISTINCT ON (component) component, status, latency_ms, is_sandbox, details, checked_at
  FROM app_health_checks ORDER BY component, checked_at DESC;

COMMIT;
