-- 0010_growth.sql
-- Referrals, JastipKita Credit (append-only credit ledger), promotions.
BEGIN;

CREATE TABLE IF NOT EXISTS referrals (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id               uuid NOT NULL REFERENCES users(id),
  referee_id                uuid NOT NULL UNIQUE REFERENCES users(id),
  program                   text NOT NULL CHECK (program IN ('BUYER','TRAVELER')),
  variant                   text,
  status                    text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','QUALIFIED','REWARDED','REJECTED','EXPIRED')),
  qualifying_transaction_id uuid REFERENCES transactions(id),
  referrer_reward_idr       bigint NOT NULL DEFAULT 0 CHECK (referrer_reward_idr >= 0),
  referee_reward_idr        bigint NOT NULL DEFAULT 0 CHECK (referee_reward_idr >= 0),
  config_version            integer,
  fraud_reasons             jsonb NOT NULL DEFAULT '[]',
  qualified_at              timestamptz,
  rewarded_at               timestamptz,
  expires_at                timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (referrer_id <> referee_id),
  CHECK (status NOT IN ('QUALIFIED','REWARDED') OR qualifying_transaction_id IS NOT NULL),
  CHECK (status <> 'REWARDED' OR rewarded_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS referrals_referrer_idx ON referrals (referrer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS referrals_qualifying_tx_idx ON referrals (qualifying_transaction_id);
CREATE INDEX IF NOT EXISTS referrals_pending_idx ON referrals (expires_at) WHERE status IN ('PENDING','QUALIFIED');
SELECT jk_attach_updated_at('referrals');

-- Credit ledger: balance = SUM(amount_idr). Expiry is written as explicit negative
-- EXPIRY rows by a job, so the balance never depends on "now()".
CREATE TABLE IF NOT EXISTS credit_entries (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id),
  amount_idr      bigint NOT NULL CHECK (amount_idr <> 0),
  reason          text NOT NULL CHECK (reason IN ('REFERRAL_REWARD','PROMO_CASHBACK','CHECKOUT_REDEEM','REDEEM_REVERSAL','EXPIRY','ADMIN_ADJUST')),
  reference_type  text CHECK (reference_type ~ '^[a-z_]+$'),
  reference_id    uuid,
  expires_at      timestamptz,
  created_by      uuid REFERENCES users(id),
  idempotency_key text UNIQUE,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (reason NOT IN ('REFERRAL_REWARD','PROMO_CASHBACK','REDEEM_REVERSAL') OR amount_idr > 0),
  CHECK (reason NOT IN ('CHECKOUT_REDEEM','EXPIRY') OR amount_idr < 0),
  CHECK (expires_at IS NULL OR amount_idr > 0),
  CHECK (reason <> 'ADMIN_ADJUST' OR (created_by IS NOT NULL AND note IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS credit_entries_user_idx ON credit_entries (user_id, id);
CREATE INDEX IF NOT EXISTS credit_entries_expiry_idx ON credit_entries (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS credit_entries_reference_idx ON credit_entries (reference_type, reference_id);
CREATE INDEX IF NOT EXISTS credit_entries_created_by_idx ON credit_entries (created_by);
SELECT jk_make_append_only('credit_entries');

-- Serialize per user and forbid a negative balance.
CREATE OR REPLACE FUNCTION jk_credit_non_negative() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_balance bigint;
BEGIN
  IF NEW.amount_idr < 0 THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('credit:' || NEW.user_id, 0));
    SELECT coalesce(sum(amount_idr), 0) INTO v_balance FROM credit_entries WHERE user_id = NEW.user_id;
    IF v_balance + NEW.amount_idr < 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'JKC01',
        MESSAGE = format('credit balance of user %s would become negative (%s + %s)', NEW.user_id, v_balance, NEW.amount_idr);
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER trg_credit_non_negative BEFORE INSERT ON credit_entries
  FOR EACH ROW EXECUTE FUNCTION jk_credit_non_negative();

CREATE OR REPLACE VIEW credit_balances AS
SELECT user_id,
       sum(amount_idr) AS balance_idr,
       sum(amount_idr) FILTER (WHERE amount_idr > 0) AS earned_idr,
       -sum(amount_idr) FILTER (WHERE amount_idr < 0) AS used_or_expired_idr,
       min(expires_at) FILTER (WHERE expires_at > now()) AS next_expiry_at,
       max(created_at) AS last_entry_at
  FROM credit_entries GROUP BY user_id;

CREATE TABLE IF NOT EXISTS promotions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                 citext UNIQUE CHECK (code IS NULL OR code ~ '^[A-Za-z0-9_-]{3,32}$'),
  name                 text NOT NULL,
  description          text,
  type                 text NOT NULL CHECK (type IN ('PROMO_CODE','FIRST_TRANSACTION','COUNTRY','TRAVELER','CAMPAIGN','CASHBACK','FREE_PLATFORM_FEE')),
  conditions           jsonb NOT NULL DEFAULT '{}',
  benefit              jsonb NOT NULL,
  budget_total_idr     bigint CHECK (budget_total_idr IS NULL OR budget_total_idr > 0),
  budget_used_idr      bigint NOT NULL DEFAULT 0 CHECK (budget_used_idr >= 0),
  usage_limit_total    integer CHECK (usage_limit_total IS NULL OR usage_limit_total > 0),
  usage_count          integer NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  usage_limit_per_user integer CHECK (usage_limit_per_user IS NULL OR usage_limit_per_user > 0),
  starts_at            timestamptz NOT NULL,
  ends_at              timestamptz,
  status               text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','PAUSED','ENDED')),
  funded_by            text NOT NULL DEFAULT 'PLATFORM' CHECK (funded_by IN ('PLATFORM','PARTNER','MERCHANT','TRAVELER')),
  created_by           uuid REFERENCES users(id),
  approved_by          uuid REFERENCES users(id),
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  CHECK (budget_total_idr IS NULL OR budget_used_idr <= budget_total_idr),
  CHECK (usage_limit_total IS NULL OR usage_count <= usage_limit_total),
  CHECK (type <> 'PROMO_CODE' OR code IS NOT NULL),
  CHECK (approved_by IS NULL OR approved_by IS DISTINCT FROM created_by)
);
CREATE INDEX IF NOT EXISTS promotions_active_idx ON promotions (starts_at, ends_at) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS promotions_created_by_idx ON promotions (created_by);
CREATE INDEX IF NOT EXISTS promotions_approved_by_idx ON promotions (approved_by);
SELECT jk_attach_updated_at('promotions');

CREATE TABLE IF NOT EXISTS promotion_redemptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id   uuid NOT NULL REFERENCES promotions(id),
  user_id        uuid NOT NULL REFERENCES users(id),
  transaction_id uuid NOT NULL REFERENCES transactions(id),
  quote_id       uuid REFERENCES quotes(id),
  amount_idr     bigint NOT NULL CHECK (amount_idr > 0),
  status         text NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED','APPLIED','REVERSED','EXPIRED')),
  reserved_at    timestamptz NOT NULL DEFAULT now(),
  applied_at     timestamptz,
  reversed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (promotion_id, transaction_id)
);
CREATE INDEX IF NOT EXISTS promotion_redemptions_user_idx ON promotion_redemptions (promotion_id, user_id) WHERE status IN ('RESERVED','APPLIED');
CREATE INDEX IF NOT EXISTS promotion_redemptions_user_id_idx ON promotion_redemptions (user_id);
CREATE INDEX IF NOT EXISTS promotion_redemptions_tx_idx ON promotion_redemptions (transaction_id);
CREATE INDEX IF NOT EXISTS promotion_redemptions_quote_idx ON promotion_redemptions (quote_id);
SELECT jk_attach_updated_at('promotion_redemptions');

COMMIT;
