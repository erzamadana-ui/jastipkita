-- 0009_payments_ledger.sql
-- Payments (SafePay via Xendit / MOCK), webhook inbox, double-entry ledger,
-- refunds, payouts, settlement accounts (maker-checker), reconciliation.
BEGIN;

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id  uuid NOT NULL REFERENCES transactions(id),
  quote_id        uuid REFERENCES quotes(id),
  purpose         text NOT NULL CHECK (purpose IN ('CHECKOUT','SUPPLEMENTAL')),
  provider        text NOT NULL CHECK (provider IN ('XENDIT','MOCK')),
  provider_env    text NOT NULL CHECK (provider_env IN ('TEST','LIVE')),
  provider_ref    text,
  channel         text CHECK (channel IN ('VA','QRIS','EWALLET','CARD','RETAIL','MOCK')),
  amount_idr      bigint NOT NULL CHECK (amount_idr > 0),
  provider_fee_idr bigint NOT NULL DEFAULT 0 CHECK (provider_fee_idr >= 0),
  refunded_idr    bigint NOT NULL DEFAULT 0 CHECK (refunded_idr >= 0),
  status          text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','SECURED','EXPIRED','FAILED','REFUNDED','PARTIALLY_REFUNDED')),
  checkout_url    text,
  expires_at      timestamptz,
  secured_at      timestamptz,
  failure_reason  text,
  idempotency_key text NOT NULL UNIQUE,
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, transaction_id),
  CHECK (provider <> 'MOCK' OR provider_env = 'TEST'),          -- a mock can never be "live"
  CHECK (refunded_idr <= amount_idr),
  CHECK (status NOT IN ('SECURED','REFUNDED','PARTIALLY_REFUNDED') OR secured_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_ref_uq ON payments (provider, provider_env, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS payments_tx_idx ON payments (transaction_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_quote_id_idx ON payments (quote_id);
CREATE INDEX IF NOT EXISTS payments_pending_expiry_idx ON payments (expires_at) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS payments_status_idx ON payments (status, created_at DESC);
SELECT jk_attach_updated_at('payments');
SELECT jk_attach_fsm('payments', 'PAYMENT');

-- Webhook inbox: payload/signature facts are immutable; processing bookkeeping may update.
CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider         text NOT NULL CHECK (provider IN ('XENDIT','MOCK')),
  provider_env     text NOT NULL CHECK (provider_env IN ('TEST','LIVE')),
  event_id         text NOT NULL,
  event_type       text NOT NULL,
  signature_valid  boolean NOT NULL,
  payload          jsonb NOT NULL,
  headers          jsonb NOT NULL DEFAULT '{}',     -- sanitized: no auth tokens
  received_at      timestamptz NOT NULL DEFAULT now(),
  payment_id       uuid REFERENCES payments(id),
  processed_at     timestamptz,
  processing_error text,
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  UNIQUE (provider, event_id)
);
CREATE INDEX IF NOT EXISTS payment_webhook_unprocessed_idx ON payment_webhook_events (received_at) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS payment_webhook_payment_id_idx ON payment_webhook_events (payment_id);
SELECT jk_make_restricted('payment_webhook_events', 'payment_id', 'processed_at', 'processing_error', 'attempts');
INSERT INTO jk_sensitive_columns VALUES
  ('payment_webhook_events','payload','provider payload may include payer name/email/phone'),
  ('payment_webhook_events','headers','request headers')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Double-entry ledger
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_:.-]+$'),
  name          text NOT NULL,
  bucket        text NOT NULL CHECK (bucket IN ('PRODUCT_FUND','TRAVELER_EARNING','CUSTOMS_RESERVE','PLATFORM_REVENUE',
                                                'TAX_PAYABLE','PAYMENT_FEE','REFUND','PROMOTION_CREDIT','CLEARING','PROVIDER_CASH')),
  owner_user_id uuid REFERENCES users(id),
  currency      char(3) NOT NULL REFERENCES currencies(code),
  normal_side   text NOT NULL CHECK (normal_side IN ('DEBIT','CREDIT')),
  is_system     boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','FROZEN','CLOSED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, currency),                                         -- composite FK target
  CONSTRAINT ledger_accounts_bucket_owner_currency_uq UNIQUE NULLS NOT DISTINCT (bucket, owner_user_id, currency),
  CHECK (is_system = (owner_user_id IS NULL))
);
CREATE INDEX IF NOT EXISTS ledger_accounts_owner_idx ON ledger_accounts (owner_user_id);
CREATE INDEX IF NOT EXISTS ledger_accounts_currency_idx ON ledger_accounts (currency);
SELECT jk_attach_updated_at('ledger_accounts');

-- Returns (creating on demand) the account for bucket/owner/currency.
CREATE OR REPLACE FUNCTION ensure_ledger_account(p_bucket text, p_owner uuid, p_currency char(3) DEFAULT 'IDR')
RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM ledger_accounts
   WHERE bucket = p_bucket AND owner_user_id IS NOT DISTINCT FROM p_owner AND currency = p_currency;
  IF FOUND THEN RETURN v_id; END IF;
  INSERT INTO ledger_accounts (code, name, bucket, owner_user_id, currency, normal_side, is_system)
  VALUES (CASE WHEN p_owner IS NULL THEN 'SYS:' || p_bucket || ':' || p_currency
               ELSE 'USR:' || replace(upper(p_owner::text), '-', '') || ':' || p_bucket || ':' || p_currency END,
          initcap(replace(p_bucket, '_', ' ')) || CASE WHEN p_owner IS NULL THEN '' ELSE ' (user)' END,
          p_bucket, p_owner, p_currency,
          CASE WHEN p_bucket IN ('PROVIDER_CASH','PAYMENT_FEE','PROMOTION_CREDIT','CLEARING') THEN 'DEBIT' ELSE 'CREDIT' END,
          p_owner IS NULL)
  ON CONFLICT ON CONSTRAINT ledger_accounts_bucket_owner_currency_uq DO NOTHING;
  SELECT id INTO v_id FROM ledger_accounts
   WHERE bucket = p_bucket AND owner_user_id IS NOT DISTINCT FROM p_owner AND currency = p_currency;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- Refunds & payouts (declared before journals so journals can reference them)
-- Refund FSM: REQUESTED -> PENDING_APPROVAL -> APPROVED -> PROCESSING -> SUCCEEDED|FAILED
--             (+ REJECTED, CANCELLED; FAILED -> PROCESSING retry). Seeded in status_transitions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refunds (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number         text NOT NULL UNIQUE CHECK (number ~ '^RFD-[0-9]{6}-[0-9A-HJKMNP-TV-Z]{6}$'),
  transaction_id uuid NOT NULL REFERENCES transactions(id),
  payment_id     uuid NOT NULL,
  reason_code    text NOT NULL CHECK (reason_code IN ('BUYER_CANCEL','TRAVELER_CANCEL','PRICE_CHANGE_REJECTED','PRICE_CONFIRMATION_EXPIRED',
                                                      'DISPUTE_RESOLUTION','PAYMENT_DUPLICATE','LATE_PAYMENT','ADMIN','OTHER')),
  reason_note    text,
  amount_idr     bigint NOT NULL CHECK (amount_idr > 0),
  breakdown      jsonb NOT NULL DEFAULT '{}',        -- per price line, from cancellation matrix
  type           text NOT NULL CHECK (type IN ('FULL','PARTIAL')),
  status         text NOT NULL DEFAULT 'REQUESTED'
                 CHECK (status IN ('REQUESTED','PENDING_APPROVAL','APPROVED','PROCESSING','SUCCEEDED','FAILED','REJECTED','CANCELLED')),
  provider_ref   text,
  requested_by   uuid REFERENCES users(id),           -- NULL = system
  approved_by    uuid REFERENCES users(id),
  approved_at    timestamptz,
  processed_at   timestamptz,
  failure_reason text,
  idempotency_key text UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (payment_id, transaction_id) REFERENCES payments(id, transaction_id),
  CHECK (approved_by IS NULL OR approved_by IS DISTINCT FROM requested_by),   -- maker-checker
  CHECK (status NOT IN ('APPROVED','PROCESSING','SUCCEEDED') OR approved_at IS NOT NULL),
  CHECK (status <> 'FAILED' OR failure_reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS refunds_tx_idx ON refunds (transaction_id);
CREATE INDEX IF NOT EXISTS refunds_payment_idx ON refunds (payment_id, transaction_id);
CREATE INDEX IF NOT EXISTS refunds_queue_idx ON refunds (status, created_at) WHERE status IN ('REQUESTED','PENDING_APPROVAL','APPROVED','PROCESSING','FAILED');
CREATE INDEX IF NOT EXISTS refunds_requested_by_idx ON refunds (requested_by);
CREATE INDEX IF NOT EXISTS refunds_approved_by_idx ON refunds (approved_by);
CREATE UNIQUE INDEX IF NOT EXISTS refunds_provider_ref_uq ON refunds (provider_ref) WHERE provider_ref IS NOT NULL;
SELECT jk_attach_updated_at('refunds');
SELECT jk_attach_fsm('refunds', 'REFUND');
CREATE OR REPLACE TRIGGER trg_assign_number BEFORE INSERT ON refunds
  FOR EACH ROW EXECUTE FUNCTION jk_assign_number('RFD');

-- Refunds may not exceed the secured amount of the payment (sum over live refunds).
CREATE OR REPLACE FUNCTION jk_check_refund_total() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_paid bigint; v_refunds bigint;
BEGIN
  SELECT amount_idr INTO v_paid FROM payments WHERE id = NEW.payment_id FOR UPDATE;
  SELECT coalesce(sum(amount_idr), 0) INTO v_refunds FROM refunds
   WHERE payment_id = NEW.payment_id AND status NOT IN ('REJECTED','CANCELLED','FAILED') AND id <> NEW.id;
  IF NEW.status NOT IN ('REJECTED','CANCELLED','FAILED') AND v_refunds + NEW.amount_idr > v_paid THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('refunds on payment %s would total %s > paid %s', NEW.payment_id, v_refunds + NEW.amount_idr, v_paid);
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER trg_check_refund_total BEFORE INSERT OR UPDATE OF amount_idr, status ON refunds
  FOR EACH ROW EXECUTE FUNCTION jk_check_refund_total();

CREATE TABLE IF NOT EXISTS refund_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  refund_id   uuid NOT NULL REFERENCES refunds(id),
  from_status text,
  to_status   text NOT NULL,
  actor_type  text NOT NULL,
  actor_id    uuid,
  note        text,
  meta        jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refund_events_refund_idx ON refund_events (refund_id, id);
SELECT jk_make_append_only('refund_events');

-- Every refund status change is recorded automatically (actor from jk.actor_* context).
CREATE OR REPLACE FUNCTION jk_refund_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO refund_events (refund_id, from_status, to_status, actor_type, actor_id, note, meta)
    VALUES (NEW.id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status,
            jk_ctx_actor_type(), jk_ctx_actor_id(),
            CASE WHEN NEW.status = 'FAILED' THEN NEW.failure_reason ELSE NULL END,
            jsonb_build_object('amountIdr', NEW.amount_idr, 'requestId', jk_ctx_request_id()));
  END IF;
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER trg_refund_event AFTER INSERT OR UPDATE OF status ON refunds
  FOR EACH ROW EXECUTE FUNCTION jk_refund_event();

-- Payout FSM: SCHEDULED -> PROCESSING -> PAID|FAILED; SCHEDULED <-> ON_HOLD; FAILED -> SCHEDULED; -> CANCELLED.
CREATE TABLE IF NOT EXISTS payouts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number            text NOT NULL UNIQUE CHECK (number ~ '^PO-[0-9]{6}-[0-9A-HJKMNP-TV-Z]{6}$'),
  traveler_id       uuid NOT NULL REFERENCES users(id),
  transaction_id    uuid REFERENCES transactions(id),
  payout_account_id uuid NOT NULL,
  amount_idr        bigint NOT NULL CHECK (amount_idr > 0),
  fee_idr           bigint NOT NULL DEFAULT 0 CHECK (fee_idr >= 0),
  net_idr           bigint GENERATED ALWAYS AS (amount_idr - fee_idr) STORED,
  status            text NOT NULL DEFAULT 'SCHEDULED'
                    CHECK (status IN ('SCHEDULED','ON_HOLD','PROCESSING','PAID','FAILED','CANCELLED')),
  hold_reason       text,
  scheduled_for     timestamptz NOT NULL DEFAULT now(),
  provider          text NOT NULL DEFAULT 'MOCK' CHECK (provider IN ('XENDIT','MOCK','MANUAL')),
  provider_env      text NOT NULL DEFAULT 'TEST' CHECK (provider_env IN ('TEST','LIVE')),
  provider_ref      text,
  approved_by       uuid REFERENCES users(id),
  paid_at           timestamptz,
  failure_reason    text,
  idempotency_key   text UNIQUE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (payout_account_id, traveler_id) REFERENCES payout_accounts(id, user_id),
  CHECK (fee_idr < amount_idr),
  CHECK (status <> 'ON_HOLD' OR hold_reason IS NOT NULL),
  CHECK (status <> 'PAID' OR paid_at IS NOT NULL),
  CHECK (provider <> 'MOCK' OR provider_env = 'TEST')
);
-- never two live payouts for the same transaction
CREATE UNIQUE INDEX IF NOT EXISTS payouts_one_live_per_tx ON payouts (transaction_id)
  WHERE transaction_id IS NOT NULL AND status NOT IN ('FAILED','CANCELLED');
CREATE INDEX IF NOT EXISTS payouts_traveler_idx ON payouts (traveler_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payouts_account_idx ON payouts (payout_account_id, traveler_id);
CREATE INDEX IF NOT EXISTS payouts_due_idx ON payouts (scheduled_for) WHERE status = 'SCHEDULED';
CREATE INDEX IF NOT EXISTS payouts_approved_by_idx ON payouts (approved_by);
CREATE UNIQUE INDEX IF NOT EXISTS payouts_provider_ref_uq ON payouts (provider, provider_ref) WHERE provider_ref IS NOT NULL;
SELECT jk_attach_updated_at('payouts');
SELECT jk_attach_fsm('payouts', 'PAYOUT');
CREATE OR REPLACE TRIGGER trg_assign_number BEFORE INSERT ON payouts
  FOR EACH ROW EXECUTE FUNCTION jk_assign_number('PO');

-- ---------------------------------------------------------------------------
-- Journals & entries (append-only). Balanced per currency, >= 2 entries, checked
-- at COMMIT by DEFERRABLE INITIALLY DEFERRED constraint triggers.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ledger_journals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq                 bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  kind                text NOT NULL CHECK (kind ~ '^[A-Z][A-Z0-9_]*$'),
  description         text NOT NULL,
  transaction_id      uuid REFERENCES transactions(id),
  payment_id          uuid REFERENCES payments(id),
  refund_id           uuid REFERENCES refunds(id),
  payout_id           uuid REFERENCES payouts(id),
  reverses_journal_id uuid UNIQUE REFERENCES ledger_journals(id),
  idempotency_key     text UNIQUE,
  effective_date      date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Jakarta')::date,
  created_by          uuid REFERENCES users(id),
  meta                jsonb NOT NULL DEFAULT '{}',
  posted_at           timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_journals_tx_idx ON ledger_journals (transaction_id);
CREATE INDEX IF NOT EXISTS ledger_journals_payment_idx ON ledger_journals (payment_id);
CREATE INDEX IF NOT EXISTS ledger_journals_refund_idx ON ledger_journals (refund_id);
CREATE INDEX IF NOT EXISTS ledger_journals_payout_idx ON ledger_journals (payout_id);
CREATE INDEX IF NOT EXISTS ledger_journals_created_by_idx ON ledger_journals (created_by);
CREATE INDEX IF NOT EXISTS ledger_journals_date_idx ON ledger_journals (effective_date, kind);
SELECT jk_make_append_only('ledger_journals');

CREATE TABLE IF NOT EXISTS ledger_entries (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  journal_id     uuid NOT NULL REFERENCES ledger_journals(id),
  account_id     uuid NOT NULL,
  currency       char(3) NOT NULL,
  direction      text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount         bigint NOT NULL CHECK (amount > 0),
  transaction_id uuid REFERENCES transactions(id),       -- sub-ledger per transaction (escrow view)
  memo           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, currency) REFERENCES ledger_accounts(id, currency)
);
CREATE INDEX IF NOT EXISTS ledger_entries_journal_idx ON ledger_entries (journal_id);
CREATE INDEX IF NOT EXISTS ledger_entries_account_idx ON ledger_entries (account_id, currency, id);
CREATE INDEX IF NOT EXISTS ledger_entries_tx_idx ON ledger_entries (transaction_id) WHERE transaction_id IS NOT NULL;
SELECT jk_make_append_only('ledger_entries');

CREATE OR REPLACE FUNCTION jk_ledger_entry_defaults() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM ledger_accounts WHERE id = NEW.account_id;
  IF v_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION USING ERRCODE = 'JKL03', MESSAGE = format('ledger account %s is %s', NEW.account_id, v_status);
  END IF;
  IF NEW.transaction_id IS NULL THEN
    SELECT transaction_id INTO NEW.transaction_id FROM ledger_journals WHERE id = NEW.journal_id;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER trg_ledger_entry_defaults BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION jk_ledger_entry_defaults();

CREATE OR REPLACE FUNCTION jk_check_journal_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_journal uuid;
  v_count integer;
  v_bad record;
BEGIN
  -- separate branches: PL/pgSQL resolves NEW.<field> per expression, and each table lacks the other's column
  IF TG_TABLE_NAME = 'ledger_journals' THEN v_journal := NEW.id; ELSE v_journal := NEW.journal_id; END IF;
  SELECT count(*) INTO v_count FROM ledger_entries WHERE journal_id = v_journal;
  IF v_count < 2 THEN
    RAISE EXCEPTION USING ERRCODE = 'JKL01',
      MESSAGE = format('ledger journal %s has %s entries; at least 2 are required', v_journal, v_count);
  END IF;
  SELECT currency,
         sum(amount) FILTER (WHERE direction = 'DEBIT')  AS debits,
         sum(amount) FILTER (WHERE direction = 'CREDIT') AS credits
    INTO v_bad
    FROM ledger_entries WHERE journal_id = v_journal
   GROUP BY currency
  HAVING coalesce(sum(amount) FILTER (WHERE direction = 'DEBIT'), 0)
      <> coalesce(sum(amount) FILTER (WHERE direction = 'CREDIT'), 0)
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'JKL02',
      MESSAGE = format('ledger journal %s is not balanced in %s: debits %s <> credits %s',
                       v_journal, v_bad.currency, coalesce(v_bad.debits, 0), coalesce(v_bad.credits, 0));
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_journal_balanced ON ledger_entries;
CREATE CONSTRAINT TRIGGER trg_journal_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jk_check_journal_balanced();
DROP TRIGGER IF EXISTS trg_journal_balanced ON ledger_journals;
CREATE CONSTRAINT TRIGGER trg_journal_balanced AFTER INSERT ON ledger_journals
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jk_check_journal_balanced();

-- Posts a journal from a JSON array of entries:
--   [{"bucket":"PRODUCT_FUND","ownerUserId":null,"direction":"CREDIT","amount":100000,"currency":"IDR","memo":"..."},
--    {"accountId":"<uuid>","direction":"DEBIT","amount":100000}]
-- Idempotent on p_idempotency_key: returns the existing journal id if already posted.
CREATE OR REPLACE FUNCTION post_journal(p_kind text, p_description text, p_entries jsonb,
                                        p_transaction_id uuid DEFAULT NULL, p_idempotency_key text DEFAULT NULL,
                                        p_refs jsonb DEFAULT '{}', p_actor uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_journal uuid;
  e jsonb;
  v_account uuid;
  v_currency char(3);
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_journal FROM ledger_journals WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN RETURN v_journal; END IF;
  END IF;
  INSERT INTO ledger_journals (kind, description, transaction_id, payment_id, refund_id, payout_id,
                               reverses_journal_id, idempotency_key, created_by, meta)
  VALUES (p_kind, p_description, p_transaction_id,
          (p_refs->>'paymentId')::uuid, (p_refs->>'refundId')::uuid, (p_refs->>'payoutId')::uuid,
          (p_refs->>'reversesJournalId')::uuid, p_idempotency_key, p_actor, coalesce(p_refs->'meta', '{}'))
  RETURNING id INTO v_journal;
  FOR e IN SELECT * FROM jsonb_array_elements(p_entries) LOOP
    v_currency := coalesce(e->>'currency', 'IDR');
    v_account := coalesce((e->>'accountId')::uuid,
                          ensure_ledger_account(e->>'bucket', (e->>'ownerUserId')::uuid, v_currency));
    INSERT INTO ledger_entries (journal_id, account_id, currency, direction, amount, transaction_id, memo)
    VALUES (v_journal, v_account, v_currency, e->>'direction', (e->>'amount')::bigint,
            coalesce((e->>'transactionId')::uuid, p_transaction_id), e->>'memo');
  END LOOP;
  RETURN v_journal;
END $$;

-- Compensating journal: mirror of the original with directions swapped.
CREATE OR REPLACE FUNCTION reverse_journal(p_journal uuid, p_reason text, p_actor uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_new uuid; v_src ledger_journals%ROWTYPE;
BEGIN
  SELECT * INTO v_src FROM ledger_journals WHERE id = p_journal;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'JK404', MESSAGE = format('journal %s not found', p_journal); END IF;
  INSERT INTO ledger_journals (kind, description, transaction_id, payment_id, refund_id, payout_id,
                               reverses_journal_id, idempotency_key, created_by, meta)
  VALUES ('REVERSAL', 'Reversal of ' || v_src.seq || ': ' || p_reason, v_src.transaction_id, v_src.payment_id,
          v_src.refund_id, v_src.payout_id, p_journal, 'reversal:' || p_journal, p_actor,
          jsonb_build_object('reason', p_reason))
  RETURNING id INTO v_new;
  INSERT INTO ledger_entries (journal_id, account_id, currency, direction, amount, transaction_id, memo)
  SELECT v_new, account_id, currency, CASE direction WHEN 'DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END, amount,
         transaction_id, 'reversal'
    FROM ledger_entries WHERE journal_id = p_journal ORDER BY id;
  PERFORM jk_audit(CASE WHEN p_actor IS NULL THEN 'SYSTEM' ELSE 'ADMIN' END, p_actor, 'ledger.journal_reversed',
                   'ledger_journal', p_journal::text, NULL, jsonb_build_object('reversalJournalId', v_new),
                   jsonb_build_object('reason', p_reason));
  RETURN v_new;
END $$;

CREATE OR REPLACE VIEW ledger_balances AS
SELECT a.id AS account_id, a.code, a.bucket, a.owner_user_id, a.currency, a.normal_side,
       coalesce(sum(e.amount) FILTER (WHERE e.direction = 'DEBIT'), 0)  AS debit_total,
       coalesce(sum(e.amount) FILTER (WHERE e.direction = 'CREDIT'), 0) AS credit_total,
       CASE a.normal_side
         WHEN 'DEBIT'  THEN coalesce(sum(e.amount) FILTER (WHERE e.direction = 'DEBIT'), 0)
                          - coalesce(sum(e.amount) FILTER (WHERE e.direction = 'CREDIT'), 0)
         ELSE coalesce(sum(e.amount) FILTER (WHERE e.direction = 'CREDIT'), 0)
            - coalesce(sum(e.amount) FILTER (WHERE e.direction = 'DEBIT'), 0)
       END AS balance,
       max(e.created_at) AS last_entry_at
  FROM ledger_accounts a
  LEFT JOIN ledger_entries e ON e.account_id = a.id
 GROUP BY a.id;

CREATE OR REPLACE VIEW ledger_bucket_balances AS
SELECT bucket, currency, sum(debit_total) AS debit_total, sum(credit_total) AS credit_total, sum(balance) AS balance
  FROM ledger_balances GROUP BY bucket, currency;

-- Escrow view: funds per bucket held for each transaction (credit-normal sign).
CREATE OR REPLACE VIEW v_transaction_ledger AS
SELECT e.transaction_id, a.bucket, e.currency,
       sum(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END) AS net_credit
  FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
 WHERE e.transaction_id IS NOT NULL
 GROUP BY e.transaction_id, a.bucket, e.currency;

-- ---------------------------------------------------------------------------
-- Settlement accounts (platform bank accounts) with maker-checker changes.
-- The real account number lives in the secret manager; DB holds a pointer + mask.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settlement_accounts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label            text NOT NULL,
  purpose          text NOT NULL CHECK (purpose IN ('PLATFORM_REVENUE','TAX','OPERATIONS')),
  bank_code        text NOT NULL CHECK (bank_code ~ '^[A-Z0-9_]{2,20}$'),
  secret_ref       text NOT NULL CHECK (secret_ref ~ '^[a-z][a-z0-9+.-]*://\S+$' AND secret_ref !~ '[0-9]{8,}'),
  account_mask     text NOT NULL CHECK (account_mask ~ '^\*{4}[0-9]{2,4}$'),
  holder_name_mask text NOT NULL,
  currency         char(3) NOT NULL DEFAULT 'IDR' REFERENCES currencies(code),
  status           text NOT NULL DEFAULT 'PENDING_APPROVAL' CHECK (status IN ('PENDING_APPROVAL','ACTIVE','DISABLED')),
  is_primary       boolean NOT NULL DEFAULT false,
  created_by       uuid REFERENCES users(id),
  approved_by      uuid REFERENCES users(id),
  activated_at     timestamptz,
  disabled_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT is_primary OR status = 'ACTIVE'),
  CHECK (approved_by IS NULL OR approved_by IS DISTINCT FROM created_by)
);
CREATE UNIQUE INDEX IF NOT EXISTS settlement_accounts_one_primary ON settlement_accounts (purpose, currency) WHERE is_primary;
CREATE INDEX IF NOT EXISTS settlement_accounts_currency_idx ON settlement_accounts (currency);
CREATE INDEX IF NOT EXISTS settlement_accounts_created_by_idx ON settlement_accounts (created_by);
CREATE INDEX IF NOT EXISTS settlement_accounts_approved_by_idx ON settlement_accounts (approved_by);
SELECT jk_attach_updated_at('settlement_accounts');

CREATE TABLE IF NOT EXISTS settlement_account_changes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_account_id uuid REFERENCES settlement_accounts(id),
  change_type           text NOT NULL CHECK (change_type IN ('CREATE','UPDATE','DISABLE','SET_PRIMARY')),
  proposed              jsonb NOT NULL DEFAULT '{}',
  reason                text NOT NULL CHECK (char_length(reason) >= 10),
  requested_by          uuid NOT NULL REFERENCES users(id),
  requested_at          timestamptz NOT NULL DEFAULT now(),
  requester_mfa_at      timestamptz NOT NULL,
  approved_by           uuid REFERENCES users(id),
  approver_mfa_at       timestamptz,
  rejected_by           uuid REFERENCES users(id),
  status                text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','APPLIED','EXPIRED')),
  decision_note         text,
  decided_at            timestamptz,
  applied_at            timestamptz,
  expires_at            timestamptz NOT NULL DEFAULT now() + interval '72 hours',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlement_changes_maker_checker CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CHECK (jsonb_typeof(proposed) = 'object'),
  CHECK (proposed::text !~ '[0-9]{8,}'),                        -- masked values only, never a full account number
  CHECK (change_type = 'CREATE' OR settlement_account_id IS NOT NULL),
  CHECK (status NOT IN ('APPROVED','APPLIED') OR (approved_by IS NOT NULL AND approver_mfa_at IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (status <> 'REJECTED' OR (rejected_by IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (status <> 'APPLIED' OR applied_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS settlement_changes_account_idx ON settlement_account_changes (settlement_account_id);
CREATE INDEX IF NOT EXISTS settlement_changes_requested_by_idx ON settlement_account_changes (requested_by);
CREATE INDEX IF NOT EXISTS settlement_changes_approved_by_idx ON settlement_account_changes (approved_by);
CREATE INDEX IF NOT EXISTS settlement_changes_rejected_by_idx ON settlement_account_changes (rejected_by);
CREATE INDEX IF NOT EXISTS settlement_changes_pending_idx ON settlement_account_changes (expires_at) WHERE status IN ('PENDING','APPROVED');
SELECT jk_attach_updated_at('settlement_account_changes');

-- Maker-checker guard. MFA step-up must be fresh (15 minutes) for both parties.
-- Approver must hold the FINANCE_SUPER_ADMIN role AND finance.settlement.approve_change.
CREATE OR REPLACE FUNCTION jk_settlement_change_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_mutable constant text[] := ARRAY['status','approved_by','approver_mfa_at','rejected_by','decision_note',
                                     'decided_at','applied_at','settlement_account_id','updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = 'JK001', MESSAGE = 'settlement_account_changes is append-only history';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING' OR NEW.approved_by IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'JK422', MESSAGE = 'settlement change must be created as PENDING without approver';
    END IF;
    IF NOT jk_user_has_permission(NEW.requested_by, 'finance.settlement.request_change') THEN
      RAISE EXCEPTION USING ERRCODE = 'JK403', MESSAGE = 'requester lacks finance.settlement.request_change';
    END IF;
    IF NEW.requester_mfa_at < now() - interval '15 minutes' OR NEW.requester_mfa_at > now() + interval '1 minute' THEN
      RAISE EXCEPTION USING ERRCODE = 'JK403', MESSAGE = 'requester MFA step-up is stale (> 15 minutes)';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('APPLIED','REJECTED','EXPIRED') THEN
    RAISE EXCEPTION USING ERRCODE = 'JK001', MESSAGE = format('settlement change %s is %s and immutable', OLD.id, OLD.status);
  END IF;
  IF (to_jsonb(OLD) - v_mutable) IS DISTINCT FROM (to_jsonb(NEW) - v_mutable) THEN
    RAISE EXCEPTION USING ERRCODE = 'JK001', MESSAGE = 'settlement change request content is immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'PENDING'  AND NEW.status IN ('APPROVED','REJECTED','EXPIRED'))
         OR (OLD.status = 'APPROVED' AND NEW.status IN ('APPLIED','EXPIRED'))) THEN
      RAISE EXCEPTION USING ERRCODE = 'JK422', MESSAGE = format('illegal settlement change transition %s -> %s', OLD.status, NEW.status);
    END IF;
    IF NEW.status = 'APPROVED' THEN
      IF NEW.approved_by IS NULL OR NEW.approved_by = NEW.requested_by THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'settlement_changes_maker_checker',
          MESSAGE = 'approver must be a different user than the requester';
      END IF;
      IF NOT (jk_user_has_role(NEW.approved_by, 'FINANCE_SUPER_ADMIN')
              AND jk_user_has_permission(NEW.approved_by, 'finance.settlement.approve_change')) THEN
        RAISE EXCEPTION USING ERRCODE = 'JK403', MESSAGE = 'approver must hold FINANCE_SUPER_ADMIN with finance.settlement.approve_change';
      END IF;
      IF NEW.approver_mfa_at IS NULL OR NEW.approver_mfa_at < now() - interval '15 minutes' THEN
        RAISE EXCEPTION USING ERRCODE = 'JK403', MESSAGE = 'approver MFA step-up is stale (> 15 minutes)';
      END IF;
      IF OLD.expires_at <= now() THEN
        RAISE EXCEPTION USING ERRCODE = 'JK422', MESSAGE = 'settlement change request has expired';
      END IF;
      NEW.decided_at := coalesce(NEW.decided_at, now());
    ELSIF NEW.status = 'REJECTED' THEN
      NEW.decided_at := coalesce(NEW.decided_at, now());
    ELSIF NEW.status = 'APPLIED' THEN
      IF coalesce(current_setting('jk.fsm_ctx', true), '') <> 'settlement_account_changes:' || OLD.id THEN
        RAISE EXCEPTION USING ERRCODE = 'JK422', MESSAGE = 'use apply_settlement_account_change() to apply';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER trg_settlement_change_guard BEFORE INSERT OR UPDATE OR DELETE ON settlement_account_changes
  FOR EACH ROW EXECUTE FUNCTION jk_settlement_change_guard();

-- settlement_accounts can only be written by apply_settlement_account_change().
CREATE OR REPLACE FUNCTION jk_settlement_account_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = 'JK001', MESSAGE = 'settlement accounts are never deleted; DISABLE them via a change request';
  END IF;
  IF coalesce(current_setting('jk.fsm_ctx', true), '') NOT LIKE 'settlement_account_changes:%' THEN
    RAISE EXCEPTION USING ERRCODE = 'JK422',
      MESSAGE = 'settlement_accounts can only change through an approved settlement_account_changes request',
      HINT = 'Create a change request, get it approved by FINANCE_SUPER_ADMIN, then apply_settlement_account_change().';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER trg_settlement_account_guard BEFORE INSERT OR UPDATE OR DELETE ON settlement_accounts
  FOR EACH ROW EXECUTE FUNCTION jk_settlement_account_guard();

CREATE OR REPLACE FUNCTION apply_settlement_account_change(p_change uuid, p_actor uuid)
RETURNS settlement_accounts
LANGUAGE plpgsql AS $$
DECLARE
  c settlement_account_changes%ROWTYPE;
  a settlement_accounts%ROWTYPE;
  p jsonb;
  v_before jsonb;
BEGIN
  SELECT * INTO c FROM settlement_account_changes WHERE id = p_change FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'JK404', MESSAGE = format('settlement change %s not found', p_change); END IF;
  IF c.status <> 'APPROVED' THEN
    RAISE EXCEPTION USING ERRCODE = 'JK422', MESSAGE = format('settlement change %s is %s, expected APPROVED', p_change, c.status);
  END IF;
  IF c.expires_at <= now() THEN
    RAISE EXCEPTION USING ERRCODE = 'JK422', MESSAGE = format('settlement change %s expired', p_change);
  END IF;
  p := c.proposed;
  PERFORM set_config('jk.fsm_ctx', 'settlement_account_changes:' || c.id, true);

  IF c.change_type = 'CREATE' THEN
    INSERT INTO settlement_accounts (label, purpose, bank_code, secret_ref, account_mask, holder_name_mask, currency,
                                     status, is_primary, created_by, approved_by, activated_at)
    VALUES (p->>'label', p->>'purpose', p->>'bankCode', p->>'secretRef', p->>'accountMask', p->>'holderNameMask',
            coalesce(p->>'currency', 'IDR'), 'ACTIVE', false, c.requested_by, c.approved_by, now())
    RETURNING * INTO a;
  ELSE
    SELECT * INTO a FROM settlement_accounts WHERE id = c.settlement_account_id FOR UPDATE;
    v_before := to_jsonb(a) - 'secret_ref';
    IF c.change_type = 'UPDATE' THEN
      UPDATE settlement_accounts
         SET label = coalesce(p->>'label', label), bank_code = coalesce(p->>'bankCode', bank_code),
             secret_ref = coalesce(p->>'secretRef', secret_ref), account_mask = coalesce(p->>'accountMask', account_mask),
             holder_name_mask = coalesce(p->>'holderNameMask', holder_name_mask), approved_by = c.approved_by
       WHERE id = a.id RETURNING * INTO a;
    ELSIF c.change_type = 'DISABLE' THEN
      UPDATE settlement_accounts SET status = 'DISABLED', is_primary = false, disabled_at = now(), approved_by = c.approved_by
       WHERE id = a.id RETURNING * INTO a;
    END IF;
  END IF;
  IF c.change_type = 'SET_PRIMARY' OR (c.change_type = 'CREATE' AND coalesce((p->>'isPrimary')::boolean, false)) THEN
    UPDATE settlement_accounts SET is_primary = false
     WHERE purpose = a.purpose AND currency = a.currency AND is_primary AND id <> a.id;
    UPDATE settlement_accounts SET is_primary = true, approved_by = c.approved_by WHERE id = a.id RETURNING * INTO a;
  END IF;

  UPDATE settlement_account_changes
     SET status = 'APPLIED', applied_at = now(), settlement_account_id = a.id
   WHERE id = c.id;
  PERFORM set_config('jk.fsm_ctx', '', true);

  PERFORM jk_audit('ADMIN', p_actor, 'finance.settlement_change_applied', 'settlement_account', a.id::text,
                   v_before, to_jsonb(a) - 'secret_ref',
                   jsonb_build_object('changeId', c.id, 'changeType', c.change_type,
                                      'requestedBy', c.requested_by, 'approvedBy', c.approved_by));
  RETURN a;
END $$;

-- ---------------------------------------------------------------------------
-- Reconciliation (provider reports vs internal payments/refunds/payouts)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider       text NOT NULL CHECK (provider IN ('XENDIT','MOCK','BANK')),
  provider_env   text NOT NULL CHECK (provider_env IN ('TEST','LIVE')),
  period_start   timestamptz NOT NULL,
  period_end     timestamptz NOT NULL,
  status         text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','MATCHED','COMPLETED_WITH_DIFFS','FAILED')),
  totals         jsonb NOT NULL DEFAULT '{}',
  report_file_id uuid REFERENCES files(id),
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  created_by     uuid REFERENCES users(id),
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end > period_start)
);
CREATE INDEX IF NOT EXISTS reconciliation_runs_period_idx ON reconciliation_runs (provider, period_start DESC);
CREATE INDEX IF NOT EXISTS reconciliation_runs_report_file_idx ON reconciliation_runs (report_file_id);
CREATE INDEX IF NOT EXISTS reconciliation_runs_created_by_idx ON reconciliation_runs (created_by);
SELECT jk_attach_updated_at('reconciliation_runs');

CREATE TABLE IF NOT EXISTS reconciliation_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              uuid NOT NULL REFERENCES reconciliation_runs(id),
  item_type           text NOT NULL CHECK (item_type IN ('PAYMENT','REFUND','PAYOUT','FEE','SETTLEMENT')),
  internal_ref        uuid,
  provider_ref        text,
  internal_amount_idr bigint,
  provider_amount_idr bigint,
  diff_idr            bigint GENERATED ALWAYS AS (coalesce(provider_amount_idr, 0) - coalesce(internal_amount_idr, 0)) STORED,
  status              text NOT NULL CHECK (status IN ('MATCHED','MISMATCH','MISSING_INTERNAL','MISSING_PROVIDER','RESOLVED')),
  resolution_note     text,
  resolved_by         uuid REFERENCES users(id),
  resolved_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'RESOLVED' OR (resolved_by IS NOT NULL AND resolution_note IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS reconciliation_items_run_idx ON reconciliation_items (run_id, status);
CREATE INDEX IF NOT EXISTS reconciliation_items_open_idx ON reconciliation_items (created_at) WHERE status IN ('MISMATCH','MISSING_INTERNAL','MISSING_PROVIDER');
CREATE INDEX IF NOT EXISTS reconciliation_items_resolved_by_idx ON reconciliation_items (resolved_by);
CREATE INDEX IF NOT EXISTS reconciliation_items_internal_ref_idx ON reconciliation_items (internal_ref);
SELECT jk_attach_updated_at('reconciliation_items');

COMMIT;
