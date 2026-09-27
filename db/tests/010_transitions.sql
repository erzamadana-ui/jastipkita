-- 010_transitions.sql — transaction / trip / dispute state machines via transition_*().
BEGIN;
DO $$
DECLARE
  f jk_test.fx := jk_test.tx_fixture();
  t transactions%ROWTYPE;
  v_events int; v_outbox int; v_audit int;
  v_dispute uuid;
  d disputes%ROWTYPE;
BEGIN
  SELECT * INTO t FROM transactions WHERE id = f.tx;
  PERFORM jk_test.eq(t.status, 'REQUEST_CREATED', 'transaction starts at REQUEST_CREATED');
  PERFORM jk_test.ok(t.number ~ '^JK-[0-9]{6}-[0-9A-HJKMNP-TV-Z]{6}$', 'transaction number format JK-YYMMDD-XXXXXX (' || t.number || ')');
  PERFORM jk_test.eq((SELECT count(*)::int FROM transaction_events WHERE transaction_id = f.tx), 1, 'creation event written');

  SELECT count(*) INTO v_outbox FROM outbox_events;
  SELECT count(*) INTO v_audit FROM audit_logs;

  -- legal transition
  t := transition_transaction(f.tx, 1, 'MATCHED', 'BUYER', f.buyer, 'offer accepted', '{"offerId":"x"}');
  PERFORM jk_test.eq(t.status, 'MATCHED', 'legal transition REQUEST_CREATED -> MATCHED by BUYER');
  PERFORM jk_test.eq(t.version, 2, 'version bumped to 2');
  PERFORM jk_test.eq((SELECT count(*)::int FROM transaction_events WHERE transaction_id = f.tx AND to_status = 'MATCHED' AND version = 2), 1,
                     'transaction_events row written atomically');
  PERFORM jk_test.eq((SELECT count(*)::int FROM outbox_events) - v_outbox, 1, 'outbox_events row written');
  PERFORM jk_test.eq((SELECT count(*)::int FROM audit_logs) - v_audit, 1, 'audit_logs row written');
  PERFORM jk_test.eq((SELECT payload->>'to' FROM outbox_events ORDER BY id DESC LIMIT 1), 'MATCHED', 'outbox payload carries new status');

  -- version conflict (stale client still holds version 1)
  PERFORM jk_test.throws(format($s$SELECT transition_transaction(%L, 1, 'AWAITING_PAYMENT', 'BUYER', %L)$s$, f.tx, f.buyer),
                         'JK409', 'stale version -> JK409 version conflict');
  -- illegal pair
  PERFORM jk_test.throws(format($s$SELECT transition_transaction(%L, 2, 'COMPLETED', 'SYSTEM', NULL)$s$, f.tx),
                         'JK422', 'MATCHED -> COMPLETED is illegal -> JK422');
  -- legal pair, wrong actor
  PERFORM jk_test.throws(format($s$SELECT transition_transaction(%L, 2, 'AWAITING_PAYMENT', 'TRAVELER', %L)$s$, f.tx, f.traveler),
                         'JK403', 'MATCHED -> AWAITING_PAYMENT by TRAVELER -> JK403');
  -- unknown transaction
  PERFORM jk_test.throws(format($s$SELECT transition_transaction(%L, 1, 'MATCHED', 'BUYER', NULL)$s$, gen_random_uuid()),
                         'JK404', 'unknown transaction -> JK404');
  PERFORM jk_test.eq((SELECT version FROM transactions WHERE id = f.tx), 2, 'failed transitions left version untouched');

  -- direct status UPDATE bypassing the function is blocked
  PERFORM jk_test.throws(format($s$UPDATE transactions SET status = 'COMPLETED', completed_at = now() WHERE id = %L$s$, f.tx),
                         'JK422', 'direct UPDATE of transactions.status is rejected');
  PERFORM jk_test.throws(format($s$INSERT INTO transactions (request_id, buyer_id, status) VALUES (%L, %L, 'PAYMENT_SECURED')$s$, f.request, f.buyer),
                         'JK422', 'transactions cannot be inserted in a non-initial status');
  -- non-status fields remain updatable (optimistic concurrency is the caller's job)
  PERFORM jk_test.succeeds(format($s$UPDATE transactions SET purchase_deadline = now() + interval '3 days' WHERE id = %L$s$, f.tx),
                           'non-status columns stay updatable');

  -- walk the happy path to COMPLETED (terminal)
  PERFORM jk_test.quote(f.tx);
  t := transition_transaction(f.tx, 2, 'AWAITING_PAYMENT', 'BUYER', f.buyer);
  t := transition_transaction(f.tx, t.version, 'PAYMENT_SECURED', 'SYSTEM', NULL, 'xendit webhook');
  t := transition_transaction(f.tx, t.version, 'PURCHASE_APPROVED', 'TRAVELER', f.traveler);
  t := transition_transaction(f.tx, t.version, 'PURCHASED', 'TRAVELER', f.traveler);
  t := transition_transaction(f.tx, t.version, 'ARRIVED', 'TRAVELER', f.traveler);
  t := transition_transaction(f.tx, t.version, 'READY_FOR_HANDOVER', 'TRAVELER', f.traveler);
  t := transition_transaction(f.tx, t.version, 'DELIVERED', 'TRAVELER', f.traveler);
  PERFORM jk_test.ok(t.delivered_at IS NOT NULL, 'delivered_at stamped on DELIVERED');
  t := transition_transaction(f.tx, t.version, 'BUYER_CONFIRMED', 'SYSTEM', NULL, 'auto-confirm');
  t := transition_transaction(f.tx, t.version, 'COMPLETED', 'SYSTEM', NULL);
  PERFORM jk_test.eq(t.status, 'COMPLETED', 'happy path reaches COMPLETED');
  PERFORM jk_test.eq(t.version, 11, 'version incremented once per transition (1 + 10 transitions)');
  PERFORM jk_test.eq((SELECT count(*)::int FROM transaction_events WHERE transaction_id = f.tx), 11, 'one event per transition (+creation)');
  PERFORM jk_test.throws(format($s$SELECT transition_transaction(%L, 11, 'CANCELLED', 'ADMIN', NULL)$s$, f.tx),
                         'JK422', 'terminal COMPLETED has no outgoing transitions');

  -- trip FSM
  PERFORM jk_test.throws(format($s$SELECT transition_trip(%L, 4, 'DRAFT', 'TRAVELER', NULL)$s$, f.trip),
                         'JK422', 'trip ACTIVE -> DRAFT is illegal');
  PERFORM jk_test.throws(format($s$SELECT transition_trip(%L, 1, 'FULL', 'SYSTEM', NULL)$s$, f.trip),
                         'JK409', 'trip stale version -> JK409');
  PERFORM jk_test.eq((transition_trip(f.trip, 4, 'FULL', 'SYSTEM', NULL)).status, 'FULL', 'trip ACTIVE -> FULL by SYSTEM');
  PERFORM jk_test.eq((SELECT count(*)::int FROM trip_events WHERE trip_id = f.trip), 5, 'trip_events recorded (creation + 4)');

  -- dispute FSM (on a second transaction)
  f := jk_test.tx_fixture();
  INSERT INTO disputes (transaction_id, opened_by, opened_by_role, type, description, requested_resolution)
  VALUES (f.tx, f.buyer, 'BUYER', 'WRONG_ITEM', 'Barang yang diterima berbeda warna', 'REFUND_FULL')
  RETURNING id INTO v_dispute;
  PERFORM jk_test.ok((SELECT number FROM disputes WHERE id = v_dispute) ~ '^DSP-[0-9]{6}-', 'dispute number DSP-…');
  PERFORM jk_test.throws(format($s$SELECT transition_dispute(%L, 1, 'RESOLVED', 'ADMIN', NULL)$s$, v_dispute),
                         'JK422', 'dispute OPEN -> RESOLVED is illegal');
  PERFORM jk_test.throws(format($s$SELECT transition_dispute(%L, 1, 'EVIDENCE_COLLECTION', 'BUYER', %L)$s$, v_dispute, f.buyer),
                         'JK403', 'buyer cannot move dispute to EVIDENCE_COLLECTION');
  d := transition_dispute(v_dispute, 1, 'EVIDENCE_COLLECTION', 'ADMIN', NULL);
  d := transition_dispute(v_dispute, d.version, 'UNDER_REVIEW', 'SYSTEM', NULL);
  UPDATE disputes SET resolution = 'REFUND_FULL', resolution_amount_idr = 1200000 WHERE id = v_dispute;
  d := transition_dispute(v_dispute, d.version, 'RESOLVED', 'ADMIN', NULL);
  PERFORM jk_test.ok(d.resolved_at IS NOT NULL, 'dispute RESOLVED stamps resolved_at');
  d := transition_dispute(v_dispute, d.version, 'APPEALED', 'TRAVELER', f.traveler);
  PERFORM jk_test.eq(d.status, 'APPEALED', 'dispute appeal by party');
  PERFORM jk_test.eq((SELECT count(*)::int FROM dispute_events WHERE dispute_id = v_dispute), 5, 'dispute_events recorded');
END $$;
ROLLBACK;
