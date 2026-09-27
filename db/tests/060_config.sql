-- 060_config.sql — versioned business config: one ACTIVE per key, ACTIVE immutability,
-- maker-checker activation; versioned regulatory rules guard.
BEGIN;
DO $$
DECLARE
  v_maker uuid := jk_test.admin('cfgmaker', 'MARKETING');
  v_checker uuid := jk_test.admin('cfgchecker', 'FINANCE_SUPER_ADMIN');
  v_v1 business_configs%ROWTYPE;
  v_v2 uuid;
  v_active business_configs%ROWTYPE;
  v_rule uuid;
BEGIN
  SELECT * INTO v_v1 FROM business_configs WHERE key = 'pricing.platform_fee' AND status = 'ACTIVE';
  PERFORM jk_test.eq(v_v1.version, 1, 'seeded v1 is ACTIVE');
  PERFORM jk_test.eq((SELECT count(*)::int FROM business_configs WHERE status = 'ACTIVE'),
                     (SELECT count(DISTINCT key)::int FROM business_configs), 'every seeded key has exactly one ACTIVE version');
  PERFORM jk_test.ok((SELECT is_assumption FROM business_configs WHERE key = 'pricing.payment_fees' AND version = 1),
                     'assumption keys flagged from _meta.assumptions');

  -- one ACTIVE per key (partial unique index)
  PERFORM jk_test.throws($s$INSERT INTO business_configs (key, version, value, status, change_reason, approved_at)
      VALUES ('pricing.platform_fee', 99, '{"rateBps":1}', 'ACTIVE', 'second active', now())$s$,
    '23505', 'second ACTIVE version for the same key rejected');
  -- ACTIVE is immutable
  PERFORM jk_test.throws($s$UPDATE business_configs SET value = '{"rateBps":1}' WHERE key = 'pricing.platform_fee' AND status = 'ACTIVE'$s$,
    'JK001', 'ACTIVE config value cannot be edited');
  PERFORM jk_test.throws($s$UPDATE business_configs SET status = 'DRAFT' WHERE key = 'pricing.platform_fee' AND status = 'ACTIVE'$s$,
    'JK001', 'ACTIVE config cannot go back to DRAFT');
  PERFORM jk_test.throws($s$DELETE FROM business_configs WHERE key = 'pricing.platform_fee' AND status = 'ACTIVE'$s$,
    'JK001', 'ACTIVE config cannot be deleted');

  -- propose v2 (maker) -> self-approval blocked -> checker activates
  INSERT INTO business_configs (key, version, value, status, change_reason, created_by)
  VALUES ('pricing.platform_fee', 2, '{"rateBps":450,"minIdr":10000,"maxIdr":750000}', 'PENDING_APPROVAL', 'Promo Q4: turunkan platform fee', v_maker)
  RETURNING id INTO v_v2;
  PERFORM jk_test.succeeds(format($s$UPDATE business_configs SET value = '{"rateBps":400,"minIdr":10000,"maxIdr":750000}' WHERE id = %L$s$, v_v2),
                           'PENDING_APPROVAL version is still editable');
  PERFORM jk_test.throws(format($s$SELECT activate_business_config(%L, %L)$s$, v_v2, v_maker), '23514', 'maker cannot activate own config version');
  v_active := activate_business_config(v_v2, v_checker);
  PERFORM jk_test.ok(v_active.status = 'ACTIVE' AND v_active.approved_by = v_checker, 'checker activates v2');
  PERFORM jk_test.eq((SELECT status FROM business_configs WHERE id = v_v1.id), 'SUPERSEDED', 'v1 superseded atomically');
  PERFORM jk_test.eq((SELECT count(*)::int FROM business_configs WHERE key = 'pricing.platform_fee' AND status = 'ACTIVE'), 1, 'still one ACTIVE');
  PERFORM jk_test.throws(format($s$UPDATE business_configs SET change_reason = 'rewrite history' WHERE id = %L$s$, v_v1.id),
    'JK001', 'SUPERSEDED version is frozen');
  PERFORM jk_test.ok(EXISTS (SELECT 1 FROM audit_logs WHERE action = 'config.activate' AND entity_id = 'pricing.platform_fee'),
                     'activation audited');
  PERFORM jk_test.throws(format($s$SELECT activate_business_config(%L, %L)$s$, v_v2, v_checker), 'JK422', 'cannot re-activate an ACTIVE version');

  -- versioned customs rules: ACTIVE immutable except retirement/verification metadata
  INSERT INTO customs_rules (code, version, destination_country, formula_code, duty_rate, vat_rate, vat_dpp_factor,
                             income_tax_rate, effective_from, source_reference, last_verified_at, status)
  VALUES ('TEST_RULE', 1, 'ID', 'FLAT_RATES', 0.10, 0.12, 0.916667, 0.10, '2026-01-01', 'test', '2026-09-01', 'ACTIVE')
  RETURNING id INTO v_rule;
  PERFORM jk_test.throws(format($s$UPDATE customs_rules SET duty_rate = 0.2 WHERE id = %L$s$, v_rule), 'JK001', 'ACTIVE customs rule rates immutable');
  PERFORM jk_test.succeeds(format($s$UPDATE customs_rules SET last_verified_at = '2026-09-27', verified_by = 'compliance' WHERE id = %L$s$, v_rule),
                           'ACTIVE customs rule re-verification allowed');
  PERFORM jk_test.throws($s$INSERT INTO customs_rules (code, version, destination_country, formula_code, effective_from, source_reference, last_verified_at, status)
      VALUES ('TEST_RULE', 2, 'ID', 'FLAT_RATES', '2026-06-01', 'test', '2026-09-01', 'ACTIVE')$s$,
    '23P01', 'overlapping ACTIVE versions of one rule code rejected (exclusion constraint)');
  PERFORM jk_test.succeeds(format($s$UPDATE customs_rules SET status = 'RETIRED', effective_until = '2026-06-30' WHERE id = %L$s$, v_rule),
                           'ACTIVE rule can be retired');
  PERFORM jk_test.throws(format($s$DELETE FROM customs_rules WHERE id = %L$s$, v_rule), 'JK001', 'RETIRED rule cannot be deleted');
END $$;
ROLLBACK;
