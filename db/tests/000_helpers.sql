-- 000_helpers.sql — test helpers & fixtures in schema jk_test (test databases only).
-- Assertions print "PASS: ..." notices; failures RAISE EXCEPTION (psql exits non-zero).
DROP SCHEMA IF EXISTS jk_test CASCADE;
CREATE SCHEMA jk_test;

CREATE FUNCTION jk_test.pass(p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN RAISE NOTICE 'PASS: %', p_msg; END $$;

CREATE FUNCTION jk_test.ok(p_cond boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_cond IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', p_msg; END IF;
  RAISE NOTICE 'PASS: %', p_msg;
END $$;

CREATE FUNCTION jk_test.eq(p_actual anyelement, p_expected anyelement, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'FAIL: % (expected %, got %)', p_msg, p_expected, p_actual;
  END IF;
  RAISE NOTICE 'PASS: %', p_msg;
END $$;

-- Runs p_sql in a subtransaction and asserts it fails with p_sqlstate.
CREATE FUNCTION jk_test.throws(p_sql text, p_sqlstate text, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_state text; v_text text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_text = MESSAGE_TEXT;
    IF v_state = p_sqlstate THEN
      RAISE NOTICE 'PASS: % [% %]', p_msg, v_state, left(v_text, 90);
      RETURN;
    END IF;
    RAISE EXCEPTION 'FAIL: % (expected SQLSTATE %, got % %)', p_msg, p_sqlstate, v_state, v_text;
  END;
  RAISE EXCEPTION 'FAIL: % (expected SQLSTATE %, but statement succeeded)', p_msg, p_sqlstate;
END $$;

CREATE FUNCTION jk_test.succeeds(p_sql text, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_state text; v_text text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_text = MESSAGE_TEXT;
    RAISE EXCEPTION 'FAIL: % (unexpected % %)', p_msg, v_state, v_text;
  END;
  RAISE NOTICE 'PASS: %', p_msg;
END $$;

-- ---------------------------------------------------------------- fixtures
CREATE FUNCTION jk_test.user(p_label text, p_kyc smallint DEFAULT 3) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO users (email, email_verified_at, phone_e164, phone_verified_at, password_hash, display_name, kyc_level, country_code)
  VALUES (p_label || '-' || substr(gen_random_uuid()::text, 1, 8) || '@test.jastipkita.local', now(),
          '+628' || lpad((floor(random() * 1e10))::bigint::text, 10, '0'), now(),
          '$argon2id$v=19$m=65536,t=3,p=4$dGVzdA$dGVzdA', initcap(p_label), p_kyc, 'ID')
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION jk_test.admin(p_label text, VARIADIC p_roles text[]) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := jk_test.user(p_label); r text;
BEGIN
  FOREACH r IN ARRAY p_roles LOOP
    INSERT INTO user_roles (user_id, role_code, reason) VALUES (v_id, r, 'test fixture');
  END LOOP;
  RETURN v_id;
END $$;

CREATE TYPE jk_test.fx AS (buyer uuid, traveler uuid, trip uuid, request uuid, offer uuid, tx uuid);

-- Buyer + traveler + ACTIVE trip + OPEN request + ACCEPTED offer + transaction (REQUEST_CREATED).
CREATE FUNCTION jk_test.tx_fixture() RETURNS jk_test.fx LANGUAGE plpgsql AS $$
DECLARE f jk_test.fx;
BEGIN
  f.buyer := jk_test.user('buyer');
  f.traveler := jk_test.user('traveler', 4::smallint);
  INSERT INTO trips (traveler_id, origin_country, origin_city, destination_country, destination_city,
                     departure_date, arrival_date, capacity_kg, fee_type, fee_value)
  VALUES (f.traveler, 'JP', 'Tokyo', 'ID', 'Jakarta', current_date + 10, current_date + 10, 10, 'FIXED', 150000)
  RETURNING id INTO f.trip;
  PERFORM transition_trip(f.trip, 1, 'VERIFICATION_PENDING', 'TRAVELER', f.traveler);
  PERFORM transition_trip(f.trip, 2, 'VERIFIED', 'ADMIN', NULL);
  PERFORM transition_trip(f.trip, 3, 'ACTIVE', 'TRAVELER', f.traveler);
  INSERT INTO requests (buyer_id, source_type, product_url, product_name, merchant_country, category_code,
                        quantity, unit_price_minor, price_currency, status, published_at)
  VALUES (f.buyer, 'URL', 'https://example.jp/item/1', 'Sepatu lari edisi Tokyo', 'JP', 'FOOTWEAR',
          1, 1500000, 'JPY', 'OPEN', now())
  RETURNING id INTO f.request;
  INSERT INTO offers (request_id, trip_id, traveler_id, initiated_by, traveler_fee_idr, status, responded_at)
  VALUES (f.request, f.trip, f.traveler, 'TRAVELER', 150000, 'ACCEPTED', now())
  RETURNING id INTO f.offer;
  INSERT INTO transactions (request_id, trip_id, offer_id, buyer_id, traveler_id, item_currency, quantity, delivery_method)
  VALUES (f.request, f.trip, f.offer, f.buyer, f.traveler, 'JPY', 1, 'MEETUP')
  RETURNING id INTO f.tx;
  RETURN f;
END $$;

-- Quote with a consistent set of lines (ITEM 1,000,000 + fee 150,000 + platform 50,000 = 1,200,000).
CREATE FUNCTION jk_test.quote(p_tx uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_q uuid;
BEGIN
  INSERT INTO quotes (transaction_id, total_idr, expires_at, config_versions)
  VALUES (p_tx, 1200000, now() + interval '30 minutes', '{"pricing.platform_fee":1}')
  RETURNING id INTO v_q;
  INSERT INTO quote_lines (quote_id, line_type, label_id, label_en, amount_idr, bucket, is_estimate, sort) VALUES
    (v_q, 'ITEM_PRICE',   'Harga Barang', 'Item price',   1000000, 'PRODUCT_FUND',     false, 1),
    (v_q, 'TRAVELER_FEE', 'Traveler Fee', 'Traveler fee',  150000, 'TRAVELER_EARNING', false, 2),
    (v_q, 'PLATFORM_FEE', 'Platform Fee', 'Platform fee',   50000, 'PLATFORM_REVENUE', false, 6),
    (v_q, 'TOTAL', 'Total Landed Cost', 'Total landed cost', 1200000, NULL, false, 11);
  UPDATE transactions SET active_quote_id = v_q, total_idr = 1200000 WHERE id = p_tx;
  RETURN v_q;
END $$;

GRANT USAGE ON SCHEMA jk_test TO jk_app, jk_readonly;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA jk_test TO jk_app, jk_readonly;
