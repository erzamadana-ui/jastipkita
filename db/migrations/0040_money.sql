-- 0040_money.sql
-- Money module group (SafePay): columns and tables the money services need beyond 0008/0009.
--   1. transactions: purchase ceiling (golden rule: traveler may never buy above it) + payout hold flag
--   2. quotes.meta: quote-level evidence (payment channel, promo/credit, restricted classification,
--      limits, FX lock snapshot) that has no line of its own
--   3. refunds/payouts: attempt counters (system retry budget §15.6 / §15.7)
--   4. refund_destinations: buyer bank account for refunds on channels that cannot be refunded
--      (e.g. Virtual Account) — encrypted, masked, validated
-- Irreversible only in the sense that dropping these would lose financial evidence; all changes are
-- additive (nullable/defaulted columns, one new table).
BEGIN;

-- 1. ------------------------------------------------------------------------
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS purchase_ceiling_minor bigint;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS purchase_ceiling_idr bigint;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS purchase_approved_at timestamptz;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payout_hold_reason text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_purchase_ceiling_check') THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_purchase_ceiling_check
      CHECK ((purchase_ceiling_minor IS NULL OR purchase_ceiling_minor >= 0)
         AND (purchase_ceiling_idr IS NULL OR purchase_ceiling_idr >= 0));
  END IF;
END $$;
COMMENT ON COLUMN transactions.purchase_ceiling_minor IS
  'Approved item price (all units, item currency minor units). Set at PURCHASE_APPROVED; purchase proofs above it are rejected.';
COMMENT ON COLUMN transactions.purchase_ceiling_idr IS 'purchase_ceiling_minor converted at the quote FX lock (IDR).';
COMMENT ON COLUMN transactions.payout_hold_reason IS
  'Set by the money services when a risk signal (flagged purchase proof, PIN brute force, amount mismatch) must hold the traveler payout.';

-- 2. ------------------------------------------------------------------------
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}';
COMMENT ON COLUMN quotes.meta IS
  'Quote-level evidence written at insert: paymentChannel, promotion, credit, restricted, limits, fx snapshot, adjustments.';

-- 3. ------------------------------------------------------------------------
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refunds_attempts_check') THEN
    ALTER TABLE refunds ADD CONSTRAINT refunds_attempts_check CHECK (attempts >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payouts_attempts_check') THEN
    ALTER TABLE payouts ADD CONSTRAINT payouts_attempts_check CHECK (attempts >= 0);
  END IF;
END $$;

-- 4. ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refund_destinations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_id           uuid NOT NULL REFERENCES refunds(id),
  buyer_id            uuid NOT NULL REFERENCES users(id),
  bank_code           text NOT NULL CHECK (bank_code ~ '^[A-Z0-9_]{2,20}$'),
  account_number_enc  bytea NOT NULL,
  account_number_hash bytea NOT NULL,
  account_mask        text NOT NULL CHECK (account_mask ~ '^\*{4}[0-9]{2,4}$'),
  holder_name_enc     bytea NOT NULL,
  enc_key_id          text NOT NULL,
  validation_status   text NOT NULL CHECK (validation_status IN ('VALID','INVALID','UNAVAILABLE')),
  validated_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (validation_status <> 'VALID' OR validated_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS refund_destinations_refund_uq ON refund_destinations (refund_id);
CREATE INDEX IF NOT EXISTS refund_destinations_buyer_idx ON refund_destinations (buyer_id);
CREATE INDEX IF NOT EXISTS refund_destinations_number_hash_idx ON refund_destinations (account_number_hash);
SELECT jk_attach_updated_at('refund_destinations');

-- Money job queries
CREATE INDEX IF NOT EXISTS transactions_buyer_confirmed_idx ON transactions (status_changed_at) WHERE status = 'BUYER_CONFIRMED';
CREATE INDEX IF NOT EXISTS price_confirmations_clarify_expiry_idx ON price_confirmations (expires_at) WHERE status = 'CLARIFICATION_REQUESTED';
CREATE INDEX IF NOT EXISTS payments_pending_created_idx ON payments (created_at) WHERE status = 'PENDING';

SELECT jk_apply_grants();

COMMIT;
