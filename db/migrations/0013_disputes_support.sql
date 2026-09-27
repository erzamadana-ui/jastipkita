-- 0013_disputes_support.sql
-- Ratings, disputes (FSM §6), evidence, insurance, support tickets.
BEGIN;

CREATE TABLE IF NOT EXISTS ratings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES transactions(id),
  rater_id       uuid NOT NULL REFERENCES users(id),
  ratee_id       uuid NOT NULL REFERENCES users(id),
  direction      text NOT NULL CHECK (direction IN ('BUYER_TO_TRAVELER','TRAVELER_TO_BUYER')),
  overall        smallint NOT NULL CHECK (overall BETWEEN 1 AND 5),
  communication  smallint CHECK (communication BETWEEN 1 AND 5),
  accuracy       smallint CHECK (accuracy BETWEEN 1 AND 5),
  timeliness     smallint CHECK (timeliness BETWEEN 1 AND 5),
  comment        text CHECK (char_length(comment) <= 2000),
  status         text NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('PUBLISHED','HIDDEN','FLAGGED')),
  weight         numeric(5,4) NOT NULL DEFAULT 1 CHECK (weight BETWEEN 0 AND 1),
  moderation_reason text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transaction_id, rater_id),
  CHECK (rater_id <> ratee_id)
);
CREATE INDEX IF NOT EXISTS ratings_ratee_idx ON ratings (ratee_id, direction, created_at DESC);
CREATE INDEX IF NOT EXISTS ratings_rater_idx ON ratings (rater_id);
SELECT jk_attach_updated_at('ratings');

CREATE TABLE IF NOT EXISTS user_rating_summaries (
  user_id              uuid PRIMARY KEY REFERENCES users(id),
  as_traveler_count    integer NOT NULL DEFAULT 0,
  as_traveler_avg      numeric(3,2),
  as_traveler_weighted numeric(3,2),
  as_buyer_count       integer NOT NULL DEFAULT 0,
  as_buyer_avg         numeric(3,2),
  as_buyer_weighted    numeric(3,2),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION jk_refresh_rating_summary(p_user uuid) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO user_rating_summaries AS s (user_id, as_traveler_count, as_traveler_avg, as_traveler_weighted,
                                         as_buyer_count, as_buyer_avg, as_buyer_weighted, updated_at)
  SELECT p_user,
         count(*) FILTER (WHERE direction = 'BUYER_TO_TRAVELER'),
         round(avg(overall) FILTER (WHERE direction = 'BUYER_TO_TRAVELER'), 2),
         round(sum(overall * weight) FILTER (WHERE direction = 'BUYER_TO_TRAVELER')
               / nullif(sum(weight) FILTER (WHERE direction = 'BUYER_TO_TRAVELER'), 0), 2),
         count(*) FILTER (WHERE direction = 'TRAVELER_TO_BUYER'),
         round(avg(overall) FILTER (WHERE direction = 'TRAVELER_TO_BUYER'), 2),
         round(sum(overall * weight) FILTER (WHERE direction = 'TRAVELER_TO_BUYER')
               / nullif(sum(weight) FILTER (WHERE direction = 'TRAVELER_TO_BUYER'), 0), 2),
         now()
    FROM ratings WHERE ratee_id = p_user AND status = 'PUBLISHED'
  ON CONFLICT (user_id) DO UPDATE SET
    as_traveler_count = EXCLUDED.as_traveler_count, as_traveler_avg = EXCLUDED.as_traveler_avg,
    as_traveler_weighted = EXCLUDED.as_traveler_weighted, as_buyer_count = EXCLUDED.as_buyer_count,
    as_buyer_avg = EXCLUDED.as_buyer_avg, as_buyer_weighted = EXCLUDED.as_buyer_weighted, updated_at = now()
$$;

CREATE OR REPLACE FUNCTION jk_rating_summary_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN PERFORM jk_refresh_rating_summary(OLD.ratee_id); END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN PERFORM jk_refresh_rating_summary(NEW.ratee_id); END IF;
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER trg_rating_summary AFTER INSERT OR UPDATE OR DELETE ON ratings
  FOR EACH ROW EXECUTE FUNCTION jk_rating_summary_trigger();

-- ---------------------------------------------------------------------------
-- Disputes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS disputes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number                text NOT NULL UNIQUE CHECK (number ~ '^DSP-[0-9]{6}-[0-9A-HJKMNP-TV-Z]{6}$'),
  transaction_id        uuid NOT NULL REFERENCES transactions(id),
  opened_by             uuid NOT NULL REFERENCES users(id),
  opened_by_role        text NOT NULL CHECK (opened_by_role IN ('BUYER','TRAVELER','ADMIN')),
  type                  text NOT NULL CHECK (type IN ('ITEM_NOT_RECEIVED','WRONG_ITEM','DAMAGED_ITEM','COUNTERFEIT','PRICE_DISPUTE','DELIVERY_DISPUTE','OTHER')),
  status                text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','EVIDENCE_COLLECTION','UNDER_REVIEW','RESOLVED','APPEALED','CLOSED')),
  description           text NOT NULL CHECK (char_length(description) BETWEEN 10 AND 5000),
  requested_resolution  text CHECK (requested_resolution IN ('REFUND_FULL','REFUND_PARTIAL','NO_REFUND','RETURN_AND_REFUND','OTHER')),
  resolution            text CHECK (resolution IN ('REFUND_FULL','REFUND_PARTIAL','NO_REFUND','RETURN_AND_REFUND','OTHER')),
  resolution_amount_idr bigint CHECK (resolution_amount_idr IS NULL OR resolution_amount_idr >= 0),
  resolution_note       text,
  assignee_id           uuid REFERENCES users(id),
  resolved_by           uuid REFERENCES users(id),
  evidence_due_at       timestamptz,
  sla_due_at            timestamptz,
  resolved_at           timestamptz,
  appealed_at           timestamptz,
  closed_at             timestamptz,
  version               integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('RESOLVED','CLOSED') OR resolution IS NOT NULL OR closed_at IS NOT NULL),
  CHECK (resolution NOT IN ('REFUND_PARTIAL') OR resolution_amount_idr > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS disputes_one_open_per_tx ON disputes (transaction_id) WHERE status <> 'CLOSED';
CREATE INDEX IF NOT EXISTS disputes_tx_idx ON disputes (transaction_id);
CREATE INDEX IF NOT EXISTS disputes_queue_idx ON disputes (status, sla_due_at) WHERE status <> 'CLOSED';
CREATE INDEX IF NOT EXISTS disputes_assignee_id_idx ON disputes (assignee_id, status);
CREATE INDEX IF NOT EXISTS disputes_opened_by_idx ON disputes (opened_by);
CREATE INDEX IF NOT EXISTS disputes_resolved_by_idx ON disputes (resolved_by);
CREATE INDEX IF NOT EXISTS disputes_created_idx ON disputes (created_at);
SELECT jk_attach_updated_at('disputes');
CREATE OR REPLACE TRIGGER trg_assign_number BEFORE INSERT ON disputes
  FOR EACH ROW EXECUTE FUNCTION jk_assign_number('DSP');
CREATE OR REPLACE TRIGGER trg_status_via_function BEFORE INSERT OR UPDATE ON disputes
  FOR EACH ROW EXECUTE FUNCTION jk_status_via_function_only('OPEN');

CREATE TABLE IF NOT EXISTS dispute_transitions (
  from_status text NOT NULL,
  to_status   text NOT NULL,
  actor_types text[] NOT NULL CHECK (actor_types <@ ARRAY['BUYER','TRAVELER','SYSTEM','ADMIN'] AND cardinality(actor_types) > 0),
  description text,
  PRIMARY KEY (from_status, to_status),
  CHECK (from_status IN ('OPEN','EVIDENCE_COLLECTION','UNDER_REVIEW','RESOLVED','APPEALED')),
  CHECK (to_status IN ('OPEN','EVIDENCE_COLLECTION','UNDER_REVIEW','RESOLVED','APPEALED','CLOSED'))
);

CREATE TABLE IF NOT EXISTS dispute_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dispute_id  uuid NOT NULL REFERENCES disputes(id),
  from_status text,
  to_status   text NOT NULL,
  actor_type  text NOT NULL CHECK (actor_type IN ('BUYER','TRAVELER','SYSTEM','ADMIN')),
  actor_id    uuid,
  reason      text,
  meta        jsonb NOT NULL DEFAULT '{}',
  version     integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dispute_events_dispute_idx ON dispute_events (dispute_id, id);
SELECT jk_make_append_only('dispute_events');

CREATE OR REPLACE FUNCTION jk_dispute_created_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO dispute_events (dispute_id, from_status, to_status, actor_type, actor_id, version)
  VALUES (NEW.id, NULL, NEW.status, NEW.opened_by_role, NEW.opened_by, NEW.version);
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER trg_dispute_created_event AFTER INSERT ON disputes
  FOR EACH ROW EXECUTE FUNCTION jk_dispute_created_event();

CREATE OR REPLACE FUNCTION transition_dispute(p_dispute uuid, p_expected_version integer, p_to text, p_actor_type text,
                                              p_actor_id uuid, p_reason text DEFAULT NULL, p_meta jsonb DEFAULT '{}')
RETURNS disputes
LANGUAGE plpgsql AS $$
DECLARE
  v_row disputes%ROWTYPE;
  v_from text;
  v_actors text[];
BEGIN
  SELECT * INTO v_row FROM disputes WHERE id = p_dispute FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'JK404', MESSAGE = format('dispute %s not found', p_dispute);
  END IF;
  IF v_row.version <> p_expected_version THEN
    RAISE EXCEPTION USING ERRCODE = 'JK409',
      MESSAGE = format('dispute %s version conflict: expected %s, current %s', v_row.number, p_expected_version, v_row.version),
      DETAIL = json_build_object('currentVersion', v_row.version, 'currentStatus', v_row.status)::text;
  END IF;
  v_from := v_row.status;
  SELECT actor_types INTO v_actors FROM dispute_transitions WHERE from_status = v_from AND to_status = p_to;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'JK422', MESSAGE = format('illegal dispute transition %s -> %s', v_from, p_to);
  END IF;
  IF NOT (p_actor_type = ANY (v_actors)) THEN
    RAISE EXCEPTION USING ERRCODE = 'JK403',
      MESSAGE = format('actor %s may not move dispute %s -> %s (allowed: %s)', p_actor_type, v_from, p_to, array_to_string(v_actors, ','));
  END IF;

  PERFORM set_config('jk.fsm_ctx', 'disputes:' || p_dispute, true);
  UPDATE disputes
     SET status      = p_to,
         version     = version + 1,
         resolved_at = CASE WHEN p_to = 'RESOLVED' THEN now() ELSE resolved_at END,
         resolved_by = CASE WHEN p_to = 'RESOLVED' THEN p_actor_id ELSE resolved_by END,
         appealed_at = CASE WHEN p_to = 'APPEALED' THEN now() ELSE appealed_at END,
         closed_at   = CASE WHEN p_to = 'CLOSED'   THEN now() ELSE closed_at END
   WHERE id = p_dispute
  RETURNING * INTO v_row;
  PERFORM set_config('jk.fsm_ctx', '', true);

  INSERT INTO dispute_events (dispute_id, from_status, to_status, actor_type, actor_id, reason, meta, version)
  VALUES (p_dispute, v_from, p_to, p_actor_type, p_actor_id, p_reason, coalesce(p_meta, '{}'), v_row.version);
  PERFORM jk_outbox('dispute', p_dispute::text, 'dispute.status_changed',
    jsonb_build_object('disputeId', p_dispute, 'number', v_row.number, 'transactionId', v_row.transaction_id,
                       'from', v_from, 'to', p_to, 'version', v_row.version, 'actorType', p_actor_type, 'actorId', p_actor_id));
  PERFORM jk_audit(p_actor_type, p_actor_id, 'dispute.transition', 'dispute', p_dispute::text,
                   jsonb_build_object('status', v_from, 'version', p_expected_version),
                   jsonb_build_object('status', p_to, 'version', v_row.version, 'resolution', v_row.resolution,
                                      'resolutionAmountIdr', v_row.resolution_amount_idr),
                   jsonb_build_object('number', v_row.number, 'reason', p_reason) || coalesce(p_meta, '{}'));
  RETURN v_row;
END $$;

CREATE TABLE IF NOT EXISTS dispute_evidence (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id   uuid NOT NULL REFERENCES disputes(id),
  submitted_by uuid REFERENCES users(id),
  party        text NOT NULL CHECK (party IN ('BUYER','TRAVELER','ADMIN','SYSTEM')),
  type         text NOT NULL CHECK (type IN ('PHOTO','VIDEO','RECEIPT','CHAT','TRACKING','DELIVERY_PROOF','OTHER')),
  file_id      uuid REFERENCES files(id),
  message_id   uuid REFERENCES messages(id),
  note         text CHECK (char_length(note) <= 4000),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (file_id IS NOT NULL OR message_id IS NOT NULL OR note IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS dispute_evidence_dispute_idx ON dispute_evidence (dispute_id, created_at);
CREATE INDEX IF NOT EXISTS dispute_evidence_submitted_by_idx ON dispute_evidence (submitted_by);
CREATE INDEX IF NOT EXISTS dispute_evidence_file_idx ON dispute_evidence (file_id);
CREATE INDEX IF NOT EXISTS dispute_evidence_message_idx ON dispute_evidence (message_id);
SELECT jk_make_append_only('dispute_evidence');

-- ---------------------------------------------------------------------------
-- Insurance (JastipKita Protection underwriting partner — SANDBOX until contracted)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS insurance_policies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id  uuid NOT NULL REFERENCES transactions(id),
  provider        text NOT NULL CHECK (provider ~ '^[A-Z][A-Z0-9_]*$'),
  provider_env    text NOT NULL DEFAULT 'TEST' CHECK (provider_env IN ('TEST','LIVE')),
  product_code    text NOT NULL,
  coverages       text[] NOT NULL DEFAULT '{}',
  premium_idr     bigint NOT NULL CHECK (premium_idr >= 0),
  sum_insured_idr bigint NOT NULL CHECK (sum_insured_idr > 0),
  status          text NOT NULL DEFAULT 'QUOTED' CHECK (status IN ('QUOTED','ACTIVE','CLAIMED','EXPIRED','CANCELLED')),
  provider_ref    text,
  issued_at       timestamptz,
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS insurance_policies_live_uq ON insurance_policies (transaction_id) WHERE status IN ('ACTIVE','CLAIMED');
CREATE INDEX IF NOT EXISTS insurance_policies_tx_idx ON insurance_policies (transaction_id);
SELECT jk_attach_updated_at('insurance_policies');

CREATE TABLE IF NOT EXISTS insurance_claims (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id     uuid NOT NULL REFERENCES insurance_policies(id),
  dispute_id    uuid REFERENCES disputes(id),
  claimed_idr   bigint NOT NULL CHECK (claimed_idr > 0),
  approved_idr  bigint CHECK (approved_idr IS NULL OR approved_idr >= 0),
  status        text NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','UNDER_REVIEW','APPROVED','REJECTED','PAID')),
  reason        text NOT NULL,
  provider_ref  text,
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  paid_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (approved_idr IS NULL OR approved_idr <= claimed_idr)
);
CREATE INDEX IF NOT EXISTS insurance_claims_policy_idx ON insurance_claims (policy_id);
CREATE INDEX IF NOT EXISTS insurance_claims_dispute_idx ON insurance_claims (dispute_id);
SELECT jk_attach_updated_at('insurance_claims');

-- ---------------------------------------------------------------------------
-- Support
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS support_tickets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number            text NOT NULL UNIQUE CHECK (number ~ '^TKT-[0-9]{6}-[0-9A-HJKMNP-TV-Z]{6}$'),
  user_id           uuid REFERENCES users(id),
  category          text NOT NULL CHECK (category IN ('TRANSACTION','DISPUTE','REFUND','ACCOUNT','PAYMENT','CUSTOMS','OTHER')),
  channel           text NOT NULL DEFAULT 'APP' CHECK (channel IN ('APP','WEB','EMAIL','WHATSAPP','ADMIN')),
  subject           text NOT NULL,
  status            text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PENDING_USER','IN_PROGRESS','RESOLVED','CLOSED')),
  priority          text NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  transaction_id    uuid REFERENCES transactions(id),
  dispute_id        uuid REFERENCES disputes(id),
  assignee_id       uuid REFERENCES users(id),
  sla_due_at        timestamptz,
  first_response_at timestamptz,
  resolved_at       timestamptz,
  closed_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_tickets_queue_idx ON support_tickets (status, priority, sla_due_at) WHERE status NOT IN ('RESOLVED','CLOSED');
CREATE INDEX IF NOT EXISTS support_tickets_user_idx ON support_tickets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS support_tickets_tx_idx ON support_tickets (transaction_id);
CREATE INDEX IF NOT EXISTS support_tickets_dispute_idx ON support_tickets (dispute_id);
CREATE INDEX IF NOT EXISTS support_tickets_assignee_idx ON support_tickets (assignee_id);
SELECT jk_attach_updated_at('support_tickets');
CREATE OR REPLACE TRIGGER trg_assign_number BEFORE INSERT ON support_tickets
  FOR EACH ROW EXECUTE FUNCTION jk_assign_number('TKT');

CREATE TABLE IF NOT EXISTS ticket_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id     uuid NOT NULL REFERENCES support_tickets(id),
  author_id     uuid REFERENCES users(id),
  author_type   text NOT NULL CHECK (author_type IN ('USER','AGENT','SYSTEM')),
  body          text NOT NULL,
  attachments   jsonb NOT NULL DEFAULT '[]',
  internal_note boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT internal_note OR author_type IN ('AGENT','SYSTEM'))
);
CREATE INDEX IF NOT EXISTS ticket_messages_ticket_idx ON ticket_messages (ticket_id, created_at);
CREATE INDEX IF NOT EXISTS ticket_messages_author_idx ON ticket_messages (author_id);
INSERT INTO jk_sensitive_columns VALUES ('ticket_messages','body','private support conversation') ON CONFLICT DO NOTHING;

COMMIT;
