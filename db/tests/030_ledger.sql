-- 030_ledger.sql — double-entry invariants. The real COMMIT-time rejection is exercised by
-- test-db.sh (separate session); here SET CONSTRAINTS ... IMMEDIATE forces the deferred check.
BEGIN;
DO $$
DECLARE
  f jk_test.fx := jk_test.tx_fixture();
  v_j uuid; v_j2 uuid; v_rev uuid;
  v_bal bigint;
  v_earning uuid;
  v_pf0 numeric; v_cash0 numeric;
BEGIN
  -- baselines make the test independent of rows committed by earlier runs
  SELECT coalesce(max(balance) FILTER (WHERE code = 'SYS:PRODUCT_FUND:IDR'), 0),
         coalesce(max(balance) FILTER (WHERE code = 'SYS:PROVIDER_CASH:IDR'), 0)
    INTO v_pf0, v_cash0 FROM ledger_balances;
  -- balanced journal accepted: buyer pays 1,200,000 into SafePay
  v_j := post_journal('PAYMENT_SECURED', 'SafePay checkout', jsonb_build_array(
           jsonb_build_object('bucket','PROVIDER_CASH','direction','DEBIT','amount',1200000),
           jsonb_build_object('bucket','PRODUCT_FUND','direction','CREDIT','amount',1000000),
           jsonb_build_object('bucket','TRAVELER_EARNING','ownerUserId',f.traveler,'direction','CREDIT','amount',150000),
           jsonb_build_object('bucket','PLATFORM_REVENUE','direction','CREDIT','amount',50000)),
         f.tx, 'pay:' || f.tx);
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  PERFORM jk_test.pass('balanced 4-leg journal accepted by deferred constraint');

  PERFORM jk_test.eq(post_journal('PAYMENT_SECURED', 'dup', '[]'::jsonb, f.tx, 'pay:' || f.tx), v_j,
                     'post_journal is idempotent on idempotency_key');
  PERFORM jk_test.eq((SELECT balance FROM ledger_balances WHERE code = 'SYS:PRODUCT_FUND:IDR') - v_pf0, 1000000::numeric,
                     'ledger_balances: PRODUCT_FUND credit-normal balance');
  PERFORM jk_test.eq((SELECT balance FROM ledger_balances WHERE code = 'SYS:PROVIDER_CASH:IDR') - v_cash0, 1200000::numeric,
                     'ledger_balances: PROVIDER_CASH debit-normal balance');
  PERFORM jk_test.eq((SELECT net_credit FROM v_transaction_ledger WHERE transaction_id = f.tx AND bucket = 'PRODUCT_FUND'), 1000000::numeric,
                     'v_transaction_ledger: escrow per transaction & bucket');
  SELECT account_id INTO v_earning FROM ledger_balances WHERE bucket = 'TRAVELER_EARNING' AND owner_user_id = f.traveler;
  PERFORM jk_test.ok(v_earning IS NOT NULL, 'per-traveler TRAVELER_EARNING account created on demand');
  PERFORM jk_test.eq((SELECT sum(debit_total) - sum(credit_total) FROM ledger_balances), 0::numeric,
                     'trial balance: total debits = total credits');

  -- reversal = compensating journal
  v_rev := reverse_journal(v_j, 'test reversal');
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  PERFORM jk_test.eq((SELECT balance FROM ledger_balances WHERE code = 'SYS:PRODUCT_FUND:IDR') - v_pf0, 0::numeric,
                     'reverse_journal nets the bucket back to its baseline');
  PERFORM jk_test.throws(format($s$SELECT reverse_journal(%L, 'again')$s$, v_j), '23505', 'a journal can be reversed only once');

  -- unbalanced journal rejected when the deferred constraint fires
  BEGIN
    INSERT INTO ledger_journals (kind, description) VALUES ('TEST', 'unbalanced') RETURNING id INTO v_j2;
    INSERT INTO ledger_entries (journal_id, account_id, currency, direction, amount)
    SELECT v_j2, id, 'IDR', 'DEBIT', 500 FROM ledger_accounts WHERE code = 'SYS:CLEARING:IDR';
    INSERT INTO ledger_entries (journal_id, account_id, currency, direction, amount)
    SELECT v_j2, id, 'IDR', 'CREDIT', 400 FROM ledger_accounts WHERE code = 'SYS:PROVIDER_CASH:IDR';
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'FAIL: unbalanced journal was accepted';
  EXCEPTION WHEN SQLSTATE 'JKL02' THEN
    PERFORM jk_test.pass('unbalanced journal rejected (JKL02) at constraint check');
  END;
  SET CONSTRAINTS ALL DEFERRED;

  BEGIN
    INSERT INTO ledger_journals (kind, description) VALUES ('TEST', 'single leg') RETURNING id INTO v_j2;
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'FAIL: journal without entries accepted';
  EXCEPTION WHEN SQLSTATE 'JKL01' THEN
    PERFORM jk_test.pass('journal with < 2 entries rejected (JKL01)');
  END;
  SET CONSTRAINTS ALL DEFERRED;

  -- currency must match the account (composite FK)
  PERFORM jk_test.throws(format($s$
    WITH j AS (INSERT INTO ledger_journals (kind, description) VALUES ('TEST','fx') RETURNING id)
    INSERT INTO ledger_entries (journal_id, account_id, currency, direction, amount)
    SELECT j.id, a.id, 'USD', 'DEBIT', 1 FROM j, ledger_accounts a WHERE a.code = 'SYS:CLEARING:IDR'$s$),
    '23503', 'entry currency must equal account currency');
  PERFORM jk_test.throws($s$
    WITH j AS (INSERT INTO ledger_journals (kind, description) VALUES ('TEST','neg') RETURNING id)
    INSERT INTO ledger_entries (journal_id, account_id, currency, direction, amount)
    SELECT j.id, a.id, 'IDR', 'DEBIT', -5 FROM j, ledger_accounts a WHERE a.code = 'SYS:CLEARING:IDR'$s$,
    '23514', 'entry amounts must be positive');
  UPDATE ledger_accounts SET status = 'FROZEN' WHERE code = 'SYS:CLEARING:IDR';
  PERFORM jk_test.throws($s$SELECT post_journal('TEST','frozen','[{"bucket":"CLEARING","direction":"DEBIT","amount":1},{"bucket":"PROVIDER_CASH","direction":"CREDIT","amount":1}]'::jsonb)$s$,
                         'JKL03', 'posting to a FROZEN account rejected');
END $$;
ROLLBACK;
