-- 0008_transactions.sql
-- Transactions (FSM §4, optimistic locking), FX, quotes & price lines (§10),
-- price confirmations (§5), purchase proofs, customs declarations, deliveries (§11).
BEGIN;

CREATE TABLE IF NOT EXISTS transactions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number               text NOT NULL UNIQUE CHECK (number ~ '^JK-[0-9]{6}-[0-9A-HJKMNP-TV-Z]{6}$'),
  request_id           uuid NOT NULL,
  trip_id              uuid,
  offer_id             uuid,
  buyer_id             uuid NOT NULL REFERENCES users(id),
  traveler_id          uuid REFERENCES users(id),
  status               text NOT NULL DEFAULT 'REQUEST_CREATED' CHECK (status IN (
                         'REQUEST_CREATED','MATCHED','AWAITING_PAYMENT','PAYMENT_SECURED','PRICE_CHANGE_PENDING',
                         'PURCHASE_APPROVED','PURCHASED','TRAVELING','ARRIVED','CUSTOMS_PROCESS','READY_FOR_HANDOVER',
                         'OUT_FOR_DELIVERY','DELIVERED','BUYER_CONFIRMED','COMPLETED','CANCELLED','DISPUTED',
                         'REFUND_PENDING','REFUNDED')),
  active_quote_id      uuid,                            -- FK added after quotes
  item_currency        char(3) REFERENCES currencies(code),
  quantity             integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  total_idr            bigint CHECK (total_idr IS NULL OR total_idr >= 0),
  secured_idr          bigint NOT NULL DEFAULT 0 CHECK (secured_idr >= 0),
  delivery_method      text CHECK (delivery_method IN ('MEETUP','COURIER','PARTNER_LOGISTICS')),
  purchase_deadline    timestamptz,
  auto_confirm_at      timestamptz,
  status_changed_at    timestamptz NOT NULL DEFAULT now(),
  delivered_at         timestamptz,
  disputed_at          timestamptz,
  completed_at         timestamptz,
  refunded_at          timestamptz,
  cancelled_at         timestamptz,
  cancel_reason        text,
  cancelled_by         uuid REFERENCES users(id),
  cancelled_by_type    text CHECK (cancelled_by_type IN ('BUYER','TRAVELER','SYSTEM','ADMIN')),
  cancellation_stage   text CHECK (cancellation_stage IN ('BEFORE_MATCH','AFTER_MATCH','AFTER_PAYMENT','BEFORE_PURCHASE',
                                                          'AFTER_PURCHASE','DURING_TRAVEL','AFTER_ARRIVAL')),
  version              integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (request_id, buyer_id) REFERENCES requests(id, buyer_id),
  FOREIGN KEY (trip_id, traveler_id) REFERENCES trips(id, traveler_id),
  FOREIGN KEY (offer_id, request_id) REFERENCES offers(id, request_id),
  CHECK (buyer_id IS DISTINCT FROM traveler_id),
  -- once matched, the counterparty is fixed
  CHECK (status IN ('REQUEST_CREATED','CANCELLED')
         OR (trip_id IS NOT NULL AND traveler_id IS NOT NULL AND offer_id IS NOT NULL)),
  CHECK (status <> 'CANCELLED' OR cancelled_at IS NOT NULL),
  CHECK (status <> 'COMPLETED' OR completed_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS transactions_buyer_idx ON transactions (buyer_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS transactions_traveler_idx ON transactions (traveler_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS transactions_status_updated_idx ON transactions (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS transactions_updated_at_idx ON transactions (updated_at DESC);
CREATE INDEX IF NOT EXISTS transactions_request_idx ON transactions (request_id, buyer_id);
CREATE INDEX IF NOT EXISTS transactions_trip_idx ON transactions (trip_id, traveler_id);
CREATE INDEX IF NOT EXISTS transactions_offer_idx ON transactions (offer_id, request_id);
CREATE INDEX IF NOT EXISTS transactions_item_currency_idx ON transactions (item_currency);
CREATE INDEX IF NOT EXISTS transactions_cancelled_by_idx ON transactions (cancelled_by);
CREATE INDEX IF NOT EXISTS transactions_active_quote_idx ON transactions (active_quote_id);
CREATE INDEX IF NOT EXISTS transactions_auto_confirm_idx ON transactions (auto_confirm_at) WHERE status = 'DELIVERED';
CREATE INDEX IF NOT EXISTS transactions_purchase_deadline_idx ON transactions (purchase_deadline) WHERE status = 'PURCHASE_APPROVED';
CREATE INDEX IF NOT EXISTS transactions_completed_at_idx ON transactions (completed_at) WHERE status = 'COMPLETED';
-- one live transaction per request (a cancelled/refunded one may be re-matched)
CREATE UNIQUE INDEX IF NOT EXISTS transactions_one_live_per_request ON transactions (request_id)
  WHERE status NOT IN ('CANCELLED','REFUNDED');
SELECT jk_attach_updated_at('transactions');

CREATE OR REPLACE TRIGGER trg_assign_number BEFORE INSERT ON transactions
  FOR EACH ROW EXECUTE FUNCTION jk_assign_number('JK');
CREATE OR REPLACE TRIGGER trg_status_via_function BEFORE INSERT OR UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION jk_status_via_function_only('REQUEST_CREATED');

CREATE TABLE IF NOT EXISTS transaction_transitions (
  from_status text NOT NULL,
  to_status   text NOT NULL,
  actor_types text[] NOT NULL CHECK (actor_types <@ ARRAY['BUYER','TRAVELER','SYSTEM','ADMIN'] AND cardinality(actor_types) > 0),
  guard       text,                                  -- human description; enforced by API service layer
  PRIMARY KEY (from_status, to_status),
  CHECK (from_status IN ('REQUEST_CREATED','MATCHED','AWAITING_PAYMENT','PAYMENT_SECURED','PRICE_CHANGE_PENDING',
                         'PURCHASE_APPROVED','PURCHASED','TRAVELING','ARRIVED','CUSTOMS_PROCESS','READY_FOR_HANDOVER',
                         'OUT_FOR_DELIVERY','DELIVERED','BUYER_CONFIRMED','DISPUTED','REFUND_PENDING')),  -- terminal states excluded
  CHECK (to_status IN ('REQUEST_CREATED','MATCHED','AWAITING_PAYMENT','PAYMENT_SECURED','PRICE_CHANGE_PENDING',
                       'PURCHASE_APPROVED','PURCHASED','TRAVELING','ARRIVED','CUSTOMS_PROCESS','READY_FOR_HANDOVER',
                       'OUT_FOR_DELIVERY','DELIVERED','BUYER_CONFIRMED','COMPLETED','CANCELLED','DISPUTED',
                       'REFUND_PENDING','REFUNDED'))
);

CREATE TABLE IF NOT EXISTS transaction_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES transactions(id),
  from_status    text,
  to_status      text NOT NULL,
  actor_type     text NOT NULL CHECK (actor_type IN ('BUYER','TRAVELER','SYSTEM','ADMIN')),
  actor_id       uuid,
  reason         text,
  meta           jsonb NOT NULL DEFAULT '{}',
  version        integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transaction_events_tx_idx ON transaction_events (transaction_id, id);
CREATE INDEX IF NOT EXISTS transaction_events_day_idx ON transaction_events (created_at, to_status);
SELECT jk_make_append_only('transaction_events');

CREATE OR REPLACE FUNCTION jk_transaction_created_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO transaction_events (transaction_id, from_status, to_status, actor_type, actor_id, version)
  VALUES (NEW.id, NULL, NEW.status, 'BUYER', NEW.buyer_id, NEW.version);
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER trg_transaction_created_event AFTER INSERT ON transactions
  FOR EACH ROW EXECUTE FUNCTION jk_transaction_created_event();

-- The ONLY way to change transactions.status (enforced by trg_status_via_function).
-- Order of checks: existence (JK404) -> version (JK409) -> (from,to) pair (JK422)
-- -> actor (JK403). Guards beyond the actor are the API service layer's job.
CREATE OR REPLACE FUNCTION transition_transaction(p_tx uuid, p_expected_version integer, p_to text,
                                                  p_actor_type text, p_actor_id uuid,
                                                  p_reason text DEFAULT NULL, p_meta jsonb DEFAULT '{}')
RETURNS transactions
LANGUAGE plpgsql AS $$
DECLARE
  v_row transactions%ROWTYPE;
  v_from text;
  v_actors text[];
BEGIN
  SELECT * INTO v_row FROM transactions WHERE id = p_tx FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'JK404', MESSAGE = format('transaction %s not found', p_tx);
  END IF;
  IF v_row.version <> p_expected_version THEN
    RAISE EXCEPTION USING ERRCODE = 'JK409',
      MESSAGE = format('transaction %s version conflict: expected %s, current %s', v_row.number, p_expected_version, v_row.version),
      DETAIL = json_build_object('currentVersion', v_row.version, 'currentStatus', v_row.status)::text;
  END IF;
  v_from := v_row.status;
  SELECT actor_types INTO v_actors FROM transaction_transitions WHERE from_status = v_from AND to_status = p_to;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'JK422',
      MESSAGE = format('illegal transaction transition %s -> %s', v_from, p_to);
  END IF;
  IF NOT (p_actor_type = ANY (v_actors)) THEN
    RAISE EXCEPTION USING ERRCODE = 'JK403',
      MESSAGE = format('actor %s may not move transaction %s -> %s (allowed: %s)', p_actor_type, v_from, p_to,
                       array_to_string(v_actors, ','));
  END IF;

  PERFORM set_config('jk.fsm_ctx', 'transactions:' || p_tx, true);
  UPDATE transactions
     SET status            = p_to,
         version           = version + 1,
         status_changed_at = now(),
         delivered_at      = CASE WHEN p_to = 'DELIVERED' THEN now() ELSE delivered_at END,
         disputed_at       = CASE WHEN p_to = 'DISPUTED'  THEN now() ELSE disputed_at END,
         completed_at      = CASE WHEN p_to = 'COMPLETED' THEN now() ELSE completed_at END,
         refunded_at       = CASE WHEN p_to = 'REFUNDED'  THEN now() ELSE refunded_at END,
         cancelled_at      = CASE WHEN p_to = 'CANCELLED' THEN now() ELSE cancelled_at END,
         cancel_reason     = CASE WHEN p_to = 'CANCELLED' THEN p_reason ELSE cancel_reason END,
         cancelled_by      = CASE WHEN p_to = 'CANCELLED' THEN p_actor_id ELSE cancelled_by END,
         cancelled_by_type = CASE WHEN p_to = 'CANCELLED' THEN p_actor_type ELSE cancelled_by_type END,
         cancellation_stage = CASE WHEN p_to IN ('CANCELLED','REFUND_PENDING') AND p_meta ? 'cancellationStage'
                                   THEN p_meta->>'cancellationStage' ELSE cancellation_stage END
   WHERE id = p_tx
  RETURNING * INTO v_row;
  PERFORM set_config('jk.fsm_ctx', '', true);

  INSERT INTO transaction_events (transaction_id, from_status, to_status, actor_type, actor_id, reason, meta, version)
  VALUES (p_tx, v_from, p_to, p_actor_type, p_actor_id, p_reason, coalesce(p_meta, '{}'), v_row.version);

  PERFORM jk_outbox('transaction', p_tx::text, 'transaction.status_changed',
    jsonb_build_object('transactionId', p_tx, 'number', v_row.number, 'from', v_from, 'to', p_to,
                       'version', v_row.version, 'buyerId', v_row.buyer_id, 'travelerId', v_row.traveler_id,
                       'actorType', p_actor_type, 'actorId', p_actor_id, 'reason', p_reason,
                       'meta', coalesce(p_meta, '{}')));

  PERFORM jk_audit(p_actor_type, p_actor_id, 'transaction.transition', 'transaction', p_tx::text,
                   jsonb_build_object('status', v_from, 'version', p_expected_version),
                   jsonb_build_object('status', p_to, 'version', v_row.version),
                   jsonb_build_object('number', v_row.number, 'reason', p_reason) || coalesce(p_meta, '{}'));
  RETURN v_row;
END $$;

-- ---------------------------------------------------------------------------
-- FX
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fx_rates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base       char(3) NOT NULL REFERENCES currencies(code),
  quote      char(3) NOT NULL REFERENCES currencies(code),
  rate       numeric(20,10) NOT NULL CHECK (rate > 0),
  source     text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_-]*$'),
  as_of      timestamptz NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (base, quote, source, as_of),
  CHECK (base <> quote)
);
CREATE INDEX IF NOT EXISTS fx_rates_latest_idx ON fx_rates (base, quote, as_of DESC);
CREATE INDEX IF NOT EXISTS fx_rates_quote_idx ON fx_rates (quote);
SELECT jk_make_append_only('fx_rates');

CREATE OR REPLACE VIEW v_fx_rates_latest AS
SELECT DISTINCT ON (base, quote) id, base, quote, rate, source, as_of, fetched_at
  FROM fx_rates ORDER BY base, quote, as_of DESC, fetched_at DESC;

CREATE TABLE IF NOT EXISTS fx_locks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base           char(3) NOT NULL REFERENCES currencies(code),
  quote          char(3) NOT NULL REFERENCES currencies(code),
  spot_rate      numeric(20,10) NOT NULL CHECK (spot_rate > 0),
  markup_bps     integer NOT NULL CHECK (markup_bps BETWEEN 0 AND 10000),
  locked_rate    numeric(20,10) NOT NULL CHECK (locked_rate > 0),
  locked_at      timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  status         text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CONSUMED','EXPIRED')),
  source_rate_id uuid REFERENCES fx_rates(id),
  consumed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > locked_at),
  CHECK (locked_rate >= spot_rate)
);
CREATE INDEX IF NOT EXISTS fx_locks_expiry_idx ON fx_locks (expires_at) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS fx_locks_source_rate_id_idx ON fx_locks (source_rate_id);
CREATE INDEX IF NOT EXISTS fx_locks_base_idx ON fx_locks (base);
CREATE INDEX IF NOT EXISTS fx_locks_quote_idx ON fx_locks (quote);
SELECT jk_attach_updated_at('fx_locks');
SELECT jk_make_restricted('fx_locks', 'status', 'consumed_at', 'updated_at');
SELECT jk_attach_fsm('fx_locks', 'FX_LOCK');

-- ---------------------------------------------------------------------------
-- Quotes & price lines. A quote is immutable pricing evidence: only its status
-- may change; lines are append-only and must sum to the TOTAL line.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quotes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id  uuid NOT NULL REFERENCES transactions(id),
  fx_lock_id      uuid REFERENCES fx_locks(id),
  total_idr       bigint NOT NULL CHECK (total_idr >= 0),
  customs         jsonb NOT NULL DEFAULT '{}',
  config_versions jsonb NOT NULL DEFAULT '{}',
  rule_refs       jsonb NOT NULL DEFAULT '[]',
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ACCEPTED','EXPIRED','SUPERSEDED')),
  expires_at      timestamptz NOT NULL,
  accepted_at     timestamptz,
  superseded_by   uuid REFERENCES quotes(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'ACCEPTED' OR accepted_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS quotes_one_active_per_tx ON quotes (transaction_id) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS quotes_transaction_idx ON quotes (transaction_id, created_at DESC);
CREATE INDEX IF NOT EXISTS quotes_fx_lock_id_idx ON quotes (fx_lock_id);
CREATE INDEX IF NOT EXISTS quotes_superseded_by_idx ON quotes (superseded_by);
CREATE INDEX IF NOT EXISTS quotes_expiry_idx ON quotes (expires_at) WHERE status = 'ACTIVE';
SELECT jk_attach_updated_at('quotes');
SELECT jk_make_restricted('quotes', 'status', 'accepted_at', 'superseded_by', 'updated_at');
SELECT jk_attach_fsm('quotes', 'QUOTE');

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_active_quote_id_fkey') THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_active_quote_id_fkey
      FOREIGN KEY (active_quote_id) REFERENCES quotes(id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS quote_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id    uuid NOT NULL REFERENCES quotes(id),
  line_type   text NOT NULL CHECK (line_type IN ('ITEM_PRICE','TRAVELER_FEE','CUSTOMS_DUTY','IMPORT_TAX','PROTECTION_FEE',
                                                 'PLATFORM_FEE','SERVICE_TAX','PAYMENT_FEE','DISCOUNT','REFERRAL_CREDIT','TOTAL')),
  label_id    text NOT NULL,
  label_en    text NOT NULL,
  amount_idr  bigint NOT NULL,
  bucket      text CHECK (bucket IN ('PRODUCT_FUND','TRAVELER_EARNING','CUSTOMS_RESERVE','PLATFORM_REVENUE','TAX_PAYABLE',
                                     'PAYMENT_FEE','REFUND','PROMOTION_CREDIT','CLEARING')),
  is_estimate boolean NOT NULL DEFAULT false,
  rule_ref    text,
  meta        jsonb NOT NULL DEFAULT '{}',
  sort        smallint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quote_id, sort),
  CHECK ((line_type IN ('DISCOUNT','REFERRAL_CREDIT') AND amount_idr <= 0)
      OR (line_type NOT IN ('DISCOUNT','REFERRAL_CREDIT') AND amount_idr >= 0)),
  CHECK ((line_type = 'TOTAL') = (bucket IS NULL))       -- every money line names its destination bucket
);
CREATE UNIQUE INDEX IF NOT EXISTS quote_lines_one_total ON quote_lines (quote_id) WHERE line_type = 'TOTAL';
CREATE INDEX IF NOT EXISTS quote_lines_type_idx ON quote_lines (line_type, quote_id);
SELECT jk_make_append_only('quote_lines');

-- Deferred check: every quote has exactly one TOTAL line equal to the sum of the
-- other lines and to quotes.total_idr ("no fee that is not in the breakdown").
CREATE OR REPLACE FUNCTION jk_check_quote_totals() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_quote uuid;
  v_total bigint; v_sum bigint; v_n_total int; v_header bigint;
BEGIN
  IF TG_TABLE_NAME = 'quotes' THEN v_quote := NEW.id; ELSE v_quote := NEW.quote_id; END IF;
  SELECT count(*) FILTER (WHERE line_type = 'TOTAL'),
         max(amount_idr) FILTER (WHERE line_type = 'TOTAL'),
         coalesce(sum(amount_idr) FILTER (WHERE line_type <> 'TOTAL'), 0)
    INTO v_n_total, v_total, v_sum
    FROM quote_lines WHERE quote_id = v_quote;
  SELECT total_idr INTO v_header FROM quotes WHERE id = v_quote;
  IF v_n_total <> 1 OR v_total <> v_sum OR v_total <> v_header THEN
    RAISE EXCEPTION USING ERRCODE = 'JKQ01',
      MESSAGE = format('quote %s lines inconsistent: TOTAL lines=%s, TOTAL=%s, sum(lines)=%s, quotes.total_idr=%s',
                       v_quote, v_n_total, v_total, v_sum, v_header);
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_check_quote_totals ON quote_lines;
CREATE CONSTRAINT TRIGGER trg_check_quote_totals AFTER INSERT ON quote_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jk_check_quote_totals();
DROP TRIGGER IF EXISTS trg_check_quote_totals ON quotes;
CREATE CONSTRAINT TRIGGER trg_check_quote_totals AFTER INSERT ON quotes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jk_check_quote_totals();

-- ---------------------------------------------------------------------------
-- Price confirmation (§5)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS price_confirmations (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id            uuid NOT NULL REFERENCES transactions(id),
  requested_by              uuid NOT NULL REFERENCES users(id),
  status                    text NOT NULL DEFAULT 'PENDING'
                            CHECK (status IN ('PENDING','APPROVED','REJECTED','CLARIFICATION_REQUESTED','EXPIRED')),
  original_price_minor      bigint NOT NULL CHECK (original_price_minor >= 0),
  actual_price_minor        bigint NOT NULL CHECK (actual_price_minor >= 0),
  currency                  char(3) NOT NULL REFERENCES currencies(code),
  receipt_file_id           uuid REFERENCES files(id),
  notes                     text,
  window_seconds            integer NOT NULL DEFAULT 900 CHECK (window_seconds BETWEEN 60 AND 86400),
  expires_at                timestamptz NOT NULL,
  round                     smallint NOT NULL DEFAULT 1 CHECK (round >= 1),
  responded_at              timestamptz,
  response_note             text,
  supplemental_required_idr bigint NOT NULL DEFAULT 0 CHECK (supplemental_required_idr >= 0),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('PENDING','EXPIRED') OR responded_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS price_confirmations_one_open ON price_confirmations (transaction_id)
  WHERE status IN ('PENDING','CLARIFICATION_REQUESTED');
CREATE INDEX IF NOT EXISTS price_confirmations_tx_idx ON price_confirmations (transaction_id, created_at DESC);
CREATE INDEX IF NOT EXISTS price_confirmations_expiry_idx ON price_confirmations (expires_at) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS price_confirmations_requested_by_idx ON price_confirmations (requested_by);
CREATE INDEX IF NOT EXISTS price_confirmations_currency_idx ON price_confirmations (currency);
CREATE INDEX IF NOT EXISTS price_confirmations_receipt_idx ON price_confirmations (receipt_file_id);
SELECT jk_attach_updated_at('price_confirmations');
SELECT jk_attach_fsm('price_confirmations', 'PRICE_CONFIRMATION');

-- ---------------------------------------------------------------------------
-- Purchase proof (golden rule: only after PURCHASE_APPROVED — API guard)
-- product_photo_file_ids is a uuid[] per contract; element FKs are validated by the API.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchase_proofs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id         uuid NOT NULL REFERENCES transactions(id),
  traveler_id            uuid NOT NULL REFERENCES users(id),
  receipt_file_id        uuid NOT NULL REFERENCES files(id),
  product_photo_file_ids uuid[] NOT NULL DEFAULT '{}',
  video_file_id          uuid REFERENCES files(id),
  serial_number          text,
  merchant_name          text NOT NULL,
  actual_price_minor     bigint NOT NULL CHECK (actual_price_minor >= 0),
  currency               char(3) NOT NULL REFERENCES currencies(code),
  purchased_at           timestamptz NOT NULL,
  fraud_score            smallint CHECK (fraud_score BETWEEN 0 AND 100),
  fraud_reasons          jsonb NOT NULL DEFAULT '[]',
  status                 text NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','ACCEPTED','FLAGGED','REJECTED')),
  reviewed_by            uuid REFERENCES users(id),
  reviewed_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(product_photo_file_ids) >= 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS purchase_proofs_one_accepted ON purchase_proofs (transaction_id) WHERE status = 'ACCEPTED';
CREATE INDEX IF NOT EXISTS purchase_proofs_tx_idx ON purchase_proofs (transaction_id, created_at DESC);
CREATE INDEX IF NOT EXISTS purchase_proofs_traveler_id_idx ON purchase_proofs (traveler_id);
CREATE INDEX IF NOT EXISTS purchase_proofs_receipt_idx ON purchase_proofs (receipt_file_id);
CREATE INDEX IF NOT EXISTS purchase_proofs_video_idx ON purchase_proofs (video_file_id);
CREATE INDEX IF NOT EXISTS purchase_proofs_currency_idx ON purchase_proofs (currency);
CREATE INDEX IF NOT EXISTS purchase_proofs_reviewed_by_idx ON purchase_proofs (reviewed_by);
CREATE INDEX IF NOT EXISTS purchase_proofs_flagged_idx ON purchase_proofs (created_at) WHERE status = 'FLAGGED';
CREATE INDEX IF NOT EXISTS purchase_proofs_serial_idx ON purchase_proofs (serial_number) WHERE serial_number IS NOT NULL;
SELECT jk_attach_updated_at('purchase_proofs');

CREATE TABLE IF NOT EXISTS customs_declarations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id      uuid NOT NULL REFERENCES transactions(id),
  traveler_id         uuid NOT NULL REFERENCES users(id),
  declared_value_minor bigint CHECK (declared_value_minor IS NULL OR declared_value_minor >= 0),
  declared_currency   char(3) REFERENCES currencies(code),
  estimated_total_idr bigint CHECK (estimated_total_idr IS NULL OR estimated_total_idr >= 0),
  duty_paid_idr       bigint NOT NULL DEFAULT 0 CHECK (duty_paid_idr >= 0),
  vat_paid_idr        bigint NOT NULL DEFAULT 0 CHECK (vat_paid_idr >= 0),
  income_tax_paid_idr bigint NOT NULL DEFAULT 0 CHECK (income_tax_paid_idr >= 0),
  luxury_tax_paid_idr bigint NOT NULL DEFAULT 0 CHECK (luxury_tax_paid_idr >= 0),
  total_paid_idr      bigint GENERATED ALWAYS AS (duty_paid_idr + vat_paid_idr + income_tax_paid_idr + luxury_tax_paid_idr) STORED,
  declaration_ref     text,
  receipt_file_id     uuid REFERENCES files(id),
  status              text NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('NOT_REQUIRED','PENDING','SUBMITTED','PAID','VERIFIED','REJECTED')),
  paid_at             timestamptz,
  verified_by         uuid REFERENCES users(id),
  verified_at         timestamptz,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('PAID','VERIFIED') OR receipt_file_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS customs_declarations_one_live ON customs_declarations (transaction_id) WHERE status <> 'REJECTED';
CREATE INDEX IF NOT EXISTS customs_declarations_tx_idx ON customs_declarations (transaction_id);
CREATE INDEX IF NOT EXISTS customs_declarations_traveler_id_idx ON customs_declarations (traveler_id);
CREATE INDEX IF NOT EXISTS customs_declarations_currency_idx ON customs_declarations (declared_currency);
CREATE INDEX IF NOT EXISTS customs_declarations_receipt_idx ON customs_declarations (receipt_file_id);
CREATE INDEX IF NOT EXISTS customs_declarations_verified_by_idx ON customs_declarations (verified_by);
SELECT jk_attach_updated_at('customs_declarations');

CREATE TABLE IF NOT EXISTS deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id   uuid NOT NULL REFERENCES transactions(id),
  method           text NOT NULL CHECK (method IN ('MEETUP','COURIER','PARTNER_LOGISTICS')),
  courier_name     text,
  tracking_number  text,
  address_enc      bytea,
  enc_key_id       text,
  address_city     text,              -- coarse, non-identifying (analytics / routing)
  meetup_point     text,
  scheduled_at     timestamptz,
  pin_hash         bytea,
  pin_attempts     smallint NOT NULL DEFAULT 0,
  pin_max_attempts smallint NOT NULL DEFAULT 5 CHECK (pin_max_attempts BETWEEN 1 AND 5),
  pin_locked_at    timestamptz,
  qr_token_hash    bytea,
  qr_expires_at    timestamptz,
  confirmed_at     timestamptz,
  confirmed_via    text CHECK (confirmed_via IN ('PIN','QR','BUYER_APP','AUTO','ADMIN')),
  confirmed_by     uuid REFERENCES users(id),
  proof_file_ids   uuid[] NOT NULL DEFAULT '{}',
  status           text NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING','SCHEDULED','IN_TRANSIT','DELIVERED','FAILED','CANCELLED')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (pin_attempts BETWEEN 0 AND pin_max_attempts),
  CHECK (address_enc IS NULL OR enc_key_id IS NOT NULL),
  CHECK ((confirmed_at IS NULL) = (confirmed_via IS NULL)),
  CHECK (status <> 'DELIVERED' OR confirmed_at IS NOT NULL),
  CHECK (method = 'MEETUP' OR status NOT IN ('IN_TRANSIT','DELIVERED') OR tracking_number IS NOT NULL OR confirmed_via = 'ADMIN')
);
CREATE UNIQUE INDEX IF NOT EXISTS deliveries_one_live_per_tx ON deliveries (transaction_id) WHERE status NOT IN ('FAILED','CANCELLED');
CREATE INDEX IF NOT EXISTS deliveries_tx_idx ON deliveries (transaction_id);
CREATE INDEX IF NOT EXISTS deliveries_confirmed_by_idx ON deliveries (confirmed_by);
CREATE INDEX IF NOT EXISTS deliveries_tracking_idx ON deliveries (tracking_number) WHERE tracking_number IS NOT NULL;
SELECT jk_attach_updated_at('deliveries');
INSERT INTO jk_sensitive_columns VALUES ('deliveries','meetup_point','location PII') ON CONFLICT DO NOTHING;

COMMIT;
