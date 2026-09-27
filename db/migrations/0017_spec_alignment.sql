-- 0017_spec_alignment.sql
-- Alignment with docs/00-domain-model.md rev. 2 (§4 edges, §15 secondary FSM tables, §16 rule data):
--   1. currencies.ecb_reference (seeded from currencies.json)
--   2. §16: effective_until is INCLUSIVE -> exclusion constraints use '[]' ranges; in-force helpers
--   3. status_transitions.actor_types (actors of §15 tables; enforced by the service layer)
--   4. kyc_submissions statuses per §15.4 (+ FSM trigger)
--   5. initial-state guards for secondary FSMs (payouts start SCHEDULED, refunds REQUESTED, ...)
-- Irreversible (data-shaping: KYC status remap); correct forward with a new migration.
BEGIN;

-- 1. ------------------------------------------------------------------------
ALTER TABLE currencies ADD COLUMN IF NOT EXISTS ecb_reference boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN currencies.ecb_reference IS
  'true = in the ECB reference-rate set (quotable by the frankfurter FX provider); false = needs another FX source';

-- 2. ------------------------------------------------------------------------
-- §16: a rule is in force on day d iff effective_from <= d <= effective_until (NULL = open-ended).
ALTER TABLE customs_rules DROP CONSTRAINT IF EXISTS customs_rules_no_active_overlap;
ALTER TABLE customs_rules ADD CONSTRAINT customs_rules_no_active_overlap
  EXCLUDE USING gist (code WITH =, daterange(effective_from, effective_until, '[]') WITH &&)
  WHERE (status = 'ACTIVE');
ALTER TABLE restricted_items DROP CONSTRAINT IF EXISTS restricted_items_no_active_overlap;
ALTER TABLE restricted_items ADD CONSTRAINT restricted_items_no_active_overlap
  EXCLUDE USING gist (code WITH =, daterange(effective_from, effective_until, '[]') WITH &&)
  WHERE (status = 'ACTIVE');
COMMENT ON COLUMN customs_rules.effective_until IS 'INCLUSIVE last day in force (§16); NULL = open-ended';
COMMENT ON COLUMN restricted_items.effective_until IS 'INCLUSIVE last day in force (§16); NULL = open-ended';

CREATE OR REPLACE FUNCTION jk_today_wib() RETURNS date
LANGUAGE sql STABLE AS $$ SELECT (now() AT TIME ZONE 'Asia/Jakarta')::date $$;

-- ACTIVE rules in force on p_date (default: today in WIB).
CREATE OR REPLACE FUNCTION customs_rules_in_force(p_date date DEFAULT NULL) RETURNS SETOF customs_rules
LANGUAGE sql STABLE AS $$
  SELECT * FROM customs_rules
   WHERE status = 'ACTIVE'
     AND coalesce(p_date, jk_today_wib()) BETWEEN effective_from AND coalesce(effective_until, 'infinity'::date)
$$;
CREATE OR REPLACE FUNCTION restricted_items_in_force(p_date date DEFAULT NULL) RETURNS SETOF restricted_items
LANGUAGE sql STABLE AS $$
  SELECT * FROM restricted_items
   WHERE status = 'ACTIVE'
     AND coalesce(p_date, jk_today_wib()) BETWEEN effective_from AND coalesce(effective_until, 'infinity'::date)
$$;
-- Views inline the predicate (no user function) so jk_readonly can use them without EXECUTE.
CREATE OR REPLACE VIEW v_customs_rules_in_force AS
SELECT * FROM customs_rules
 WHERE status = 'ACTIVE'
   AND (now() AT TIME ZONE 'Asia/Jakarta')::date BETWEEN effective_from AND coalesce(effective_until, 'infinity'::date);
CREATE OR REPLACE VIEW v_restricted_items_in_force AS
SELECT * FROM restricted_items
 WHERE status = 'ACTIVE'
   AND (now() AT TIME ZONE 'Asia/Jakarta')::date BETWEEN effective_from AND coalesce(effective_until, 'infinity'::date);

-- 3. ------------------------------------------------------------------------
ALTER TABLE status_transitions ADD COLUMN IF NOT EXISTS actor_types text[];
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'status_transitions_actor_types_check') THEN
    ALTER TABLE status_transitions ADD CONSTRAINT status_transitions_actor_types_check
      CHECK (actor_types IS NULL OR (actor_types <@ ARRAY['BUYER','TRAVELER','SYSTEM','ADMIN'] AND cardinality(actor_types) > 0));
  END IF;
END $$;
COMMENT ON COLUMN status_transitions.actor_types IS
  'Actors allowed by docs/00-domain-model.md §15 (checked by the API service layer; the DB enforces the (from,to) pair)';

-- 4. ------------------------------------------------------------------------
-- §15.4: PENDING -> IN_REVIEW -> APPROVED | REJECTED; PENDING/APPROVED -> EXPIRED.
ALTER TABLE kyc_submissions DROP CONSTRAINT IF EXISTS kyc_submissions_status_check;
UPDATE kyc_submissions                               -- legacy values (none expected pre-launch)
   SET status = CASE status WHEN 'RESUBMIT_REQUIRED' THEN 'REJECTED' ELSE 'PENDING' END,
       reviewed_at = CASE WHEN status = 'RESUBMIT_REQUIRED' THEN coalesce(reviewed_at, updated_at) ELSE reviewed_at END
 WHERE status IN ('DRAFT','SUBMITTED','RESUBMIT_REQUIRED');
ALTER TABLE kyc_submissions ADD CONSTRAINT kyc_submissions_status_check
  CHECK (status IN ('PENDING','IN_REVIEW','APPROVED','REJECTED','EXPIRED'));
ALTER TABLE kyc_submissions ALTER COLUMN status SET DEFAULT 'PENDING';
DROP INDEX IF EXISTS kyc_submissions_one_open_uq;
CREATE UNIQUE INDEX kyc_submissions_one_open_uq ON kyc_submissions (user_id, target_level)
  WHERE status IN ('PENDING','IN_REVIEW');
DROP INDEX IF EXISTS kyc_submissions_queue_idx;
CREATE INDEX kyc_submissions_queue_idx ON kyc_submissions (created_at) WHERE status IN ('PENDING','IN_REVIEW');
SELECT jk_attach_fsm('kyc_submissions', 'KYC');

-- 5. ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION jk_fsm_initial() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (NEW.status = ANY (TG_ARGV)) THEN
    RAISE EXCEPTION USING ERRCODE = 'JK422',
      MESSAGE = format('%s must be created with status %s (got %s)', TG_TABLE_NAME, array_to_string(TG_ARGV, ' or '), NEW.status);
  END IF;
  RETURN NEW;
END $$;
ALTER TABLE payouts ALTER COLUMN status SET DEFAULT 'SCHEDULED';
CREATE OR REPLACE TRIGGER trg_fsm_initial BEFORE INSERT ON payouts             FOR EACH ROW EXECUTE FUNCTION jk_fsm_initial('SCHEDULED');
CREATE OR REPLACE TRIGGER trg_fsm_initial BEFORE INSERT ON refunds             FOR EACH ROW EXECUTE FUNCTION jk_fsm_initial('REQUESTED');
CREATE OR REPLACE TRIGGER trg_fsm_initial BEFORE INSERT ON payments            FOR EACH ROW EXECUTE FUNCTION jk_fsm_initial('PENDING');
CREATE OR REPLACE TRIGGER trg_fsm_initial BEFORE INSERT ON price_confirmations FOR EACH ROW EXECUTE FUNCTION jk_fsm_initial('PENDING');
CREATE OR REPLACE TRIGGER trg_fsm_initial BEFORE INSERT ON kyc_submissions     FOR EACH ROW EXECUTE FUNCTION jk_fsm_initial('PENDING');
CREATE OR REPLACE TRIGGER trg_fsm_initial BEFORE INSERT ON quotes              FOR EACH ROW EXECUTE FUNCTION jk_fsm_initial('ACTIVE');
CREATE OR REPLACE TRIGGER trg_fsm_initial BEFORE INSERT ON fx_locks            FOR EACH ROW EXECUTE FUNCTION jk_fsm_initial('ACTIVE');

SELECT jk_apply_grants();

COMMIT;
