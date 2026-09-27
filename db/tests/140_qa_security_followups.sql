-- 140_qa_security_followups.sql — migration 0090 (QA follow-ups, SEC-12 / SEC-13; docs/security/review-2026-09.md).
--   SEC-12  otp_challenges SENSITIVE_ACTION is bound to user + action + target; refund destinations can wait for a
--           manual review (PENDING_REVIEW) and a rejection records the reviewer
--   SEC-13  session login method is recorded; MFA reset requests are maker-checker (requester rbac.manage + fresh MFA,
--           approver another SUPER_ADMIN with fresh MFA ≠ subject), append-only history; jk_app cannot delete it

BEGIN;
DO $$
DECLARE
  u uuid := jk_test.user('stepup');
BEGIN
  PERFORM jk_test.throws(format(
    $q$INSERT INTO otp_challenges (user_id, channel, destination_hash, purpose, code_hash, expires_at)
       VALUES (%L, 'EMAIL', sha256('x'::bytea), 'SENSITIVE_ACTION', sha256('c'::bytea), now() + interval '10 minutes')$q$, u),
    '23514', 'SENSITIVE_ACTION challenge without action/target is refused');
  PERFORM jk_test.succeeds(format(
    $q$INSERT INTO otp_challenges (user_id, channel, destination_hash, purpose, code_hash, expires_at, action, target_id)
       VALUES (%L, 'EMAIL', sha256('x'::bytea), 'SENSITIVE_ACTION', sha256('c'::bytea), now() + interval '10 minutes',
               'REFUND_DESTINATION_SET', gen_random_uuid()::text)$q$, u),
    'SENSITIVE_ACTION challenge bound to action + target is accepted');
  PERFORM jk_test.throws(
    $q$INSERT INTO otp_challenges (user_id, channel, destination_hash, purpose, code_hash, expires_at, action, target_id)
       VALUES (NULL, 'EMAIL', sha256('x'::bytea), 'SENSITIVE_ACTION', sha256('c'::bytea), now(), 'PAYOUT_ACCOUNT_ADD', 'x')$q$,
    '23514', 'SENSITIVE_ACTION challenge must belong to a user');
  PERFORM jk_test.throws(format(
    $q$INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, auth_method, session_started_at)
       VALUES (%L, gen_random_uuid(), sha256('rt'::bytea), now() + interval '1 day', 'PASSWORD', now())$q$, u),
    '23514', 'refresh_tokens.auth_method is OTP / GOOGLE / APPLE');
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE
  f jk_test.fx := jk_test.tx_fixture();
  t transactions%ROWTYPE;
  v_pay uuid; v_refund uuid; v_dest uuid;
  v_fin uuid := jk_test.admin('finreview', 'FINANCE');
BEGIN
  PERFORM jk_test.quote(f.tx);
  t := transition_transaction(f.tx, 1, 'MATCHED', 'BUYER', f.buyer);
  t := transition_transaction(f.tx, t.version, 'AWAITING_PAYMENT', 'BUYER', f.buyer);
  INSERT INTO payments (transaction_id, purpose, provider, provider_env, amount_idr, idempotency_key, status)
  VALUES (f.tx, 'CHECKOUT', 'MOCK', 'TEST', 1200000, 'qa-pay', 'PENDING') RETURNING id INTO v_pay;
  UPDATE payments SET status = 'SECURED', secured_at = now() WHERE id = v_pay;
  t := transition_transaction(f.tx, t.version, 'PAYMENT_SECURED', 'SYSTEM', NULL);
  INSERT INTO refunds (transaction_id, payment_id, amount_idr, reason_code, type, idempotency_key)
  VALUES (f.tx, v_pay, 1200000, 'OTHER', 'FULL', 'qa-refund') RETURNING id INTO v_refund;
  INSERT INTO refund_destinations (refund_id, buyer_id, bank_code, account_number_enc, account_number_hash, account_mask, holder_name_enc,
                                   enc_key_id, validation_status, name_match, step_up_challenge_id)
  VALUES (v_refund, f.buyer, 'BCA', '\x0a0b', sha256('BCA:5550001111'::bytea), '****1111', '\x0c0d', 'kms-key-1', 'PENDING_REVIEW',
          'MISMATCH', gen_random_uuid())
  RETURNING id INTO v_dest;
  PERFORM jk_test.ok(true, 'refund destination can be stored PENDING_REVIEW with name_match MISMATCH');
  PERFORM jk_test.throws(format('UPDATE refund_destinations SET validation_status = ''REJECTED'' WHERE id = %L', v_dest), '23514',
                         'REJECTED destination needs a reviewer and review time');
  PERFORM jk_test.succeeds(format('UPDATE refund_destinations SET validation_status = ''REJECTED'', reviewed_by = %L, reviewed_at = now(), review_note = ''nama beda'' WHERE id = %L', v_fin, v_dest),
                           'reviewer-recorded rejection accepted');
  PERFORM jk_test.throws(format('UPDATE refund_destinations SET name_match = ''PARTIAL'' WHERE id = %L', v_dest), '23514',
                         'name_match is MATCH / MISMATCH / NO_IDENTITY');
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE
  v_subject uuid := jk_test.admin('mfasubject', 'FINANCE');
  v_maker uuid := jk_test.admin('mfamaker', 'SUPER_ADMIN');
  v_checker uuid := jk_test.admin('mfachecker', 'SUPER_ADMIN');
  v_ops uuid := jk_test.admin('mfaops', 'OPERATIONS');
  v_req uuid;
BEGIN
  PERFORM jk_test.throws(format(
    'INSERT INTO admin_mfa_reset_requests (user_id, reason, requested_by, requester_mfa_at) VALUES (%L, %L, %L, now())',
    v_subject, 'HP hilang, perlu reset authenticator', v_ops), 'JK403', 'requester without rbac.manage refused');
  PERFORM jk_test.throws(format(
    'INSERT INTO admin_mfa_reset_requests (user_id, reason, requested_by, requester_mfa_at) VALUES (%L, %L, %L, now() - interval ''20 minutes'')',
    v_subject, 'HP hilang, perlu reset authenticator', v_maker), 'JK403', 'stale requester MFA (> 15 min) refused');
  PERFORM jk_test.throws(format(
    'INSERT INTO admin_mfa_reset_requests (user_id, reason, requested_by, requester_mfa_at) VALUES (%L, %L, %L, now())',
    v_maker, 'reset authenticator saya sendiri', v_maker), '23514', 'nobody requests a reset of their own authenticator');
  INSERT INTO admin_mfa_reset_requests (user_id, reason, requested_by, requester_mfa_at)
  VALUES (v_subject, 'HP hilang, perlu reset authenticator', v_maker, now()) RETURNING id INTO v_req;
  PERFORM jk_test.throws(format(
    'INSERT INTO admin_mfa_reset_requests (user_id, reason, requested_by, requester_mfa_at) VALUES (%L, %L, %L, now())',
    v_subject, 'permintaan kedua untuk admin yang sama', v_checker), '23505', 'one PENDING reset request per user');

  PERFORM jk_test.throws(format(
    'UPDATE admin_mfa_reset_requests SET status = ''APPLIED'', approved_by = %L, approver_mfa_at = now(), decided_at = now() WHERE id = %L',
    v_maker, v_req), '23514', 'requester cannot approve (maker-checker CHECK)');
  PERFORM jk_test.throws(format(
    'UPDATE admin_mfa_reset_requests SET status = ''APPLIED'', approved_by = %L, approver_mfa_at = now(), decided_at = now() WHERE id = %L',
    v_ops, v_req), 'JK403', 'approver must be an ACTIVE SUPER_ADMIN with rbac.manage');
  PERFORM jk_test.throws(format(
    'UPDATE admin_mfa_reset_requests SET status = ''APPLIED'', approved_by = %L, approver_mfa_at = now() - interval ''30 minutes'', decided_at = now() WHERE id = %L',
    v_checker, v_req), 'JK403', 'stale approver MFA refused');
  PERFORM jk_test.throws(format('UPDATE admin_mfa_reset_requests SET reason = ''ditulis ulang setelahnya'' WHERE id = %L', v_req), 'JK001',
                         'only the decision columns may change');
  PERFORM jk_test.succeeds(format(
    'UPDATE admin_mfa_reset_requests SET status = ''APPLIED'', approved_by = %L, approver_mfa_at = now(), decided_at = now() WHERE id = %L',
    v_checker, v_req), 'another SUPER_ADMIN with fresh MFA applies the reset');
  PERFORM jk_test.throws(format('UPDATE admin_mfa_reset_requests SET status = ''REJECTED'', rejected_by = %L WHERE id = %L', v_checker, v_req), 'JK001',
                         'a decided request is immutable');
  PERFORM jk_test.throws(format('DELETE FROM admin_mfa_reset_requests WHERE id = %L', v_req), 'JK001', 'history cannot be deleted');

  PERFORM jk_test.ok(has_table_privilege('jk_app', 'admin_mfa_reset_requests', 'INSERT')
                     AND has_table_privilege('jk_app', 'admin_mfa_reset_requests', 'UPDATE')
                     AND NOT has_table_privilege('jk_app', 'admin_mfa_reset_requests', 'DELETE'),
                     'jk_app: INSERT/UPDATE but no DELETE on admin_mfa_reset_requests');
  PERFORM jk_test.ok(has_column_privilege('jk_app', 'refresh_tokens', 'session_started_at', 'INSERT')
                     AND has_column_privilege('jk_app', 'mfa_factors', 'enroll_session_id', 'INSERT')
                     AND has_column_privilege('jk_app', 'refund_destinations', 'name_match', 'UPDATE'),
                     'jk_app can write the new SEC-12/13 columns');
END $$;
ROLLBACK;
