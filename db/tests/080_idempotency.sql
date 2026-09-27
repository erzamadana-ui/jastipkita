-- 080_idempotency.sql — Idempotency-Key storage + DB-level double-submit guards.
BEGIN;
DO $$
DECLARE
  f jk_test.fx := jk_test.tx_fixture();
  v_other uuid := jk_test.user('other');
  v_pay uuid;
BEGIN
  INSERT INTO idempotency_keys (user_id, key, method, path, request_hash)
  VALUES (f.buyer, '3f0c3b7e-7c1e-4d0e-9d5c-2b1a0e9f1a11', 'POST', '/v1/payments', sha256('body'::bytea));
  PERFORM jk_test.throws(format($s$INSERT INTO idempotency_keys (user_id, key, method, path, request_hash)
      VALUES (%L, '3f0c3b7e-7c1e-4d0e-9d5c-2b1a0e9f1a11', 'POST', '/v1/payments', sha256('other'::bytea))$s$, f.buyer),
    '23505', 'same (user, key) rejected');
  PERFORM jk_test.succeeds(format($s$INSERT INTO idempotency_keys (user_id, key, method, path, request_hash)
      VALUES (%L, '3f0c3b7e-7c1e-4d0e-9d5c-2b1a0e9f1a11', 'POST', '/v1/payments', sha256('body'::bytea))$s$, v_other),
    'same key for a different user is independent');
  PERFORM jk_test.throws(format($s$UPDATE idempotency_keys SET status = 'COMPLETED' WHERE user_id = %L$s$, f.buyer),
    '23514', 'COMPLETED requires a stored response');
  PERFORM jk_test.succeeds(format($s$UPDATE idempotency_keys SET status = 'COMPLETED', response_status = 201,
      response_body = '{"id":"p1"}', completed_at = now() WHERE user_id = %L$s$, f.buyer), 'response stored for replay');

  -- payments carry their own unique idempotency key and provider ref
  INSERT INTO payments (transaction_id, purpose, provider, provider_env, channel, amount_idr, idempotency_key, provider_ref)
  VALUES (f.tx, 'CHECKOUT', 'MOCK', 'TEST', 'VA', 1200000, 'idem-pay-1', 'inv_1') RETURNING id INTO v_pay;
  PERFORM jk_test.throws(format($s$INSERT INTO payments (transaction_id, purpose, provider, provider_env, amount_idr, idempotency_key)
      VALUES (%L, 'CHECKOUT', 'MOCK', 'TEST', 1200000, 'idem-pay-1')$s$, f.tx), '23505', 'payments.idempotency_key unique');
  PERFORM jk_test.throws(format($s$INSERT INTO payments (transaction_id, purpose, provider, provider_env, amount_idr, idempotency_key)
      VALUES (%L, 'CHECKOUT', 'MOCK', 'LIVE', 1200000, 'idem-pay-2')$s$, f.tx), '23514', 'a MOCK provider can never be LIVE');
  PERFORM jk_test.throws(format($s$UPDATE payments SET status = 'REFUNDED' WHERE id = %L$s$, v_pay), 'JK422', 'payment PENDING -> REFUNDED illegal');
  PERFORM jk_test.succeeds(format($s$UPDATE payments SET status = 'SECURED', secured_at = now() WHERE id = %L$s$, v_pay), 'payment PENDING -> SECURED');
  PERFORM jk_test.throws(format($s$UPDATE payments SET status = 'PENDING' WHERE id = %L$s$, v_pay), 'JK422', 'payment SECURED -> PENDING illegal');

  -- ledger journals: idempotency_key unique
  PERFORM post_journal('PAYMENT_SECURED', 'x', '[{"bucket":"PROVIDER_CASH","direction":"DEBIT","amount":5},{"bucket":"CLEARING","direction":"CREDIT","amount":5}]', f.tx, 'journal-key-1');
  PERFORM jk_test.throws($s$INSERT INTO ledger_journals (kind, description, idempotency_key) VALUES ('X', 'dup', 'journal-key-1')$s$,
    '23505', 'ledger_journals.idempotency_key unique');
END $$;
ROLLBACK;
