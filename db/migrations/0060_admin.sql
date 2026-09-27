-- 0060_admin.sql
-- Admin module group (range 0060-0069):
--   1. admin_role_requests: maker-checker for PRIVILEGED role grants (SUPER_ADMIN, FINANCE_SUPER_ADMIN):
--      requester (rbac.manage + fresh MFA) != approver (SUPER_ADMIN + fresh MFA) != subject
--   2. admin_kpi_snapshots: one row per WIB day written by the daily KPI snapshot job
--   3. admin_ops_alerts: alert lifecycle (OPEN -> RESOLVED) maintained by the alert evaluation job
--   4. db_operation_steps: the 8-step migration workflow checklist attached to db_operations(type MIGRATION)
--   5. payouts.held_by / held_at / released_by / released_at: hold/release bookkeeping (release approver != holder)
-- Forward-only, idempotent (re-applied raw by db/scripts/test-db.sh). Additive only.
BEGIN;

-- 1. ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_role_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id),
  role_code        text NOT NULL REFERENCES roles(code) CHECK (role_code IN ('SUPER_ADMIN','FINANCE_SUPER_ADMIN')),
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
  CHECK (requested_by <> user_id),                                  -- nobody requests a privileged role for themself
  CONSTRAINT admin_role_requests_maker_checker
    CHECK (approved_by IS NULL OR (approved_by <> requested_by AND approved_by <> user_id)),
  CHECK (status <> 'APPLIED' OR (approved_by IS NOT NULL AND approver_mfa_at IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (status <> 'REJECTED' OR (rejected_by IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS admin_role_requests_one_pending_uq ON admin_role_requests (user_id, role_code) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS admin_role_requests_user_idx ON admin_role_requests (user_id);
CREATE INDEX IF NOT EXISTS admin_role_requests_role_code_idx ON admin_role_requests (role_code);
CREATE INDEX IF NOT EXISTS admin_role_requests_requested_by_idx ON admin_role_requests (requested_by);
CREATE INDEX IF NOT EXISTS admin_role_requests_approved_by_idx ON admin_role_requests (approved_by);
CREATE INDEX IF NOT EXISTS admin_role_requests_rejected_by_idx ON admin_role_requests (rejected_by);
CREATE INDEX IF NOT EXISTS admin_role_requests_pending_idx ON admin_role_requests (expires_at) WHERE status = 'PENDING';
SELECT jk_attach_updated_at('admin_role_requests');

-- Guard: history is immutable; the requester must hold rbac.manage with a fresh MFA step-up; the approver
-- must be a different ACTIVE SUPER_ADMIN (rbac.manage) with a fresh MFA step-up (15 minutes).
CREATE OR REPLACE FUNCTION jk_admin_role_request_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_mutable constant text[] := ARRAY['status','approved_by','approver_mfa_at','rejected_by','decision_note','decided_at','updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = 'JK001', MESSAGE = 'admin_role_requests is append-only history';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING' OR NEW.approved_by IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'JK422', MESSAGE = 'role request must be created as PENDING without approver';
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
    RAISE EXCEPTION USING ERRCODE = 'JK001', MESSAGE = format('role request %s is %s and immutable', OLD.id, OLD.status);
  END IF;
  IF (to_jsonb(OLD) - v_mutable) IS DISTINCT FROM (to_jsonb(NEW) - v_mutable) THEN
    RAISE EXCEPTION USING ERRCODE = 'JK001', MESSAGE = 'role request content is immutable';
  END IF;
  IF NEW.status = 'APPLIED' THEN
    IF NOT (jk_user_has_role(NEW.approved_by, 'SUPER_ADMIN') AND jk_user_has_permission(NEW.approved_by, 'rbac.manage')) THEN
      RAISE EXCEPTION USING ERRCODE = 'JK403', MESSAGE = 'approver must be an active SUPER_ADMIN with rbac.manage';
    END IF;
    IF NEW.approver_mfa_at IS NULL OR NEW.approver_mfa_at < now() - interval '15 minutes' THEN
      RAISE EXCEPTION USING ERRCODE = 'JK403', MESSAGE = 'approver MFA step-up is stale (> 15 minutes)';
    END IF;
    IF OLD.expires_at <= now() THEN
      RAISE EXCEPTION USING ERRCODE = 'JK422', MESSAGE = 'role request has expired';
    END IF;
  END IF;
  IF NEW.status IN ('APPLIED','REJECTED','CANCELLED') THEN NEW.decided_at := coalesce(NEW.decided_at, now()); END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER trg_admin_role_request_guard BEFORE INSERT OR UPDATE OR DELETE ON admin_role_requests
  FOR EACH ROW EXECUTE FUNCTION jk_admin_role_request_guard();

-- 2. ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_kpi_snapshots (
  day         date PRIMARY KEY,                 -- WIB calendar day the metrics describe
  metrics     jsonb NOT NULL CHECK (jsonb_typeof(metrics) = 'object'),
  computed_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
SELECT jk_attach_updated_at('admin_kpi_snapshots');

-- 3. ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_ops_alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]*$'),
  severity        text NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  value           numeric,
  threshold       numeric,
  message         text NOT NULL,
  details         jsonb NOT NULL DEFAULT '{}',
  occurrences     integer NOT NULL DEFAULT 1 CHECK (occurrences > 0),
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  acknowledged_by uuid REFERENCES users(id),
  acknowledged_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'RESOLVED' OR resolved_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS admin_ops_alerts_one_open_uq ON admin_ops_alerts (code) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS admin_ops_alerts_recent_idx ON admin_ops_alerts (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS admin_ops_alerts_acknowledged_by_idx ON admin_ops_alerts (acknowledged_by);
SELECT jk_attach_updated_at('admin_ops_alerts');

-- 4. ------------------------------------------------------------------------
-- Migration workflow (DB & Infra Center). The DDL itself runs from CI (db/scripts/migrate.sh); the admin
-- UI only tracks, approves and records each step. Evidence holds links/ids (CI run, backup id), never secrets.
CREATE TABLE IF NOT EXISTS db_operation_steps (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id      uuid NOT NULL REFERENCES db_operations(id),
  step_no           smallint NOT NULL CHECK (step_no BETWEEN 1 AND 8),
  step              text NOT NULL CHECK (step IN ('PRE_CHECK','BACKUP','SCHEMA_MIGRATION','DATA_MIGRATION','VALIDATION','SWITCH','MONITORING','ROLLBACK')),
  status            text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DONE','SKIPPED','FAILED')),
  checklist         jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(checklist) = 'array'),
  requires_approval boolean NOT NULL DEFAULT false,
  notes             text CHECK (char_length(notes) <= 4000),
  evidence          jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(evidence) = 'object'),
  completed_by      uuid REFERENCES users(id),
  completed_at      timestamptz,
  approved_by       uuid REFERENCES users(id),
  approved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_id, step),
  UNIQUE (operation_id, step_no),
  CONSTRAINT db_operation_steps_maker_checker CHECK (approved_by IS NULL OR approved_by IS DISTINCT FROM completed_by),
  CHECK (status = 'PENDING' OR completed_at IS NOT NULL),
  CHECK (evidence::text !~* '(password|secret|token)"\s*:\s*"[^"]{6,}')
);
CREATE INDEX IF NOT EXISTS db_operation_steps_operation_idx ON db_operation_steps (operation_id, step_no);
CREATE INDEX IF NOT EXISTS db_operation_steps_completed_by_idx ON db_operation_steps (completed_by);
CREATE INDEX IF NOT EXISTS db_operation_steps_approved_by_idx ON db_operation_steps (approved_by);
SELECT jk_attach_updated_at('db_operation_steps');

-- 5. ------------------------------------------------------------------------
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS held_by uuid REFERENCES users(id);
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS held_at timestamptz;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS released_by uuid REFERENCES users(id);
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS released_at timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payouts_hold_release_maker_checker') THEN
    ALTER TABLE payouts ADD CONSTRAINT payouts_hold_release_maker_checker
      CHECK (released_by IS NULL OR released_by IS DISTINCT FROM held_by);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS payouts_held_by_idx ON payouts (held_by);
CREATE INDEX IF NOT EXISTS payouts_released_by_idx ON payouts (released_by);
COMMENT ON COLUMN payouts.held_by IS 'Admin who put the payout ON_HOLD (NULL = system hold). The releaser must be a different admin.';

-- Admin queues
CREATE INDEX IF NOT EXISTS messages_hidden_idx ON messages (moderated_at) WHERE moderation_status = 'HIDDEN';
CREATE INDEX IF NOT EXISTS payouts_status_idx ON payouts (status, created_at DESC);

SELECT jk_apply_grants();

COMMIT;
