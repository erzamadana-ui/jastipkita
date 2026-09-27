-- 0011_trust_risk.sql
-- Trust score (current + append-only history + maker-checker overrides),
-- risk assessments & manual reviews, monthly limit usage view.
BEGIN;

CREATE TABLE IF NOT EXISTS trust_score_overrides (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id),
  previous_score  smallint NOT NULL CHECK (previous_score BETWEEN 0 AND 100),
  new_score       smallint NOT NULL CHECK (new_score BETWEEN 0 AND 100),
  reason          text NOT NULL CHECK (char_length(reason) >= 10),
  valid_until     timestamptz,                 -- NULL = until next manual change
  requested_by    uuid NOT NULL REFERENCES users(id),
  requested_at    timestamptz NOT NULL DEFAULT now(),
  approved_by     uuid REFERENCES users(id),
  rejected_by     uuid REFERENCES users(id),
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','APPLIED','EXPIRED')),
  decision_note   text,
  decided_at      timestamptz,
  applied_at      timestamptz,
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '72 hours',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trust_overrides_maker_checker CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CHECK (requested_by <> user_id),               -- nobody overrides their own score
  CHECK (approved_by IS NULL OR approved_by <> user_id),
  CHECK (status NOT IN ('APPROVED','APPLIED') OR (approved_by IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (status <> 'REJECTED' OR rejected_by IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS trust_overrides_user_idx ON trust_score_overrides (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trust_overrides_requested_by_idx ON trust_score_overrides (requested_by);
CREATE INDEX IF NOT EXISTS trust_overrides_approved_by_idx ON trust_score_overrides (approved_by);
CREATE INDEX IF NOT EXISTS trust_overrides_rejected_by_idx ON trust_score_overrides (rejected_by);
CREATE INDEX IF NOT EXISTS trust_overrides_pending_idx ON trust_score_overrides (expires_at) WHERE status = 'PENDING';
SELECT jk_attach_updated_at('trust_score_overrides');

CREATE OR REPLACE FUNCTION jk_trust_override_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_mutable constant text[] := ARRAY['status','approved_by','rejected_by','decision_note','decided_at','applied_at','updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = 'JK001', MESSAGE = 'trust_score_overrides is append-only history';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING' OR NEW.approved_by IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'JK422', MESSAGE = 'trust override must be created as PENDING without approver';
    END IF;
    IF NOT jk_user_has_permission(NEW.requested_by, 'trust.override.request') THEN
      RAISE EXCEPTION USING ERRCODE = 'JK403', MESSAGE = 'requester lacks trust.override.request';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('APPLIED','REJECTED','EXPIRED') THEN
    RAISE EXCEPTION USING ERRCODE = 'JK001', MESSAGE = format('trust override %s is %s and immutable', OLD.id, OLD.status);
  END IF;
  IF (to_jsonb(OLD) - v_mutable) IS DISTINCT FROM (to_jsonb(NEW) - v_mutable) THEN
    RAISE EXCEPTION USING ERRCODE = 'JK001', MESSAGE = 'trust override request content is immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'PENDING'  AND NEW.status IN ('APPROVED','REJECTED','EXPIRED'))
         OR (OLD.status = 'APPROVED' AND NEW.status IN ('APPLIED','EXPIRED'))) THEN
      RAISE EXCEPTION USING ERRCODE = 'JK422', MESSAGE = format('illegal trust override transition %s -> %s', OLD.status, NEW.status);
    END IF;
    IF NEW.status = 'APPROVED' AND NOT jk_user_has_permission(NEW.approved_by, 'trust.override.approve') THEN
      RAISE EXCEPTION USING ERRCODE = 'JK403', MESSAGE = 'approver lacks trust.override.approve';
    END IF;
    IF NEW.status IN ('APPROVED','REJECTED') THEN NEW.decided_at := coalesce(NEW.decided_at, now()); END IF;
    IF NEW.status = 'APPLIED' AND coalesce(current_setting('jk.fsm_ctx', true), '') <> 'trust_score_overrides:' || OLD.id THEN
      RAISE EXCEPTION USING ERRCODE = 'JK422', MESSAGE = 'use apply_trust_score_override() to apply';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER trg_trust_override_guard BEFORE INSERT OR UPDATE OR DELETE ON trust_score_overrides
  FOR EACH ROW EXECUTE FUNCTION jk_trust_override_guard();

CREATE TABLE IF NOT EXISTS trust_scores (
  user_id        uuid PRIMARY KEY REFERENCES users(id),
  score          smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
  components     jsonb NOT NULL DEFAULT '{}',
  computed_at    timestamptz NOT NULL DEFAULT now(),
  version        integer NOT NULL DEFAULT 1,       -- trust.weights config version used
  override_id    uuid REFERENCES trust_score_overrides(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trust_scores_override_idx ON trust_scores (override_id);
CREATE INDEX IF NOT EXISTS trust_scores_score_idx ON trust_scores (score);
SELECT jk_attach_updated_at('trust_scores');

CREATE TABLE IF NOT EXISTS trust_score_history (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id),
  score          smallint NOT NULL,
  previous_score smallint,
  components     jsonb NOT NULL DEFAULT '{}',
  source         text NOT NULL CHECK (source IN ('RECOMPUTE','OVERRIDE','INITIAL')),
  config_version integer,
  override_id    uuid REFERENCES trust_score_overrides(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trust_score_history_user_idx ON trust_score_history (user_id, id DESC);
CREATE INDEX IF NOT EXISTS trust_score_history_override_idx ON trust_score_history (override_id);
SELECT jk_make_append_only('trust_score_history');

-- Keeps history + users.trust_score in sync with trust_scores.
CREATE OR REPLACE FUNCTION jk_trust_score_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.score = OLD.score AND NEW.components = OLD.components
     AND NEW.override_id IS NOT DISTINCT FROM OLD.override_id THEN
    RETURN NULL;
  END IF;
  INSERT INTO trust_score_history (user_id, score, previous_score, components, source, config_version, override_id)
  VALUES (NEW.user_id, NEW.score, CASE WHEN TG_OP = 'UPDATE' THEN OLD.score END, NEW.components,
          CASE WHEN NEW.override_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.override_id IS DISTINCT FROM OLD.override_id)
               THEN 'OVERRIDE' WHEN TG_OP = 'INSERT' THEN 'INITIAL' ELSE 'RECOMPUTE' END,
          NEW.version, NEW.override_id);
  UPDATE users SET trust_score = NEW.score WHERE id = NEW.user_id AND trust_score <> NEW.score;
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER trg_trust_score_sync AFTER INSERT OR UPDATE ON trust_scores
  FOR EACH ROW EXECUTE FUNCTION jk_trust_score_sync();

CREATE OR REPLACE FUNCTION apply_trust_score_override(p_override uuid, p_actor uuid)
RETURNS trust_scores
LANGUAGE plpgsql AS $$
DECLARE o trust_score_overrides%ROWTYPE; t trust_scores%ROWTYPE;
BEGIN
  SELECT * INTO o FROM trust_score_overrides WHERE id = p_override FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'JK404', MESSAGE = format('trust override %s not found', p_override); END IF;
  IF o.status <> 'APPROVED' OR o.expires_at <= now() THEN
    RAISE EXCEPTION USING ERRCODE = 'JK422', MESSAGE = format('trust override %s is %s (expires %s)', p_override, o.status, o.expires_at);
  END IF;
  INSERT INTO trust_scores (user_id, score, components, computed_at, override_id)
  VALUES (o.user_id, o.new_score, jsonb_build_object('override', jsonb_build_object('reason', o.reason, 'validUntil', o.valid_until)),
          now(), o.id)
  ON CONFLICT (user_id) DO UPDATE
     SET score = EXCLUDED.score, components = trust_scores.components || EXCLUDED.components,
         computed_at = now(), override_id = EXCLUDED.override_id
  RETURNING * INTO t;
  PERFORM set_config('jk.fsm_ctx', 'trust_score_overrides:' || o.id, true);
  UPDATE trust_score_overrides SET status = 'APPLIED', applied_at = now() WHERE id = o.id;
  PERFORM set_config('jk.fsm_ctx', '', true);
  PERFORM jk_audit('ADMIN', p_actor, 'trust.override_applied', 'user', o.user_id::text,
                   jsonb_build_object('score', o.previous_score), jsonb_build_object('score', o.new_score),
                   jsonb_build_object('overrideId', o.id, 'requestedBy', o.requested_by, 'approvedBy', o.approved_by, 'reason', o.reason));
  RETURN t;
END $$;

-- ---------------------------------------------------------------------------
-- Risk
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS risk_assessments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type  text NOT NULL CHECK (subject_type IN ('USER','TRANSACTION','PAYMENT','REFERRAL','REFUND','PURCHASE_PROOF','TRIP')),
  subject_id    uuid NOT NULL,
  score         smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
  decision      text NOT NULL CHECK (decision IN ('ALLOW','REVIEW','HOLD','BLOCK')),
  reasons       jsonb NOT NULL DEFAULT '[]',
  signals       jsonb NOT NULL DEFAULT '{}',
  rules_version text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS risk_assessments_subject_idx ON risk_assessments (subject_type, subject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS risk_assessments_decision_idx ON risk_assessments (decision, created_at DESC) WHERE decision <> 'ALLOW';
SELECT jk_make_append_only('risk_assessments');

CREATE TABLE IF NOT EXISTS risk_reviews (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id uuid NOT NULL REFERENCES risk_assessments(id),
  subject_type  text NOT NULL,
  subject_id    uuid NOT NULL,
  status        text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_REVIEW','CLEARED','CONFIRMED_FRAUD')),
  assignee_id   uuid REFERENCES users(id),
  notes         text,
  resolved_by   uuid REFERENCES users(id),
  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('CLEARED','CONFIRMED_FRAUD') OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS risk_reviews_open_idx ON risk_reviews (status, created_at) WHERE status IN ('OPEN','IN_REVIEW');
CREATE INDEX IF NOT EXISTS risk_reviews_assessment_idx ON risk_reviews (assessment_id);
CREATE INDEX IF NOT EXISTS risk_reviews_assignee_idx ON risk_reviews (assignee_id);
CREATE INDEX IF NOT EXISTS risk_reviews_resolved_by_idx ON risk_reviews (resolved_by);
CREATE INDEX IF NOT EXISTS risk_reviews_subject_idx ON risk_reviews (subject_type, subject_id);
SELECT jk_attach_updated_at('risk_reviews');

-- Monthly usage against limits.transaction.monthly*MaxIdr (calendar month in WIB).
-- Counted from the moment money is requested (AWAITING_PAYMENT onward), excluding
-- transactions that ended CANCELLED or REFUNDED.
CREATE OR REPLACE VIEW v_transaction_limits_usage AS
WITH tx AS (
  SELECT t.buyer_id, t.traveler_id, coalesce(t.total_idr, 0) AS amount_idr,
         date_trunc('month', t.created_at AT TIME ZONE 'Asia/Jakarta')::date AS month_wib
    FROM transactions t
   WHERE t.status NOT IN ('REQUEST_CREATED','MATCHED','CANCELLED','REFUNDED')
)
SELECT buyer_id AS user_id, 'BUYER'::text AS role, month_wib, count(*) AS tx_count, sum(amount_idr) AS amount_idr
  FROM tx GROUP BY buyer_id, month_wib
UNION ALL
SELECT traveler_id, 'TRAVELER', month_wib, count(*), sum(amount_idr)
  FROM tx WHERE traveler_id IS NOT NULL GROUP BY traveler_id, month_wib;

COMMIT;
