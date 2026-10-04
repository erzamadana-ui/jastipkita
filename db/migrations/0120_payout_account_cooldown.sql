-- 0120_payout_account_cooldown.sql
-- New payout account cooldown (anti account-takeover; CEO decision 2026-10-04, docs/api/money.md §5.7).
-- A traveler payout account that was added, verified or made the default less than
-- money.policy.newPayoutAccountCooldownHours ago (default 24) receives no payout yet: the API computes
--   ready_at = greatest(created_at, verified_at, default_since) + cooldown
-- at scheduling AND at processing time, so a config change applies to every pending payout.
--
--   payout_accounts.default_since  when the account most recently became the default; NULL while it is not the default.
--                                  Maintained by a trigger for every writer (API, admin override, removal fallback,
--                                  anonymize_user); a writer may set it explicitly in the same statement (the API uses
--                                  its injectable clock), otherwise now() is used. Immutable while the account stays default.
--
-- Forward-only, additive, idempotent (re-applied raw by db/scripts/test-db.sh).
BEGIN;

ALTER TABLE payout_accounts ADD COLUMN IF NOT EXISTS default_since timestamptz;
COMMENT ON COLUMN payout_accounts.default_since IS
  'When the account most recently became the default payout destination (NULL = not default). Input of the new-account payout cooldown (money.policy.newPayoutAccountCooldownHours).';

-- Existing defaults: no retroactive cooldown beyond what created/verified already imply.
UPDATE payout_accounts
   SET default_since = greatest(created_at, coalesce(verified_at, created_at))
 WHERE is_default AND default_since IS NULL;

CREATE OR REPLACE FUNCTION jk_payout_account_default_since() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW.is_default THEN
    NEW.default_since := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    NEW.default_since := coalesce(NEW.default_since, NEW.created_at, now());
  ELSIF NOT OLD.is_default THEN
    -- became the default in this statement: keep an explicit value (application clock), else the DB clock
    IF NEW.default_since IS NOT DISTINCT FROM OLD.default_since THEN
      NEW.default_since := now();
    END IF;
  ELSE
    -- stays the default: the timestamp cannot be moved (shortening it would shorten the cooldown)
    NEW.default_since := coalesce(OLD.default_since, NEW.default_since, now());
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER trg_payout_account_default_since
  BEFORE INSERT OR UPDATE OF is_default, default_since ON payout_accounts
  FOR EACH ROW EXECUTE FUNCTION jk_payout_account_default_since();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payout_accounts_default_since_chk') THEN
    ALTER TABLE payout_accounts ADD CONSTRAINT payout_accounts_default_since_chk
      CHECK (is_default = (default_since IS NOT NULL));
  END IF;
END $$;

SELECT jk_apply_grants();

COMMIT;
