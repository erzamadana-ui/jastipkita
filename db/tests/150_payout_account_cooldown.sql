-- 150_payout_account_cooldown.sql — migration 0120 (new payout account cooldown, CEO decision 2026-10-04).
--   payout_accounts.default_since is maintained by a trigger for every writer: set when an account becomes the default
--   (explicit value of the same statement wins, else now()), immutable while it stays default, NULL when it is not.

BEGIN;
DO $$
DECLARE
  u uuid := jk_test.user('cooldown', 4::smallint);
  a1 uuid; a2 uuid;
  v_since timestamptz;
  v_explicit timestamptz := now() - interval '3 hours';
BEGIN
  INSERT INTO payout_accounts (user_id, bank_code, account_number_enc, account_number_hash, account_mask, holder_name, enc_key_id,
                               verification_status, verified_at, is_default, created_at)
  VALUES (u, 'BCA', '\x01', sha256('BCA:1110001111'::bytea), '****1111', 'COOLDOWN', 'k1', 'VERIFIED', now(), true, now() - interval '2 days')
  RETURNING id INTO a1;
  SELECT default_since INTO v_since FROM payout_accounts WHERE id = a1;
  PERFORM jk_test.eq(v_since, now() - interval '2 days', 'default account inserted without default_since gets created_at');

  INSERT INTO payout_accounts (user_id, bank_code, account_number_enc, account_number_hash, account_mask, holder_name, enc_key_id,
                               verification_status, verified_at, is_default)
  VALUES (u, 'BNI', '\x02', sha256('BNI:2220002222'::bytea), '****2222', 'COOLDOWN', 'k1', 'VERIFIED', now(), false)
  RETURNING id INTO a2;
  PERFORM jk_test.ok((SELECT default_since IS NULL FROM payout_accounts WHERE id = a2), 'non-default account has no default_since');

  -- switch the default without an explicit time: the DB clock is used
  UPDATE payout_accounts SET is_default = false WHERE id = a1;
  UPDATE payout_accounts SET is_default = true WHERE id = a2;
  PERFORM jk_test.ok((SELECT default_since IS NULL FROM payout_accounts WHERE id = a1), 'losing the default clears default_since');
  PERFORM jk_test.eq((SELECT default_since FROM payout_accounts WHERE id = a2), now(), 'becoming the default stamps now() when no value is given');

  -- staying default: default_since cannot be moved back (would shorten the cooldown)
  UPDATE payout_accounts SET default_since = now() - interval '30 days' WHERE id = a2;
  PERFORM jk_test.eq((SELECT default_since FROM payout_accounts WHERE id = a2), now(), 'default_since is immutable while the account stays default');

  -- switch back with an explicit (application clock) value in the same statement
  UPDATE payout_accounts SET is_default = false WHERE id = a2;
  UPDATE payout_accounts SET is_default = true, default_since = v_explicit WHERE id = a1;
  PERFORM jk_test.eq((SELECT default_since FROM payout_accounts WHERE id = a1), v_explicit, 'explicit default_since of the same statement is kept');

  -- integrity: the CHECK holds even for writers that bypass the trigger's columns
  PERFORM jk_test.throws(format('ALTER TABLE payout_accounts DISABLE TRIGGER trg_payout_account_default_since; UPDATE payout_accounts SET default_since = NULL WHERE id = %L', a1),
                         '23514', 'a default account without default_since violates payout_accounts_default_since_chk');
  ALTER TABLE payout_accounts ENABLE TRIGGER trg_payout_account_default_since;

  -- anonymization drops the default and therefore default_since
  UPDATE payout_accounts SET account_number_enc = NULL, holder_name = 'REDACTED', is_default = false, disabled_at = now() WHERE id = a1;
  PERFORM jk_test.ok((SELECT default_since IS NULL FROM payout_accounts WHERE id = a1), 'anonymized/disabled account loses default_since');

  PERFORM jk_test.ok(has_column_privilege('jk_app', 'payout_accounts', 'default_since', 'SELECT,UPDATE'), 'jk_app can read and write default_since');
END $$;
ROLLBACK;
