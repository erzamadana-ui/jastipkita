-- 130_security_review.sql — security review 2026-09 (docs/security/review-2026-09.md): DB-side regression checks.
--   SEC-09  anonymize_user() also scrubs refund bank destinations and free-text offer messages
--   SEC-01  session MFA marker survives in refresh_tokens and is writable by jk_app
--   DB      every SECURITY DEFINER function pins search_path; runtime roles cannot create objects to hijack it

BEGIN;
DO $$
DECLARE
  f jk_test.fx := jk_test.tx_fixture();
  t transactions%ROWTYPE;
  v_pay uuid; v_refund uuid; v_dest uuid; v_offer uuid;
BEGIN
  PERFORM jk_test.quote(f.tx);
  t := transition_transaction(f.tx, 1, 'MATCHED', 'BUYER', f.buyer);
  t := transition_transaction(f.tx, t.version, 'AWAITING_PAYMENT', 'BUYER', f.buyer);
  INSERT INTO payments (transaction_id, purpose, provider, provider_env, amount_idr, idempotency_key, status, secured_at)
  VALUES (f.tx, 'CHECKOUT', 'MOCK', 'TEST', 1200000, 'sec-pay', 'PENDING', NULL) RETURNING id INTO v_pay;
  UPDATE payments SET status = 'SECURED', secured_at = now() WHERE id = v_pay;
  t := transition_transaction(f.tx, t.version, 'PAYMENT_SECURED', 'SYSTEM', NULL);
  INSERT INTO refunds (transaction_id, payment_id, amount_idr, reason_code, type, idempotency_key)
  VALUES (f.tx, v_pay, 1200000, 'OTHER', 'FULL', 'sec-refund') RETURNING id INTO v_refund;
  INSERT INTO refund_destinations (refund_id, buyer_id, bank_code, account_number_enc, account_number_hash, account_mask, holder_name_enc,
                                   enc_key_id, validation_status, validated_at)
  VALUES (v_refund, f.buyer, 'BCA', '\x0a0b', sha256('BCA:1234567890'::bytea), '****7890', '\x0c0d', 'kms-key-1', 'VALID', now())
  RETURNING id INTO v_dest;
  INSERT INTO offers (request_id, trip_id, traveler_id, initiated_by, traveler_fee_idr, status, message)
  VALUES (f.request, f.trip, f.traveler, 'BUYER', 100000, 'DECLINED', 'Hubungi saya di 0812-3456-7890 ya kak')
  RETURNING id INTO v_offer;

  PERFORM jk_test.throws(
    format('UPDATE refund_destinations SET account_number_enc = NULL WHERE id = %L', v_dest), '23514',
    'refund destination ciphertext cannot be half-removed (both columns go together)');
  -- close the money flow so anonymization is allowed (refund done, transaction terminal)
  UPDATE refunds SET status = 'CANCELLED' WHERE id = v_refund;
  t := transition_transaction(f.tx, t.version, 'REFUND_PENDING', 'BUYER', f.buyer, 'buyer cancelled');
  t := transition_transaction(f.tx, t.version, 'REFUNDED', 'SYSTEM', NULL, 'refund done');

  PERFORM anonymize_user(f.buyer, NULL, false);
  PERFORM jk_test.ok((SELECT account_number_enc IS NULL AND holder_name_enc IS NULL AND enc_key_id IS NULL
                             AND account_mask = '****7890' AND account_number_hash IS NOT NULL
                        FROM refund_destinations WHERE id = v_dest),
                     'SEC-09: refund destination ciphertext removed, mask + hash kept for reconciliation/fraud');
  PERFORM jk_test.ok((SELECT message IS NULL FROM offers WHERE id = v_offer), 'SEC-09: buyer-written invite message scrubbed');
  PERFORM jk_test.ok(EXISTS (SELECT 1 FROM audit_logs WHERE action = 'privacy.user_anonymized' AND entity_id = f.buyer::text
                              AND (after ->> 'refundDestinations')::int = 1), 'anonymization summary counts refund destinations');
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
     AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%');
  PERFORM jk_test.ok(v_bad IS NULL, 'every SECURITY DEFINER function pins search_path' || coalesce(' — offenders: ' || v_bad, ''));

  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef AND pg_get_userbyid(p.proowner) NOT IN ('jk_migrator');
  PERFORM jk_test.ok(v_bad IS NULL, 'SECURITY DEFINER functions are owned by jk_migrator (not a superuser)' || coalesce(' — ' || v_bad, ''));

  PERFORM jk_test.ok(has_column_privilege('jk_app', 'refresh_tokens', 'mfa_verified_at', 'UPDATE'), 'SEC-01: jk_app can record session MFA');
  PERFORM jk_test.ok(NOT has_column_privilege('jk_readonly', 'refresh_tokens', 'mfa_verified_at', 'SELECT'), 'jk_readonly cannot read sessions');
  PERFORM jk_test.ok(NOT has_schema_privilege('jk_app', 'public', 'CREATE'), 'jk_app cannot plant objects in public (search_path hijack)');
END $$;
ROLLBACK;

-- jk_app cannot forge or rewrite the audit trail through the SECURITY DEFINER trigger
BEGIN;
SET LOCAL ROLE jk_app;
DO $$
DECLARE v_id bigint; v_head bigint;
BEGIN
  INSERT INTO audit_logs (actor_type, action, entity_type, entity_id, prev_hash, hash, occurred_at, id)
  VALUES ('SYSTEM', 'sec.forged_backdated', 'test', 'x', decode(repeat('ff', 32), 'hex'), decode(repeat('ee', 32), 'hex'), now() - interval '1 year', 1)
  RETURNING id INTO v_id;
  SELECT last_id INTO v_head FROM audit_chain_head;
  PERFORM jk_test.eq(v_id, v_head, 'audit id is assigned by the chain trigger, not the caller');
  PERFORM jk_test.ok((SELECT occurred_at > now() - interval '1 minute' AND prev_hash <> decode(repeat('ff', 32), 'hex') FROM audit_logs WHERE id = v_id),
                     'caller-supplied timestamp and hashes are overwritten');
  PERFORM jk_test.eq(verify_audit_chain(), NULL::bigint, 'chain still verifies after a hostile insert');
  PERFORM jk_test.throws(format('UPDATE audit_logs SET action = %L WHERE id = %s', 'x.y', v_id), '42501', 'jk_app cannot edit audit rows');
END $$;
ROLLBACK;
