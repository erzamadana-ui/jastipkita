-- 120_spec_alignment.sql — domain model rev. 2: §4 new edges, §15 secondary FSMs, §16 inclusive rule dates,
-- updated config/currency seeds.

-- §16: effective_until is INCLUSIVE
BEGIN;
DO $$
DECLARE v1 uuid;
BEGIN
  INSERT INTO customs_rules (code, version, destination_country, formula_code, duty_rate, effective_from, effective_until,
                             source_reference, last_verified_at, status)
  VALUES ('TEST_INCL', 1, 'ID', 'FLAT_RATES', 0.10, '2026-01-01', '2026-06-30', 'test', '2026-09-01', 'ACTIVE') RETURNING id INTO v1;
  PERFORM jk_test.throws($s$INSERT INTO customs_rules (code, version, destination_country, formula_code, effective_from, source_reference, last_verified_at, status)
      VALUES ('TEST_INCL', 2, 'ID', 'FLAT_RATES', '2026-06-30', 'test', '2026-09-01', 'ACTIVE')$s$,
    '23P01', 'customs: v2 starting on v1''s inclusive last day (2026-06-30) overlaps -> rejected');
  PERFORM jk_test.succeeds($s$INSERT INTO customs_rules (code, version, destination_country, formula_code, effective_from, source_reference, last_verified_at, status)
      VALUES ('TEST_INCL', 2, 'ID', 'FLAT_RATES', '2026-07-01', 'test', '2026-09-01', 'ACTIVE')$s$,
    'customs: v2 starting the day after v1''s last day is accepted');
  PERFORM jk_test.throws($s$INSERT INTO customs_rules (code, version, destination_country, formula_code, effective_from, source_reference, last_verified_at, status)
      VALUES ('TEST_INCL', 3, 'ID', 'FLAT_RATES', '2030-01-01', 'test', '2026-09-01', 'ACTIVE')$s$,
    '23P01', 'customs: open-ended v2 (NULL until) overlaps any later ACTIVE version');
  PERFORM jk_test.succeeds($s$INSERT INTO customs_rules (code, version, destination_country, formula_code, effective_from, source_reference, last_verified_at, status)
      VALUES ('TEST_INCL', 3, 'ID', 'FLAT_RATES', '2026-06-30', 'test', '2026-09-01', 'DRAFT')$s$,
    'customs: overlapping DRAFT versions are allowed (only ACTIVE is exclusive)');
  PERFORM jk_test.eq((SELECT version FROM customs_rules_in_force('2026-06-30') WHERE code = 'TEST_INCL'), 1,
                     'customs_rules_in_force(): v1 still in force on its inclusive last day');
  PERFORM jk_test.eq((SELECT version FROM customs_rules_in_force('2026-07-01') WHERE code = 'TEST_INCL'), 2,
                     'customs_rules_in_force(): v2 in force from the next day');
  PERFORM jk_test.eq((SELECT version FROM customs_rules_in_force('2099-12-31') WHERE code = 'TEST_INCL'), 2,
                     'customs_rules_in_force(): NULL effective_until is open-ended');
  PERFORM jk_test.eq((SELECT count(*)::int FROM customs_rules_in_force('2025-12-31') WHERE code = 'TEST_INCL'), 0,
                     'customs_rules_in_force(): nothing before effective_from');

  INSERT INTO restricted_items (code, version, destination_country, classification, message_id, message_en, source_reference,
                                effective_from, effective_until, last_verified_at, status, airline_dg)
  VALUES ('TEST_RI', 1, 'ID', 'RESTRICTED', 'Pesan', 'Message', 'test', '2026-01-01', '2026-03-31', '2026-09-01', 'ACTIVE', true);
  PERFORM jk_test.throws($s$INSERT INTO restricted_items (code, version, destination_country, classification, message_id, message_en,
      source_reference, effective_from, last_verified_at, status) VALUES ('TEST_RI', 2, 'ID', 'PROHIBITED', 'p', 'm', 'test', '2026-03-31', '2026-09-01', 'ACTIVE')$s$,
    '23P01', 'restricted: overlap on the inclusive last day rejected');
  PERFORM jk_test.succeeds($s$INSERT INTO restricted_items (code, version, destination_country, classification, message_id, message_en,
      source_reference, effective_from, last_verified_at, status) VALUES ('TEST_RI', 2, 'ID', 'PROHIBITED', 'p', 'm', 'test', '2026-04-01', '2026-09-01', 'ACTIVE')$s$,
    'restricted: adjacent version accepted');
  PERFORM jk_test.eq((SELECT classification FROM restricted_items_in_force('2026-03-31') WHERE code = 'TEST_RI'), 'RESTRICTED',
                     'restricted_items_in_force(): inclusive last day');
  PERFORM jk_test.ok((SELECT count(*) FROM v_customs_rules_in_force) = (SELECT count(*) FROM customs_rules_in_force()),
                     'v_customs_rules_in_force matches customs_rules_in_force(today WIB)');
END $$;
ROLLBACK;

-- §4 new edges
BEGIN;
DO $$
DECLARE f jk_test.fx; t transactions%ROWTYPE;
BEGIN
  PERFORM jk_test.eq((SELECT actor_types FROM transaction_transitions WHERE from_status = 'PRICE_CHANGE_PENDING' AND to_status = 'REFUND_PENDING'),
                     ARRAY['BUYER','TRAVELER','SYSTEM'], 'seed: PRICE_CHANGE_PENDING -> REFUND_PENDING actors BUYER, TRAVELER, SYSTEM');
  PERFORM jk_test.eq((SELECT count(*)::int FROM transaction_transitions WHERE to_status = 'REFUND_PENDING' AND actor_types = ARRAY['ADMIN']
                        AND from_status IN ('TRAVELING','ARRIVED','CUSTOMS_PROCESS','READY_FOR_HANDOVER','OUT_FOR_DELIVERY')), 5,
                     'seed: ADMIN override edges {TRAVELING..OUT_FOR_DELIVERY} -> REFUND_PENDING');

  -- traveler cancels during a pending price change
  f := jk_test.tx_fixture();
  PERFORM jk_test.quote(f.tx);
  t := transition_transaction(f.tx, 1, 'MATCHED', 'BUYER', f.buyer);
  t := transition_transaction(f.tx, t.version, 'AWAITING_PAYMENT', 'BUYER', f.buyer);
  t := transition_transaction(f.tx, t.version, 'PAYMENT_SECURED', 'SYSTEM', NULL);
  t := transition_transaction(f.tx, t.version, 'PRICE_CHANGE_PENDING', 'TRAVELER', f.traveler);
  t := transition_transaction(f.tx, t.version, 'REFUND_PENDING', 'TRAVELER', f.traveler, 'traveler cancels', '{"cancellationStage":"AFTER_PAYMENT"}');
  PERFORM jk_test.ok(t.status = 'REFUND_PENDING' AND t.cancellation_stage = 'AFTER_PAYMENT',
                     'PRICE_CHANGE_PENDING -> REFUND_PENDING by TRAVELER (new edge)');

  -- admin override during travel
  f := jk_test.tx_fixture();
  PERFORM jk_test.quote(f.tx);
  t := transition_transaction(f.tx, 1, 'MATCHED', 'BUYER', f.buyer);
  t := transition_transaction(f.tx, t.version, 'AWAITING_PAYMENT', 'BUYER', f.buyer);
  t := transition_transaction(f.tx, t.version, 'PAYMENT_SECURED', 'SYSTEM', NULL);
  t := transition_transaction(f.tx, t.version, 'PURCHASE_APPROVED', 'TRAVELER', f.traveler);
  t := transition_transaction(f.tx, t.version, 'PURCHASED', 'TRAVELER', f.traveler);
  t := transition_transaction(f.tx, t.version, 'TRAVELING', 'SYSTEM', NULL);
  PERFORM jk_test.throws(format($s$SELECT transition_transaction(%L, %s, 'REFUND_PENDING', 'BUYER', %L)$s$, f.tx, t.version, f.buyer),
                         'JK403', 'TRAVELING -> REFUND_PENDING by BUYER rejected (ADMIN only)');
  t := transition_transaction(f.tx, t.version, 'REFUND_PENDING', 'ADMIN', NULL, 'override', '{"cancellationStage":"DURING_TRAVEL"}');
  PERFORM jk_test.eq(t.status, 'REFUND_PENDING', 'TRAVELING -> REFUND_PENDING by ADMIN (new edge)');

  f := jk_test.tx_fixture();
  PERFORM jk_test.quote(f.tx);
  t := transition_transaction(f.tx, 1, 'MATCHED', 'BUYER', f.buyer);
  t := transition_transaction(f.tx, t.version, 'AWAITING_PAYMENT', 'BUYER', f.buyer);
  t := transition_transaction(f.tx, t.version, 'PAYMENT_SECURED', 'SYSTEM', NULL);
  t := transition_transaction(f.tx, t.version, 'PURCHASE_APPROVED', 'TRAVELER', f.traveler);
  t := transition_transaction(f.tx, t.version, 'PURCHASED', 'TRAVELER', f.traveler);
  t := transition_transaction(f.tx, t.version, 'ARRIVED', 'TRAVELER', f.traveler);
  t := transition_transaction(f.tx, t.version, 'READY_FOR_HANDOVER', 'TRAVELER', f.traveler);
  t := transition_transaction(f.tx, t.version, 'DELIVERED', 'TRAVELER', f.traveler);
  PERFORM jk_test.throws(format($s$SELECT transition_transaction(%L, %s, 'REFUND_PENDING', 'ADMIN', NULL)$s$, f.tx, t.version),
                         'JK422', 'DELIVERED -> REFUND_PENDING is not an edge (use dispute)');
END $$;
ROLLBACK;

-- §15 secondary FSMs: payout initial SCHEDULED, KYC, seeded actors
BEGIN;
DO $$
DECLARE f jk_test.fx := jk_test.tx_fixture(); v_acct uuid; v_po payouts%ROWTYPE; v_kyc uuid; v_pay uuid;
BEGIN
  INSERT INTO payout_accounts (user_id, bank_code, account_number_enc, account_number_hash, account_mask, holder_name, enc_key_id)
  VALUES (f.traveler, 'BCA', '\x01', sha256('acct-120'::bytea), '****1200', 'Traveler', 'kms-1') RETURNING id INTO v_acct;
  INSERT INTO payouts (traveler_id, transaction_id, payout_account_id, amount_idr) VALUES (f.traveler, f.tx, v_acct, 150000) RETURNING * INTO v_po;
  PERFORM jk_test.eq(v_po.status, 'SCHEDULED', 'payout default/initial status is SCHEDULED');
  PERFORM jk_test.throws(format($s$INSERT INTO payouts (traveler_id, payout_account_id, amount_idr, status) VALUES (%L, %L, 1000, 'PROCESSING')$s$, f.traveler, v_acct),
                         'JK422', 'payout cannot be created in PROCESSING');
  PERFORM jk_test.throws(format($s$INSERT INTO payouts (traveler_id, payout_account_id, amount_idr, status, paid_at) VALUES (%L, %L, 1000, 'PAID', now())$s$, f.traveler, v_acct),
                         'JK422', 'payout cannot be created as PAID');
  UPDATE payouts SET status = 'PROCESSING' WHERE id = v_po.id;
  UPDATE payouts SET status = 'FAILED', failure_reason = 'bank rejected' WHERE id = v_po.id;
  PERFORM jk_test.succeeds(format($s$UPDATE payouts SET status = 'ON_HOLD', hold_reason = 'repeated failures' WHERE id = %L$s$, v_po.id),
                           'payout FAILED -> ON_HOLD (§15.7)');

  PERFORM jk_test.throws(format($s$INSERT INTO refunds (transaction_id, payment_id, reason_code, amount_idr, type, status) SELECT %L, gen_random_uuid(), 'ADMIN', 1, 'FULL', 'APPROVED'$s$, f.tx),
                         'JK422', 'refund must start REQUESTED');
  PERFORM jk_test.throws(format($s$INSERT INTO payments (transaction_id, purpose, provider, provider_env, amount_idr, idempotency_key, status, secured_at)
      VALUES (%L, 'CHECKOUT', 'MOCK', 'TEST', 1000, 'init-secured', 'SECURED', now())$s$, f.tx), 'JK422', 'payment must start PENDING');

  -- KYC §15.4
  INSERT INTO kyc_submissions (user_id, target_level, id_type) VALUES (f.buyer, 3, 'KTP') RETURNING id INTO v_kyc;
  PERFORM jk_test.eq((SELECT status FROM kyc_submissions WHERE id = v_kyc), 'PENDING', 'KYC submission starts PENDING');
  PERFORM jk_test.throws(format($s$UPDATE kyc_submissions SET status = 'APPROVED', reviewed_at = now() WHERE id = %L$s$, v_kyc),
                         'JK422', 'KYC PENDING -> APPROVED skips review -> rejected');
  PERFORM jk_test.ok((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'kyc_submissions_status_check')
                       !~ 'SUBMITTED|DRAFT|RESUBMIT', 'kyc_submissions status CHECK = §15.4 values only');
  UPDATE kyc_submissions SET status = 'IN_REVIEW' WHERE id = v_kyc;
  PERFORM jk_test.succeeds(format($s$UPDATE kyc_submissions SET status = 'APPROVED', reviewed_at = now() WHERE id = %L$s$, v_kyc),
                           'KYC PENDING -> IN_REVIEW -> APPROVED');
  PERFORM jk_test.throws(format($s$INSERT INTO kyc_submissions (user_id, target_level) VALUES (%L, 3)$s$, f.traveler) || '; ' ||
                         format($s$INSERT INTO kyc_submissions (user_id, target_level) VALUES (%L, 3)$s$, f.traveler),
                         '23505', 'one open (PENDING/IN_REVIEW) KYC submission per user & level');

  -- seeded §15 actors
  PERFORM jk_test.eq((SELECT actor_types FROM status_transitions WHERE machine = 'PRICE_CONFIRMATION'
                        AND from_status = 'CLARIFICATION_REQUESTED' AND to_status = 'PENDING'), ARRAY['TRAVELER'],
                     'status_transitions carries §15.2 actors');
  PERFORM jk_test.eq((SELECT count(*)::int FROM status_transitions WHERE machine = 'PAYOUT'), 10, 'payout FSM: 10 edges from §15.7');
  PERFORM jk_test.eq((SELECT count(*)::int FROM trip_transitions WHERE from_status = 'VERIFICATION_PENDING' AND to_status = 'ACTIVE'), 1,
                     'trip VERIFICATION_PENDING -> ACTIVE (§15.1) seeded');
  PERFORM jk_test.ok(NOT EXISTS (SELECT 1 FROM status_transitions WHERE actor_types IS NULL), 'every secondary transition has actors');
END $$;
ROLLBACK;

-- updated reference/config seeds
DO $$
BEGIN
  PERFORM jk_test.eq((SELECT symbol FROM currencies WHERE code = 'CNY'), 'CN¥', 'currencies: CNY symbol updated');
  PERFORM jk_test.ok(NOT (SELECT ecb_reference FROM currencies WHERE code = 'TWD') AND (SELECT ecb_reference FROM currencies WHERE code = 'JPY'),
                     'currencies.ecb_reference seeded from JSON');
  PERFORM jk_test.eq((SELECT (value->>'maxRateAgeMinutes')::int FROM business_configs WHERE key = 'fx.lock' AND status = 'ACTIVE'), 4320,
                     'business_configs fx.lock.maxRateAgeMinutes = 4320');
  PERFORM jk_test.ok(EXISTS (SELECT 1 FROM business_configs, jsonb_array_elements(value) r
                              WHERE key = 'cancellation.matrix' AND status = 'ACTIVE' AND r->>'cause' = 'PRICE_CHANGE_REJECTED'),
                     'cancellation.matrix includes the PRICE_CHANGE_REJECTED cause row');
END $$;
