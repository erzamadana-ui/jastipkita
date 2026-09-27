-- 100_grants.sql — role privileges: jk_app (DML, append-only = SELECT/INSERT) and jk_readonly
-- (no *_enc / *_hash / contact PII). Privilege checks happen before triggers, so errors are 42501.

-- ---------- catalog-wide invariants (as superuser) ----------
BEGIN;
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO v_bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'trg_append_only')
     AND (has_table_privilege('jk_app', c.oid, 'UPDATE') OR has_table_privilege('jk_app', c.oid, 'DELETE'));
  PERFORM jk_test.ok(v_bad IS NULL, 'jk_app has no UPDATE/DELETE on any append-only table' || coalesce(' — offenders: ' || v_bad, ''));

  SELECT string_agg(c.relname, ', ') INTO v_bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND (has_table_privilege('jk_app', c.oid, 'TRUNCATE') OR has_table_privilege('jk_app', c.oid, 'TRIGGER')
          OR has_table_privilege('jk_app', c.oid, 'REFERENCES') OR has_table_privilege('jk_readonly', c.oid, 'INSERT'));
  PERFORM jk_test.ok(v_bad IS NULL, 'no TRUNCATE/TRIGGER/REFERENCES for jk_app, no writes for jk_readonly' || coalesce(' — ' || v_bad, ''));

  SELECT string_agg(a.attrelid::regclass || '.' || a.attname, ', ') INTO v_bad
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r','v') AND a.attnum > 0 AND NOT a.attisdropped
     AND (a.attname ~ '(_enc|_hash)$' OR a.attname IN ('email','phone_e164','password_hash','secret_ref','body','payload'))
     AND has_column_privilege('jk_readonly', a.attrelid, a.attnum, 'SELECT');
  PERFORM jk_test.ok(v_bad IS NULL, 'jk_readonly cannot SELECT any *_enc/*_hash/contact/secret/body column' || coalesce(' — ' || v_bad, ''));

  PERFORM jk_test.ok(NOT has_schema_privilege('jk_app', 'public', 'CREATE') AND NOT has_schema_privilege('jk_readonly', 'public', 'CREATE'),
                     'runtime roles cannot CREATE in schema public');
  PERFORM jk_test.ok((SELECT bool_and(tableowner = 'jk_migrator') FROM pg_tables WHERE schemaname = 'public'), 'all tables owned by jk_migrator');
  PERFORM jk_test.ok(NOT has_function_privilege('jk_app', 'jk_apply_grants()', 'EXECUTE'), 'jk_app cannot run DDL helper jk_apply_grants()');
  PERFORM jk_test.ok(NOT has_function_privilege('jk_readonly', 'anonymize_user(uuid,uuid,boolean)', 'EXECUTE'), 'jk_readonly cannot execute anonymize_user');
  PERFORM jk_test.ok(has_function_privilege('jk_app', 'transition_transaction(uuid,integer,text,text,uuid,text,jsonb)', 'EXECUTE'),
                     'jk_app can execute transition_transaction');
END $$;
ROLLBACK;

-- ---------- behaviour as jk_app ----------
BEGIN;
SET LOCAL ROLE jk_app;
DO $$
DECLARE
  f jk_test.fx;
  v_hook bigint;
BEGIN
  -- full business flow works with runtime privileges only (incl. SECURITY DEFINER audit chain)
  f := jk_test.tx_fixture();
  PERFORM transition_transaction(f.tx, 1, 'MATCHED', 'BUYER', f.buyer);
  PERFORM jk_test.quote(f.tx);
  PERFORM post_journal('TEST', 'as jk_app', '[{"bucket":"PROVIDER_CASH","direction":"DEBIT","amount":10},{"bucket":"CLEARING","direction":"CREDIT","amount":10}]', f.tx);
  PERFORM jk_test.eq(verify_audit_chain(), NULL::bigint, 'jk_app: transitions + audit chain work with runtime privileges');

  PERFORM jk_test.throws('UPDATE transaction_events SET reason = ''x''', '42501', 'jk_app: UPDATE transaction_events denied');
  PERFORM jk_test.throws('DELETE FROM transaction_events', '42501', 'jk_app: DELETE transaction_events denied');
  PERFORM jk_test.throws('UPDATE ledger_entries SET amount = 1', '42501', 'jk_app: UPDATE ledger_entries denied');
  PERFORM jk_test.throws('DELETE FROM ledger_journals', '42501', 'jk_app: DELETE ledger_journals denied');
  PERFORM jk_test.throws('UPDATE audit_logs SET action = ''x.y''', '42501', 'jk_app: UPDATE audit_logs denied');
  PERFORM jk_test.throws('DELETE FROM audit_logs', '42501', 'jk_app: DELETE audit_logs denied');
  PERFORM jk_test.throws('UPDATE audit_chain_head SET last_id = 0', '42501', 'jk_app: cannot move the audit chain head');
  PERFORM jk_test.throws('DELETE FROM credit_entries', '42501', 'jk_app: DELETE credit_entries denied');
  PERFORM jk_test.throws('UPDATE quote_lines SET amount_idr = 0', '42501', 'jk_app: UPDATE quote_lines denied');
  PERFORM jk_test.throws('TRUNCATE jobs', '42501', 'jk_app: TRUNCATE denied');
  PERFORM jk_test.throws('CREATE TABLE evil (id int)', '42501', 'jk_app: DDL denied');
  PERFORM jk_test.throws('ALTER TABLE audit_logs DISABLE TRIGGER trg_append_only', '42501', 'jk_app: cannot disable guards');
  PERFORM jk_test.throws($s$INSERT INTO transaction_transitions VALUES ('MATCHED','COMPLETED',ARRAY['BUYER'],'x')$s$, '42501',
                         'jk_app: cannot edit state machine tables');
  PERFORM jk_test.throws('DELETE FROM settlement_account_changes', '42501', 'jk_app: no DELETE on maker-checker history');
  PERFORM jk_test.throws('DELETE FROM business_configs', '42501', 'jk_app: no DELETE on business_configs');

  INSERT INTO payment_webhook_events (provider, provider_env, event_id, event_type, signature_valid, payload)
  VALUES ('MOCK', 'TEST', 'evt_app', 'invoice.paid', true, '{}') RETURNING id INTO v_hook;
  PERFORM jk_test.throws(format('UPDATE payment_webhook_events SET payload = ''{"x":1}'' WHERE id = %s', v_hook), '42501',
                         'jk_app: webhook payload column not updatable (column grant)');
  PERFORM jk_test.succeeds(format('UPDATE payment_webhook_events SET processed_at = now(), attempts = 1 WHERE id = %s', v_hook),
                           'jk_app: webhook processing columns updatable');
  PERFORM jk_test.succeeds('SELECT count(*) FROM identity_records', 'jk_app: can read encrypted identity rows (to decrypt in API)');
END $$;
ROLLBACK;

-- ---------- behaviour as jk_readonly ----------
BEGIN;
SET LOCAL ROLE jk_readonly;
DO $$
BEGIN
  PERFORM jk_test.throws('SELECT id_number_enc FROM identity_records', '42501', 'jk_readonly: identity_records hidden');
  PERFORM jk_test.throws('SELECT account_number_enc FROM payout_accounts', '42501', 'jk_readonly: payout_accounts.account_number_enc denied');
  PERFORM jk_test.throws('SELECT * FROM payout_accounts', '42501', 'jk_readonly: SELECT * on a table with *_enc denied');
  PERFORM jk_test.succeeds('SELECT id, bank_code, account_mask, verification_status FROM payout_accounts', 'jk_readonly: masked payout columns readable');
  PERFORM jk_test.throws('SELECT address_enc FROM deliveries', '42501', 'jk_readonly: deliveries.address_enc denied');
  PERFORM jk_test.throws('SELECT secret_enc FROM mfa_factors', '42501', 'jk_readonly: mfa secrets denied');
  PERFORM jk_test.throws('SELECT email FROM users', '42501', 'jk_readonly: users.email denied');
  PERFORM jk_test.succeeds('SELECT id, kyc_level, status, country_code, created_at FROM users', 'jk_readonly: non-PII user columns readable');
  PERFORM jk_test.throws('SELECT body FROM messages', '42501', 'jk_readonly: chat bodies denied');
  PERFORM jk_test.throws('SELECT token_hash FROM refresh_tokens', '42501', 'jk_readonly: sessions denied');
  PERFORM jk_test.throws('SELECT payload FROM payment_webhook_events', '42501', 'jk_readonly: webhook payload denied');
  PERFORM jk_test.succeeds('SELECT * FROM transactions', 'jk_readonly: transactions readable');
  PERFORM jk_test.succeeds('SELECT * FROM ledger_balances', 'jk_readonly: ledger_balances view readable');
  PERFORM jk_test.succeeds('SELECT * FROM v_gmv_daily, v_take_rate, v_refund_rate, v_dispute_rate LIMIT 1', 'jk_readonly: metric views readable');
  PERFORM jk_test.succeeds('SELECT * FROM v_funnel_daily LIMIT 1', 'jk_readonly: v_funnel_daily readable');
  PERFORM jk_test.succeeds('SELECT * FROM v_traveler_utilization LIMIT 1', 'jk_readonly: v_traveler_utilization readable');
  PERFORM jk_test.throws('INSERT INTO faq_articles (slug, category, question, answer_md) VALUES (''x'',''GENERAL'',''q'',''a'')', '42501',
                         'jk_readonly: writes denied');
END $$;
ROLLBACK;

-- ---------- future tables & provider API roles (all inside a rolled-back transaction) ----------
BEGIN;
DO $$
BEGIN
  -- a table created later by the migrator gets jk_app DML via default privileges, nothing for jk_readonly
  SET LOCAL ROLE jk_migrator;
  CREATE TABLE jk_future_table (id uuid PRIMARY KEY, note text, token_enc bytea);
  RESET ROLE;
  PERFORM jk_test.ok(has_table_privilege('jk_app', 'jk_future_table', 'INSERT'), 'default privileges: new table writable by jk_app');
  PERFORM jk_test.ok(NOT has_table_privilege('jk_readonly', 'jk_future_table', 'SELECT'), 'default privileges: new table hidden from jk_readonly until classified');
  PERFORM jk_apply_grants();
  PERFORM jk_test.ok(has_column_privilege('jk_readonly', 'jk_future_table', 'note', 'SELECT')
                     AND NOT has_column_privilege('jk_readonly', 'jk_future_table', 'token_enc', 'SELECT'),
                     'jk_apply_grants(): readonly gets non-sensitive columns only');

  -- Supabase-style API roles lose any table access (CREATE ROLE is transactional; rolled back below)
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
    GRANT SELECT ON users, transactions TO anon;
    PERFORM jk_apply_grants();
    PERFORM jk_test.ok(NOT has_table_privilege('anon', 'users', 'SELECT') AND NOT has_table_privilege('anon', 'transactions', 'SELECT'),
                       'jk_apply_grants(): provider API role "anon" stripped of table access');
  END IF;
END $$;
ROLLBACK;
