-- 050_maker_checker.sql — settlement account changes, trust overrides, refunds, db operations.
BEGIN;
DO $$
DECLARE
  v_maker uuid := jk_test.admin('finmaker', 'FINANCE');
  v_checker uuid := jk_test.admin('finchecker', 'FINANCE_SUPER_ADMIN');
  v_super uuid := jk_test.admin('superadmin', 'SUPER_ADMIN');
  v_support uuid := jk_test.admin('support', 'SUPPORT');
  v_change uuid; v_change2 uuid;
  v_acct settlement_accounts%ROWTYPE;
  v_risk uuid := jk_test.admin('risk', 'RISK');
  v_target uuid := jk_test.user('target');
  v_ov uuid;
  v_super2 uuid;
BEGIN
  -- request (maker needs finance.settlement.request_change + fresh MFA)
  PERFORM jk_test.throws(format($s$INSERT INTO settlement_account_changes (change_type, proposed, reason, requested_by, requester_mfa_at)
      VALUES ('CREATE', '{"label":"BCA Ops"}', 'new operations account', %L, now())$s$, v_support),
    'JK403', 'requester without finance.settlement.request_change rejected');
  PERFORM jk_test.throws(format($s$INSERT INTO settlement_account_changes (change_type, proposed, reason, requested_by, requester_mfa_at)
      VALUES ('CREATE', '{"label":"BCA Ops"}', 'new operations account', %L, now() - interval '1 hour')$s$, v_maker),
    'JK403', 'stale requester MFA rejected');
  PERFORM jk_test.throws(format($s$INSERT INTO settlement_account_changes (change_type, proposed, reason, requested_by, requester_mfa_at)
      VALUES ('CREATE', '{"accountNumber":"1234567890"}', 'new operations account', %L, now())$s$, v_maker),
    '23514', 'full account number in proposed payload rejected (masked only)');

  INSERT INTO settlement_account_changes (change_type, proposed, reason, requested_by, requester_mfa_at)
  VALUES ('CREATE', jsonb_build_object('label','BCA Operasional','purpose','PLATFORM_REVENUE','bankCode','BCA',
                                       'secretRef','vault://kv/settlement/bca-ops','accountMask','****0961',
                                       'holderNameMask','PT J*** K*** I***','currency','IDR','isPrimary',true),
          'Rekening penerimaan revenue utama', v_maker, now())
  RETURNING id INTO v_change;

  -- approver = requester
  PERFORM jk_test.throws(format($s$UPDATE settlement_account_changes SET status = 'APPROVED', approved_by = %L, approver_mfa_at = now() WHERE id = %L$s$, v_maker, v_change),
    '23514', 'maker cannot approve own settlement change (approver <> requester)');
  -- approver without FINANCE_SUPER_ADMIN (SUPER_ADMIN alone is not enough)
  PERFORM jk_test.throws(format($s$UPDATE settlement_account_changes SET status = 'APPROVED', approved_by = %L, approver_mfa_at = now() WHERE id = %L$s$, v_super, v_change),
    'JK403', 'SUPER_ADMIN without FINANCE_SUPER_ADMIN cannot approve');
  PERFORM jk_test.throws(format($s$UPDATE settlement_account_changes SET status = 'APPROVED', approved_by = %L, approver_mfa_at = now() - interval '2 hours' WHERE id = %L$s$, v_checker, v_change),
    'JK403', 'stale approver MFA rejected');
  -- direct write to settlement_accounts is impossible
  PERFORM jk_test.throws($s$INSERT INTO settlement_accounts (label, purpose, bank_code, secret_ref, account_mask, holder_name_mask, status)
      VALUES ('x','TAX','BCA','vault://x','****1234','X','ACTIVE')$s$, 'JK422', 'settlement_accounts cannot be written directly');
  PERFORM jk_test.throws(format($s$SELECT apply_settlement_account_change(%L, %L)$s$, v_change, v_checker),
    'JK422', 'cannot apply a PENDING change');

  UPDATE settlement_account_changes SET status = 'APPROVED', approved_by = v_checker, approver_mfa_at = now() WHERE id = v_change;
  PERFORM jk_test.pass('FINANCE_SUPER_ADMIN (different user, fresh MFA) approves');
  PERFORM jk_test.throws(format($s$UPDATE settlement_account_changes SET reason = 'changed after approval!' WHERE id = %L$s$, v_change),
    'JK001', 'request content immutable after submission');
  PERFORM jk_test.throws(format($s$UPDATE settlement_account_changes SET status = 'APPLIED', applied_at = now() WHERE id = %L$s$, v_change),
    'JK422', 'APPLIED only through apply_settlement_account_change()');

  v_acct := apply_settlement_account_change(v_change, v_checker);
  PERFORM jk_test.ok(v_acct.status = 'ACTIVE' AND v_acct.is_primary AND v_acct.account_mask = '****0961',
                     'approved CREATE applied: ACTIVE primary account with mask only');
  PERFORM jk_test.eq((SELECT status FROM settlement_account_changes WHERE id = v_change), 'APPLIED', 'change marked APPLIED');
  PERFORM jk_test.throws(format($s$UPDATE settlement_account_changes SET decision_note = 'x' WHERE id = %L$s$, v_change),
    'JK001', 'APPLIED change is frozen');
  PERFORM jk_test.throws(format($s$DELETE FROM settlement_account_changes WHERE id = %L$s$, v_change), 'JK001', 'change history cannot be deleted');
  PERFORM jk_test.ok(EXISTS (SELECT 1 FROM audit_logs WHERE action = 'finance.settlement_change_applied' AND entity_id = v_acct.id::text
                               AND NOT (after ? 'secret_ref')), 'audit row written without secret_ref');
  PERFORM jk_test.throws(format($s$UPDATE settlement_accounts SET account_mask = '****9999' WHERE id = %L$s$, v_acct.id),
    'JK422', 'existing settlement account cannot be edited directly');

  -- trust score override maker-checker
  PERFORM jk_test.throws(format($s$INSERT INTO trust_score_overrides (user_id, previous_score, new_score, reason, requested_by)
      VALUES (%L, 50, 90, 'manual bump for testing', %L)$s$, v_target, v_support),
    'JK403', 'trust override requester needs trust.override.request');
  INSERT INTO trust_score_overrides (user_id, previous_score, new_score, reason, requested_by)
  VALUES (v_target, 50, 85, 'verified offline business reference', v_super) RETURNING id INTO v_ov;
  PERFORM jk_test.throws(format($s$UPDATE trust_score_overrides SET status = 'APPROVED', approved_by = %L WHERE id = %L$s$, v_super, v_ov),
    '23514', 'trust override: requester cannot approve own request (even SUPER_ADMIN)');
  PERFORM jk_test.throws(format($s$UPDATE trust_score_overrides SET status = 'APPROVED', approved_by = %L WHERE id = %L$s$, v_checker, v_ov),
    'JK403', 'trust override: approver needs trust.override.approve');
  v_super2 := jk_test.admin('superadmin2', 'SUPER_ADMIN');
  UPDATE trust_score_overrides SET status = 'APPROVED', approved_by = v_super2 WHERE id = v_ov;
  PERFORM jk_test.pass('trust override approved by a second SUPER_ADMIN');
  PERFORM apply_trust_score_override(v_ov, v_super2);
  PERFORM jk_test.eq((SELECT trust_score FROM users WHERE id = v_target), 85::smallint, 'override applied and synced to users.trust_score');
  PERFORM jk_test.eq((SELECT source FROM trust_score_history WHERE user_id = v_target ORDER BY id DESC LIMIT 1), 'OVERRIDE', 'history row tagged OVERRIDE');

  -- config maker-checker (CHECK) and db_operations
  PERFORM jk_test.throws(format($s$INSERT INTO db_operations (type, requested_by, approved_by, status) VALUES ('RESTORE', %L, %L, 'APPROVED')$s$, v_super, v_super),
    '23514', 'db_operations: requester cannot approve own RESTORE');
  PERFORM jk_test.throws(format($s$INSERT INTO db_operations (type, requested_by, status) VALUES ('RESTORE', %L, 'RUNNING')$s$, v_super),
    '23514', 'db_operations: RESTORE cannot run without approval');
  PERFORM jk_test.throws(format($s$INSERT INTO db_operations (type, requested_by, params) VALUES ('CONNECTION_TEST', %L, '{"password":"hunter2hunter2"}')$s$, v_super),
    '23514', 'db_operations.params rejects inline secrets');
END $$;
ROLLBACK;
