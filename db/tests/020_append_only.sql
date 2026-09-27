-- 020_append_only.sql — trigger-level append-only enforcement. Runs as superuser on purpose:
-- triggers bind owners and superusers too (privileges are tested in 100_grants.sql).
BEGIN;
DO $$
DECLARE
  f jk_test.fx := jk_test.tx_fixture();
  v_journal uuid;
  v_hook bigint;
  r record;
BEGIN
  PERFORM transition_transaction(f.tx, 1, 'MATCHED', 'BUYER', f.buyer);
  v_journal := post_journal('TEST', 'append-only fixture',
    '[{"bucket":"PROVIDER_CASH","direction":"DEBIT","amount":1000},{"bucket":"CLEARING","direction":"CREDIT","amount":1000}]'::jsonb, f.tx);
  INSERT INTO credit_entries (user_id, amount_idr, reason, reference_type) VALUES (f.buyer, 25000, 'REFERRAL_REWARD', 'referral');
  INSERT INTO consents (user_id, type, version, granted) VALUES (f.buyer, 'TOS', '2026-09', true);
  INSERT INTO trust_scores (user_id, score) VALUES (f.buyer, 60);
  INSERT INTO fx_rates (base, quote, rate, source, as_of) VALUES ('JPY', 'IDR', 108.1234567890, 'test', now());
  INSERT INTO security_events (user_id, type, severity) VALUES (f.buyer, 'LOGIN_SUCCESS', 'LOW');
  INSERT INTO risk_assessments (subject_type, subject_id, score, decision, rules_version) VALUES ('TRANSACTION', f.tx, 10, 'ALLOW', 'v1');

  FOR r IN SELECT * FROM (VALUES
      ('transaction_events',  'reason = ''x'''),
      ('trip_events',         'reason = ''x'''),
      ('ledger_journals',     'description = ''x'''),
      ('ledger_entries',      'amount = amount + 1'),
      ('audit_logs',          'action = ''tampered.action'''),
      ('credit_entries',      'amount_idr = 999999'),
      ('consents',            'granted = false'),
      ('trust_score_history', 'score = 100'),
      ('fx_rates',            'rate = 1'),
      ('security_events',     'severity = ''CRITICAL'''),
      ('risk_assessments',    'decision = ''BLOCK''')) AS t(tbl, setexpr)
  LOOP
    PERFORM jk_test.throws(format('UPDATE %I SET %s', r.tbl, r.setexpr), 'JK001', r.tbl || ': UPDATE rejected');
    PERFORM jk_test.throws(format('DELETE FROM %I', r.tbl), 'JK001', r.tbl || ': DELETE rejected');
  END LOOP;
  -- (ledger tables have pending deferred constraint events in this transaction, which makes
  --  PostgreSQL refuse TRUNCATE with 55006 before our trigger; test the trigger on other tables)
  PERFORM jk_test.throws('TRUNCATE credit_entries', 'JK001', 'credit_entries: TRUNCATE rejected');
  PERFORM jk_test.throws('TRUNCATE transaction_events', 'JK001', 'transaction_events: TRUNCATE rejected');
  PERFORM jk_test.throws('TRUNCATE audit_logs', 'JK001', 'audit_logs: TRUNCATE rejected');

  -- webhook inbox: payload immutable, processing columns updatable
  INSERT INTO payment_webhook_events (provider, provider_env, event_id, event_type, signature_valid, payload)
  VALUES ('MOCK', 'TEST', 'evt_1', 'invoice.paid', true, '{"amount":1200000}') RETURNING id INTO v_hook;
  PERFORM jk_test.throws(format($s$UPDATE payment_webhook_events SET payload = '{"amount":1}' WHERE id = %s$s$, v_hook),
                         'JK001', 'payment_webhook_events.payload is immutable');
  PERFORM jk_test.throws(format($s$UPDATE payment_webhook_events SET signature_valid = false WHERE id = %s$s$, v_hook),
                         'JK001', 'payment_webhook_events.signature_valid is immutable');
  PERFORM jk_test.succeeds(format($s$UPDATE payment_webhook_events SET processed_at = now(), attempts = attempts + 1 WHERE id = %s$s$, v_hook),
                           'payment_webhook_events processing columns are updatable');
  PERFORM jk_test.throws(format($s$DELETE FROM payment_webhook_events WHERE id = %s$s$, v_hook), 'JK001', 'payment_webhook_events: DELETE rejected');
  PERFORM jk_test.throws($s$INSERT INTO payment_webhook_events (provider, provider_env, event_id, event_type, signature_valid, payload)
                           VALUES ('MOCK', 'TEST', 'evt_1', 'invoice.paid', true, '{}')$s$, '23505', 'webhook event_id unique per provider');

  -- quote lines are immutable pricing evidence; quotes only change status
  PERFORM jk_test.quote(f.tx);
  PERFORM jk_test.throws('UPDATE quote_lines SET amount_idr = 1', 'JK001', 'quote_lines: UPDATE rejected');
  PERFORM jk_test.throws('UPDATE quotes SET total_idr = 1', 'JK001', 'quotes.total_idr is immutable');
  PERFORM jk_test.succeeds($s$UPDATE quotes SET status = 'ACCEPTED', accepted_at = now()$s$, 'quotes.status is updatable');
  PERFORM jk_test.throws($s$UPDATE quotes SET status = 'ACTIVE'$s$, 'JK422', 'quote ACCEPTED -> ACTIVE rejected by FSM');

  -- outbox: content immutable, delivery bookkeeping mutable, unpublished rows undeletable
  PERFORM jk_test.throws('UPDATE outbox_events SET payload = ''{}''', 'JK001', 'outbox_events payload immutable');
  PERFORM jk_test.throws('DELETE FROM outbox_events', 'JK001', 'unpublished outbox_events cannot be deleted');
END $$;
ROLLBACK;
