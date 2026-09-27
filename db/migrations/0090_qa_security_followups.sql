-- 0090_qa_security_followups.sql
-- QA findings 2026-09-28 (docs/checklists/test-scenarios.md) and open items of docs/security/review-2026-09.md — range 0090-0099.
--   SEC-12: refund-destination / payout-account hijack after session takeover.
--           * otp_challenges gains purpose SENSITIVE_ACTION, bound to (action, target_id): a step-up OTP to the user's
--             verified phone/e-mail, valid 10 minutes, single use (consumed_at), attempts capped like every OTP.
--           * refund_destinations: holder name ≠ verified KYC identity name (user ≥ L3) → PENDING_REVIEW (never paid
--             out until a FINANCE reviewer approves) + review bookkeeping; REJECTED = reviewer refused the account.
--   SEC-13: TOTP enrollment trust-on-first-use window.
--           * refresh_tokens.auth_method / session_started_at: enrollment only from a session created ≤ 15 minutes ago
--             by an OTP login (copied forward on rotation, like mfa_verified_at).
--           * mfa_factors.enroll_session_id: an unconfirmed factor can only be confirmed / replaced by the same session.
--           * admin_mfa_reset_requests: a CONFIRMED factor is reset only by maker-checker
--             (requester rbac.manage + fresh MFA ≠ approver, an ACTIVE SUPER_ADMIN with fresh MFA ≠ subject).
-- Forward-only, idempotent (re-applied raw by db/scripts/test-db.sh). Additive only.
BEGIN;

-- SEC-12 ----------------------------------------------------------------------------------------------------
ALTER TABLE otp_challenges DROP CONSTRAINT IF EXISTS otp_challenges_purpose_check;
ALTER TABLE otp_challenges ADD CONSTRAINT otp_challenges_purpose_check
  CHECK (purpose IN ('REGISTER','LOGIN','VERIFY_PHONE','VERIFY_EMAIL','RESET_PASSWORD','STEP_UP','CHANGE_PHONE','CHANGE_EMAIL',
                     'DELIVERY','SENSITIVE_ACTION'));
ALTER TABLE otp_challenges ADD COLUMN IF NOT EXISTS action text;
ALTER TABLE otp_challenges ADD COLUMN IF NOT EXISTS target_id text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'otp_challenges_sensitive_action_chk') THEN
    ALTER TABLE otp_challenges ADD CONSTRAINT otp_challenges_sensitive_action_chk
      CHECK (purpose <> 'SENSITIVE_ACTION'
             OR (user_id IS NOT NULL AND action ~ '^[A-Z][A-Z_]{2,63}$' AND target_id IS NOT NULL AND char_length(target_id) BETWEEN 1 AND 128));
  END IF;
END $$;
COMMENT ON COLUMN otp_challenges.action IS 'SENSITIVE_ACTION only: the action the step-up authorizes (e.g. REFUND_DESTINATION_SET).';
COMMENT ON COLUMN otp_challenges.target_id IS 'SENSITIVE_ACTION only: the entity the step-up is bound to (refund id, payout account id, user id).';

ALTER TABLE refund_destinations DROP CONSTRAINT IF EXISTS refund_destinations_validation_status_check;
ALTER TABLE refund_destinations ADD CONSTRAINT refund_destinations_validation_status_check
  CHECK (validation_status IN ('VALID','INVALID','UNAVAILABLE','PENDING_REVIEW','REJECTED'));
ALTER TABLE refund_destinations ADD COLUMN IF NOT EXISTS name_match text;
ALTER TABLE refund_destinations ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES users(id);
ALTER TABLE refund_destinations ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE refund_destinations ADD COLUMN IF NOT EXISTS review_note text;
ALTER TABLE refund_destinations ADD COLUMN IF NOT EXISTS step_up_challenge_id uuid; -- evidence only (OTP rows are purged)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refund_destinations_name_match_chk') THEN
    ALTER TABLE refund_destinations ADD CONSTRAINT refund_destinations_name_match_chk
      CHECK (name_match IS NULL OR name_match IN ('MATCH','MISMATCH','NO_IDENTITY'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refund_destinations_review_chk') THEN
    ALTER TABLE refund_destinations ADD CONSTRAINT refund_destinations_review_chk
      CHECK (validation_status <> 'REJECTED' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS refund_destinations_reviewed_by_idx ON refund_destinations (reviewed_by);
CREATE INDEX IF NOT EXISTS refund_destinations_pending_review_idx ON refund_destinations (created_at) WHERE validation_status = 'PENDING_REVIEW';

-- SEC-13 ----------------------------------------------------------------------------------------------------
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS auth_method text;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS session_started_at timestamptz;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refresh_tokens_auth_method_chk') THEN
    ALTER TABLE refresh_tokens ADD CONSTRAINT refresh_tokens_auth_method_chk
      CHECK (auth_method IS NULL OR auth_method IN ('OTP','GOOGLE','APPLE'));
  END IF;
END $$;
COMMENT ON COLUMN refresh_tokens.auth_method IS 'Primary login method of the session family (OTP/GOOGLE/APPLE); NULL = legacy. Copied on rotation (SEC-13).';
COMMENT ON COLUMN refresh_tokens.session_started_at IS 'When the session family was created by a login; copied on rotation. TOTP enrollment needs ≤ 15 min (SEC-13).';

ALTER TABLE mfa_factors ADD COLUMN IF NOT EXISTS enroll_session_id uuid;
COMMENT ON COLUMN mfa_factors.enroll_session_id IS 'Session family that started the enrollment; only it may confirm or replace an unconfirmed factor (SEC-13).';

CREATE TABLE IF NOT EXISTS admin_mfa_reset_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id),
  factor_id        uuid REFERENCES mfa_factors(id) ON DELETE SET NULL,
  reason           text NOT NULL CHECK (char_length(reason) >= 10),
  requested_by     uuid NOT NULL REFERENCES users(id),
  requester_mfa_at timestamptz NOT NULL,
  approved_by      uuid REFERENCES users(id),
  approver_mfa_at  timestamptz,
  rejected_by      uuid REFERENCES users(id),
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPLIED','REJECTED','EXPIRED','CANCELLED')),
  decision_note    text,
  decided_at       timestamptz,
  expires_at       timestamptz NOT NULL DEFAULT now() + interval '72 hours',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (requested_by <> user_id),                                   -- nobody resets their own authenticator
  CONSTRAINT admin_mfa_reset_requests_maker_checker
    CHECK (approved_by IS NULL OR (approved_by <> requested_by AND approved_by <> user_id)),
  CHECK (status <> 'APPLIED' OR (approved_by IS NOT NULL AND approver_mfa_at IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (status <> 'REJECTED' OR (rejected_by IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS admin_mfa_reset_requests_one_pending_uq ON admin_mfa_reset_requests (user_id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS admin_mfa_reset_requests_user_idx ON admin_mfa_reset_requests (user_id);
CREATE INDEX IF NOT EXISTS admin_mfa_reset_requests_factor_idx ON admin_mfa_reset_requests (factor_id);
CREATE INDEX IF NOT EXISTS admin_mfa_reset_requests_requested_by_idx ON admin_mfa_reset_requests (requested_by);
CREATE INDEX IF NOT EXISTS admin_mfa_reset_requests_approved_by_idx ON admin_mfa_reset_requests (approved_by);
CREATE INDEX IF NOT EXISTS admin_mfa_reset_requests_rejected_by_idx ON admin_mfa_reset_requests (rejected_by);
SELECT jk_attach_updated_at('admin_mfa_reset_requests');

-- Guard (mirrors admin_role_requests, 0060): history immutable; requester holds rbac.manage with a fresh MFA; the
-- approver is a different ACTIVE SUPER_ADMIN with a fresh MFA step-up (15 minutes). The API checks the same first.
CREATE OR REPLACE FUNCTION jk_admin_mfa_reset_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_mutable constant text[] := ARRAY['status','approved_by','approver_mfa_at','rejected_by','decision_note','decided_at','updated_at','factor_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = 'JK001', MESSAGE = 'admin_mfa_reset_requests is append-only history';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING' OR NEW.approved_by IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'JK422', MESSAGE = 'MFA reset request must be created as PENDING without approver';
    END IF;
    IF NOT jk_user_has_permission(NEW.requested_by, 'rbac.manage') THEN
      RAISE EXCEPTION USING ERRCODE = 'JK403', MESSAGE = 'requester lacks rbac.manage';
    END IF;
    IF NEW.requester_mfa_at < now() - interval '15 minutes' OR NEW.requester_mfa_at > now() + interval '1 minute' THEN
      RAISE EXCEPTION USING ERRCODE = 'JK403', MESSAGE = 'requester MFA step-up is stale (> 15 minutes)';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION USING ERRCODE = 'JK001', MESSAGE = format('MFA reset request %s is %s and immutable', OLD.id, OLD.status);
  END IF;
  IF (to_jsonb(OLD) - v_mutable) IS DISTINCT FROM (to_jsonb(NEW) - v_mutable) THEN
    RAISE EXCEPTION USING ERRCODE = 'JK001', MESSAGE = 'only the decision columns of an MFA reset request may change';
  END IF;
  IF NEW.status = 'APPLIED' THEN
    IF NOT (jk_user_has_role(NEW.approved_by, 'SUPER_ADMIN') AND jk_user_has_permission(NEW.approved_by, 'rbac.manage')) THEN
      RAISE EXCEPTION USING ERRCODE = 'JK403', MESSAGE = 'approver must be an active SUPER_ADMIN with rbac.manage';
    END IF;
    IF NEW.approver_mfa_at IS NULL OR NEW.approver_mfa_at < now() - interval '15 minutes' THEN
      RAISE EXCEPTION USING ERRCODE = 'JK403', MESSAGE = 'approver MFA step-up is stale (> 15 minutes)';
    END IF;
    IF OLD.expires_at <= now() THEN
      RAISE EXCEPTION USING ERRCODE = 'JK422', MESSAGE = 'MFA reset request has expired';
    END IF;
  END IF;
  IF NEW.status IN ('APPLIED','REJECTED','CANCELLED') THEN NEW.decided_at := coalesce(NEW.decided_at, now()); END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER trg_admin_mfa_reset_guard BEFORE INSERT OR UPDATE OR DELETE ON admin_mfa_reset_requests
  FOR EACH ROW EXECUTE FUNCTION jk_admin_mfa_reset_guard();

-- Runtime privileges: the history is never deleted by the app (the guard refuses it anyway).
INSERT INTO jk_grant_policies (table_name, app_access, readonly_access, reason)
VALUES ('admin_mfa_reset_requests', 'NO_DELETE', 'AUTO', 'maker-checker history (SEC-13)')
ON CONFLICT (table_name) DO UPDATE SET app_access = EXCLUDED.app_access, reason = EXCLUDED.reason;
SELECT jk_apply_grants();

COMMIT;
