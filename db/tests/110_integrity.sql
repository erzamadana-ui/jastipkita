-- 110_integrity.sql — schema-wide invariants: FK index coverage, price breakdown totals,
-- credit balance, refunds/payouts guards, business CHECKs.

-- every foreign key is backed by an index whose leading columns are the FK columns
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(format('%s(%s)', c.conrelid::regclass,
           (SELECT string_agg(attname, ',') FROM pg_attribute WHERE attrelid = c.conrelid AND attnum = ANY (c.conkey))), '; ')
    INTO v_missing
    FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
   WHERE c.contype = 'f' AND n.nspname = 'public'
     AND NOT EXISTS (
       SELECT 1 FROM pg_index i
        WHERE i.indrelid = c.conrelid
          AND (SELECT array_agg(k ORDER BY k) FROM unnest((i.indkey::int2[])[0:cardinality(c.conkey) - 1]) k)
            = (SELECT array_agg(k ORDER BY k) FROM unnest(c.conkey) k));
  PERFORM jk_test.ok(v_missing IS NULL, 'every foreign key has a supporting index' || coalesce(' — missing: ' || v_missing, ''));
  PERFORM jk_test.ok((SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexdef ILIKE '%gin_trgm_ops%') >= 2,
                     'trigram indexes on requests.product_name and faq search text');
END $$;

-- price breakdown must sum to TOTAL at commit (deferred)
BEGIN;
DO $$
DECLARE f jk_test.fx := jk_test.tx_fixture(); v_q uuid;
BEGIN
  v_q := jk_test.quote(f.tx);
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  PERFORM jk_test.pass('consistent quote lines accepted');
  BEGIN
    INSERT INTO quotes (transaction_id, total_idr, expires_at) VALUES (f.tx, 999, now() + interval '1 hour') RETURNING id INTO v_q;
    RAISE EXCEPTION 'FAIL: second ACTIVE quote accepted';
  EXCEPTION WHEN unique_violation THEN
    PERFORM jk_test.pass('only one ACTIVE quote per transaction');
  END;
  UPDATE quotes SET status = 'SUPERSEDED' WHERE transaction_id = f.tx;
  BEGIN
    INSERT INTO quotes (transaction_id, total_idr, expires_at) VALUES (f.tx, 1100000, now() + interval '1 hour') RETURNING id INTO v_q;
    INSERT INTO quote_lines (quote_id, line_type, label_id, label_en, amount_idr, bucket, sort) VALUES
      (v_q, 'ITEM_PRICE', 'Harga Barang', 'Item price', 1000000, 'PRODUCT_FUND', 1),
      (v_q, 'PLATFORM_FEE', 'Platform Fee', 'Platform fee', 50000, 'PLATFORM_REVENUE', 6),     -- hidden fee: TOTAL says 1,100,000
      (v_q, 'TOTAL', 'Total', 'Total', 1100000, NULL, 11);
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'FAIL: inconsistent quote accepted';
  EXCEPTION WHEN SQLSTATE 'JKQ01' THEN
    PERFORM jk_test.pass('quote whose lines do not sum to TOTAL rejected (JKQ01)');
  END;
  SET CONSTRAINTS ALL DEFERRED;
  PERFORM jk_test.throws(format($s$INSERT INTO quote_lines (quote_id, line_type, label_id, label_en, amount_idr, bucket, sort)
      SELECT id, 'DISCOUNT', 'Diskon', 'Discount', 5000, 'PROMOTION_CREDIT', 9 FROM quotes WHERE transaction_id = %L LIMIT 1$s$, f.tx),
    '23514', 'DISCOUNT lines must be <= 0');
  PERFORM jk_test.throws(format($s$INSERT INTO quote_lines (quote_id, line_type, label_id, label_en, amount_idr, bucket, sort)
      SELECT id, 'CUSTOMS_DUTY', 'Bea', 'Duty', 5000, NULL, 3 FROM quotes WHERE transaction_id = %L LIMIT 1$s$, f.tx),
    '23514', 'every non-TOTAL line names a bucket');
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE
  f jk_test.fx := jk_test.tx_fixture();
  v_fin uuid := jk_test.admin('fin', 'FINANCE');
  v_fin2 uuid := jk_test.admin('fin2', 'FINANCE');
  v_pay uuid; v_ref uuid; v_acct uuid; v_po uuid;
  t transactions%ROWTYPE;
BEGIN
  -- credit balance can never go negative
  INSERT INTO credit_entries (user_id, amount_idr, reason, reference_type) VALUES (f.buyer, 25000, 'REFERRAL_REWARD', 'referral');
  PERFORM jk_test.succeeds(format($s$INSERT INTO credit_entries (user_id, amount_idr, reason, reference_type) VALUES (%L, -20000, 'CHECKOUT_REDEEM', 'transaction')$s$, f.buyer),
                           'credit redemption within balance');
  PERFORM jk_test.throws(format($s$INSERT INTO credit_entries (user_id, amount_idr, reason, reference_type) VALUES (%L, -5001, 'CHECKOUT_REDEEM', 'transaction')$s$, f.buyer),
                         'JKC01', 'credit overdraw rejected');
  PERFORM jk_test.throws(format($s$INSERT INTO credit_entries (user_id, amount_idr, reason) VALUES (%L, -1, 'REFERRAL_REWARD')$s$, f.buyer),
                         '23514', 'reason/sign consistency enforced');
  PERFORM jk_test.eq((SELECT balance_idr FROM credit_balances WHERE user_id = f.buyer), 5000::numeric, 'credit_balances view');

  -- refunds: FSM, maker-checker, cannot exceed paid amount, events auto-recorded
  INSERT INTO payments (transaction_id, purpose, provider, provider_env, amount_idr, idempotency_key)
  VALUES (f.tx, 'CHECKOUT', 'MOCK', 'TEST', 1200000, 'int-pay') RETURNING id INTO v_pay;
  UPDATE payments SET status = 'SECURED', secured_at = now() WHERE id = v_pay;
  PERFORM set_config('jk.actor_type', 'ADMIN', true);
  PERFORM set_config('jk.actor_id', v_fin::text, true);
  INSERT INTO refunds (transaction_id, payment_id, reason_code, amount_idr, type, requested_by)
  VALUES (f.tx, v_pay, 'BUYER_CANCEL', 1000000, 'PARTIAL', v_fin) RETURNING id INTO v_ref;
  PERFORM jk_test.ok((SELECT number FROM refunds WHERE id = v_ref) ~ '^RFD-[0-9]{6}-', 'refund number RFD-…');
  PERFORM jk_test.throws(format($s$INSERT INTO refunds (transaction_id, payment_id, reason_code, amount_idr, type) VALUES (%L, %L, 'ADMIN', 300000, 'PARTIAL')$s$, f.tx, v_pay),
                         '23514', 'total refunds cannot exceed the paid amount');
  PERFORM jk_test.throws(format($s$UPDATE refunds SET status = 'SUCCEEDED' WHERE id = %L$s$, v_ref), 'JK422', 'refund REQUESTED -> SUCCEEDED illegal');
  PERFORM jk_test.throws(format($s$UPDATE refunds SET status = 'APPROVED', approved_by = %L, approved_at = now() WHERE id = %L$s$, v_fin, v_ref),
                         '23514', 'refund requester cannot approve own refund');
  UPDATE refunds SET status = 'APPROVED', approved_by = v_fin2, approved_at = now() WHERE id = v_ref;
  UPDATE refunds SET status = 'PROCESSING' WHERE id = v_ref;
  UPDATE refunds SET status = 'SUCCEEDED', processed_at = now() WHERE id = v_ref;
  PERFORM jk_test.eq((SELECT count(*)::int FROM refund_events WHERE refund_id = v_ref), 4, 'refund_events auto-recorded for every status change');
  PERFORM jk_test.eq((SELECT actor_id FROM refund_events WHERE refund_id = v_ref ORDER BY id LIMIT 1), v_fin, 'refund_events capture actor from jk.actor_id');

  -- payouts: one live payout per transaction, account must belong to traveler
  INSERT INTO payout_accounts (user_id, bank_code, account_number_enc, account_number_hash, account_mask, holder_name, enc_key_id, is_default)
  VALUES (f.traveler, 'BCA', '\x01', sha256('acct-traveler'::bytea), '****4321', 'Traveler', 'kms-1', true) RETURNING id INTO v_acct;
  INSERT INTO payouts (traveler_id, transaction_id, payout_account_id, amount_idr) VALUES (f.traveler, f.tx, v_acct, 150000) RETURNING id INTO v_po;
  PERFORM jk_test.ok((SELECT number FROM payouts WHERE id = v_po) ~ '^PO-[0-9]{6}-', 'payout number PO-…');
  PERFORM jk_test.throws(format($s$INSERT INTO payouts (traveler_id, transaction_id, payout_account_id, amount_idr) VALUES (%L, %L, %L, 150000)$s$, f.traveler, f.tx, v_acct),
                         '23505', 'second live payout for the same transaction rejected');
  PERFORM jk_test.throws(format($s$INSERT INTO payouts (traveler_id, payout_account_id, amount_idr) VALUES (%L, %L, 1000)$s$, f.buyer, v_acct),
                         '23503', 'payout account must belong to the payee');
  PERFORM jk_test.throws(format($s$UPDATE payouts SET status = 'PAID' WHERE id = %L$s$, v_po), 'JK422', 'payout SCHEDULED -> PAID must go through PROCESSING');
  PERFORM jk_test.throws(format($s$UPDATE payouts SET status = 'ON_HOLD' WHERE id = %L$s$, v_po), '23514', 'ON_HOLD requires hold_reason');

  -- marketplace invariants
  PERFORM jk_test.throws(format($s$INSERT INTO offers (request_id, trip_id, traveler_id, initiated_by, traveler_fee_idr, status)
      VALUES (%L, %L, %L, 'TRAVELER', 1, 'ACCEPTED')$s$, f.request, f.trip, f.traveler), '23505', 'only one ACCEPTED offer per request');
  PERFORM jk_test.throws(format($s$INSERT INTO offers (request_id, trip_id, traveler_id, initiated_by, traveler_fee_idr)
      VALUES (%L, %L, %L, 'TRAVELER', 1)$s$, f.request, f.trip, f.buyer), '23503', 'offer traveler must own the trip');
  PERFORM jk_test.throws(format($s$UPDATE trips SET reserved_kg = 11 WHERE id = %L$s$, f.trip), '23514', 'trip reserved_kg cannot exceed capacity');
  PERFORM jk_test.throws(format($s$UPDATE requests SET restriction_class = 'PROHIBITED' WHERE id = %L$s$, f.request), '23514',
                         'PROHIBITED item cannot be an OPEN request');
  PERFORM jk_test.throws($s$INSERT INTO files (purpose, storage_provider, storage_key, mime, size_bytes) VALUES ('KYC','MOCK','k/1','image/jpeg',1)$s$,
                         '23514', 'KYC files must be encrypted');
  PERFORM jk_test.throws($s$INSERT INTO users (phone_e164) VALUES ('0812345678')$s$, '23514', 'phone must be E.164');
  PERFORM jk_test.throws($s$INSERT INTO trips (traveler_id, origin_country, origin_city, destination_country, destination_city, departure_date, arrival_date, capacity_kg, fee_type, fee_value)
      SELECT id, 'JP','Tokyo','ID','Jakarta', current_date, current_date - 1, 5, 'FIXED', 1 FROM users LIMIT 1$s$, '23514', 'trip arrival >= departure');
  PERFORM jk_test.throws($s$INSERT INTO ledger_accounts (code, name, bucket, currency, normal_side, is_system) VALUES ('SYS:PRODUCT_FUND:IDR2','dup','PRODUCT_FUND','IDR','CREDIT',true)$s$,
                         '23505', 'one system ledger account per bucket & currency (NULLS NOT DISTINCT)');

  -- ratings summary maintained by trigger
  INSERT INTO ratings (transaction_id, rater_id, ratee_id, direction, overall) VALUES (f.tx, f.buyer, f.traveler, 'BUYER_TO_TRAVELER', 5);
  PERFORM jk_test.eq((SELECT as_traveler_avg FROM user_rating_summaries WHERE user_id = f.traveler), 5.00::numeric, 'rating summary refreshed');
  PERFORM jk_test.throws(format($s$INSERT INTO ratings (transaction_id, rater_id, ratee_id, direction, overall) VALUES (%L, %L, %L, 'BUYER_TO_TRAVELER', 4)$s$,
                         f.tx, f.buyer, f.traveler), '23505', 'one rating per rater per transaction');

  -- limits usage view counts from AWAITING_PAYMENT onward
  PERFORM jk_test.quote(f.tx);
  t := transition_transaction(f.tx, 1, 'MATCHED', 'BUYER', f.buyer);
  t := transition_transaction(f.tx, 2, 'AWAITING_PAYMENT', 'BUYER', f.buyer);
  PERFORM jk_test.eq((SELECT amount_idr FROM v_transaction_limits_usage WHERE user_id = f.buyer AND role = 'BUYER'), 1200000::numeric,
                     'v_transaction_limits_usage counts committed checkout value');
END $$;
ROLLBACK;
