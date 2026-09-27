-- 090_anonymize.sql — anonymize_user(): PII removed, financial & audit records kept.
BEGIN;
DO $$
DECLARE
  f jk_test.fx := jk_test.tx_fixture();
  t transactions%ROWTYPE;
  u users%ROWTYPE;
  v_q uuid; v_pay uuid; v_conv uuid; v_msg uuid; v_evidence_msg uuid; v_dispute uuid;
  v_entries_before int; v_journals_before int; v_audit_before int;
  v_file uuid; v_res jsonb;
BEGIN
  -- a completed, paid transaction with ledger postings, chat, delivery address, credit, KYC
  v_q := jk_test.quote(f.tx);
  t := transition_transaction(f.tx, 1, 'MATCHED', 'BUYER', f.buyer);
  t := transition_transaction(f.tx, t.version, 'AWAITING_PAYMENT', 'BUYER', f.buyer);
  INSERT INTO payments (transaction_id, purpose, provider, provider_env, amount_idr, idempotency_key, status, secured_at)
  VALUES (f.tx, 'CHECKOUT', 'MOCK', 'TEST', 1200000, 'anon-pay', 'PENDING', NULL) RETURNING id INTO v_pay;
  UPDATE payments SET status = 'SECURED', secured_at = now() WHERE id = v_pay;
  PERFORM post_journal('PAYMENT_SECURED', 'checkout', jsonb_build_array(
    jsonb_build_object('bucket','PROVIDER_CASH','direction','DEBIT','amount',1200000),
    jsonb_build_object('bucket','PRODUCT_FUND','direction','CREDIT','amount',1000000),
    jsonb_build_object('bucket','TRAVELER_EARNING','ownerUserId',f.traveler,'direction','CREDIT','amount',150000),
    jsonb_build_object('bucket','PLATFORM_REVENUE','direction','CREDIT','amount',50000)), f.tx, 'anon-journal', jsonb_build_object('paymentId', v_pay));
  t := transition_transaction(f.tx, t.version, 'PAYMENT_SECURED', 'SYSTEM', NULL);

  INSERT INTO conversations (transaction_id, request_id, buyer_id, traveler_id) VALUES (f.tx, f.request, f.buyer, f.traveler) RETURNING id INTO v_conv;
  INSERT INTO messages (conversation_id, sender_id, type, body) VALUES (v_conv, f.buyer, 'TEXT', 'Alamat saya Jl. Mawar 12, Jakarta') RETURNING id INTO v_msg;
  INSERT INTO messages (conversation_id, sender_id, type, body) VALUES (v_conv, f.buyer, 'TEXT', 'Warna yang saya pesan hitam') RETURNING id INTO v_evidence_msg;
  INSERT INTO deliveries (transaction_id, method, address_enc, enc_key_id, address_city, meetup_point, pin_hash)
  VALUES (f.tx, 'MEETUP', '\xdeadbeef', 'kms-key-1', 'Jakarta', 'Stasiun Sudirman', sha256('123456'::bytea));
  INSERT INTO credit_entries (user_id, amount_idr, reason, reference_type, expires_at) VALUES (f.buyer, 25000, 'REFERRAL_REWARD', 'referral', now() + interval '90 days');
  INSERT INTO files (owner_id, purpose, storage_provider, storage_key, mime, size_bytes, encrypted, enc_key_id)
  VALUES (f.buyer, 'KYC', 'MOCK', 'kyc/' || f.buyer || '/ktp.bin', 'application/octet-stream', 1024, true, 'kms-key-1') RETURNING id INTO v_file;
  INSERT INTO identity_records (user_id, id_type, id_number_enc, id_number_hash, full_name_enc, dob_enc, enc_key_id, verified_at)
  VALUES (f.buyer, 'KTP', '\x01', sha256(('ktp' || f.buyer)::bytea), '\x02', '\x03', 'kms-key-1', now());
  INSERT INTO payout_accounts (user_id, bank_code, account_number_enc, account_number_hash, account_mask, holder_name, enc_key_id)
  VALUES (f.buyer, 'BCA', '\x04', sha256(('acct' || f.buyer)::bytea), '****0961', 'Budi Santoso', 'kms-key-1');
  INSERT INTO auth_identities (user_id, provider, provider_subject, email) VALUES (f.buyer, 'GOOGLE', 'google-sub-' || f.buyer, 'budi@example.com');
  INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent) VALUES (f.buyer, gen_random_uuid(), sha256(f.buyer::text::bytea), now() + interval '30 days', 'JastipKita/1.0 iPhone');
  INSERT INTO notifications (user_id, event_type, title, body) VALUES (f.buyer, 'transaction.status_changed', 'Pembayaran aman', 'Halo Budi');
  INSERT INTO analytics_events (event_name, user_id, occurred_at, properties) VALUES ('app_open', f.buyer, now(), '{"screen":"home"}');

  -- preconditions: active transaction blocks anonymization
  PERFORM jk_test.throws(format('SELECT anonymize_user(%L)', f.buyer), 'JK423', 'anonymization blocked while a transaction is active');

  -- finish the transaction, open+close a dispute that cites one chat message as evidence
  t := transition_transaction(f.tx, t.version, 'PURCHASE_APPROVED', 'TRAVELER', f.traveler);
  t := transition_transaction(f.tx, t.version, 'PURCHASED', 'TRAVELER', f.traveler);
  t := transition_transaction(f.tx, t.version, 'ARRIVED', 'TRAVELER', f.traveler);
  t := transition_transaction(f.tx, t.version, 'READY_FOR_HANDOVER', 'TRAVELER', f.traveler);
  t := transition_transaction(f.tx, t.version, 'DELIVERED', 'TRAVELER', f.traveler);
  INSERT INTO disputes (transaction_id, opened_by, opened_by_role, type, description) VALUES (f.tx, f.buyer, 'BUYER', 'WRONG_ITEM', 'Warna tidak sesuai pesanan')
  RETURNING id INTO v_dispute;
  INSERT INTO dispute_evidence (dispute_id, submitted_by, party, type, message_id) VALUES (v_dispute, f.buyer, 'BUYER', 'CHAT', v_evidence_msg);
  PERFORM transition_dispute(v_dispute, 1, 'CLOSED', 'BUYER', f.buyer, 'withdrawn');
  t := transition_transaction(f.tx, t.version, 'BUYER_CONFIRMED', 'BUYER', f.buyer);
  t := transition_transaction(f.tx, t.version, 'COMPLETED', 'SYSTEM', NULL);

  SELECT count(*) INTO v_entries_before FROM ledger_entries;
  SELECT count(*) INTO v_journals_before FROM ledger_journals;
  SELECT count(*) INTO v_audit_before FROM audit_logs;

  v_res := anonymize_user(f.buyer, NULL, false);
  PERFORM jk_test.ok(v_res ? 'kycPurgeAt', 'anonymize_user returns a summary');

  SELECT * INTO u FROM users WHERE id = f.buyer;
  PERFORM jk_test.ok(u.email IS NULL AND u.phone_e164 IS NULL AND u.password_hash IS NULL AND u.display_name IS NULL
                     AND u.transaction_email IS NULL AND u.email_verified_at IS NULL, 'user contact PII & credentials removed');
  PERFORM jk_test.ok(u.status = 'DELETED' AND u.deleted_at IS NOT NULL AND u.anonymized_at IS NOT NULL, 'user tombstoned (DELETED)');
  PERFORM jk_test.eq((SELECT count(*)::int FROM auth_identities WHERE user_id = f.buyer), 0, 'auth identities deleted');
  PERFORM jk_test.eq((SELECT count(*)::int FROM refresh_tokens WHERE user_id = f.buyer), 0, 'sessions deleted');
  PERFORM jk_test.eq((SELECT count(*)::int FROM notifications WHERE user_id = f.buyer), 0, 'notifications deleted');
  PERFORM jk_test.eq((SELECT count(*)::int FROM analytics_events WHERE user_id = f.buyer), 0, 'analytics events deleted');
  PERFORM jk_test.ok((SELECT body IS NULL AND deleted_at IS NOT NULL FROM messages WHERE id = v_msg), 'chat text scrubbed');
  PERFORM jk_test.eq((SELECT body FROM messages WHERE id = v_evidence_msg), 'Warna yang saya pesan hitam', 'dispute evidence message kept (legal hold)');
  PERFORM jk_test.ok((SELECT address_enc IS NULL AND meetup_point IS NULL AND pin_hash IS NULL AND address_city = 'Jakarta'
                        FROM deliveries WHERE transaction_id = f.tx), 'delivery address & secrets removed, coarse city kept');
  PERFORM jk_test.ok((SELECT account_number_enc IS NULL AND holder_name = 'REDACTED' AND account_mask = '****0961'
                        FROM payout_accounts WHERE user_id = f.buyer), 'bank ciphertext & holder name removed, mask kept');
  PERFORM jk_test.ok((SELECT purge_after > now() + interval '4 years' FROM identity_records WHERE user_id = f.buyer),
                     'KYC identity scheduled for purge per retention policy (5y default)');
  PERFORM jk_test.ok((SELECT retention_until > now() FROM files WHERE id = v_file), 'KYC file retention set');
  PERFORM jk_test.eq((SELECT balance_idr FROM credit_balances WHERE user_id = f.buyer), 0::numeric, 'remaining credit forfeited via EXPIRY entry');

  -- financial & audit records untouched
  PERFORM jk_test.eq((SELECT count(*)::int FROM ledger_entries), v_entries_before, 'ledger entries kept');
  PERFORM jk_test.eq((SELECT count(*)::int FROM ledger_journals), v_journals_before, 'ledger journals kept');
  PERFORM jk_test.ok((SELECT status = 'COMPLETED' AND buyer_id = f.buyer FROM transactions WHERE id = f.tx), 'transaction kept (pseudonymous)');
  PERFORM jk_test.ok(EXISTS (SELECT 1 FROM payments WHERE id = v_pay AND amount_idr = 1200000), 'payment kept');
  PERFORM jk_test.ok(EXISTS (SELECT 1 FROM quote_lines WHERE quote_id = v_q AND line_type = 'ITEM_PRICE'), 'price breakdown kept');
  PERFORM jk_test.ok((SELECT count(*) FROM audit_logs) > v_audit_before
                     AND EXISTS (SELECT 1 FROM audit_logs WHERE action = 'privacy.user_anonymized' AND entity_id = f.buyer::text),
                     'audit kept and anonymization audited');
  PERFORM jk_test.ok(NOT EXISTS (SELECT 1 FROM audit_logs WHERE after::text ILIKE '%budi%' OR meta::text ILIKE '%budi%'),
                     'audit rows contain no PII');
  PERFORM jk_test.eq(verify_audit_chain(), NULL::bigint, 'audit chain still verifies');
  PERFORM jk_test.eq((anonymize_user(f.buyer))->>'alreadyAnonymized', 'true', 'anonymize_user is idempotent');
END $$;
ROLLBACK;
