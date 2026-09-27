-- 040_audit_chain.sql — hash chain linearity, verification and tamper detection.
BEGIN;
DO $$
DECLARE
  v_first bigint; v_mid bigint; v_last bigint;
  v_row audit_logs%ROWTYPE;
  i int;
BEGIN
  PERFORM jk_test.eq(verify_audit_chain(), NULL::bigint, 'chain verifies before test writes');
  FOR i IN 1..5 LOOP
    PERFORM jk_audit('ADMIN', gen_random_uuid(), 'config.propose', 'business_config', 'pricing.platform_fee',
                     jsonb_build_object('n', i - 1), jsonb_build_object('n', i), jsonb_build_object('i', i));
  END LOOP;
  -- multi-row insert in one statement must also chain linearly
  INSERT INTO audit_logs (actor_type, action, entity_type, entity_id, meta)
  VALUES ('SYSTEM', 'job.ran', 'job', 'a', '{}'), ('SYSTEM', 'job.ran', 'job', 'b', '{}'), ('SYSTEM', 'job.ran', 'job', 'c', '{}');

  SELECT min(id), max(id) INTO v_first, v_last FROM audit_logs;
  PERFORM jk_test.eq((SELECT count(*) FROM audit_logs), v_last - v_first + 1, 'audit ids are gapless');
  PERFORM jk_test.ok(NOT EXISTS (
      SELECT 1 FROM audit_logs a JOIN audit_logs b ON b.id = a.id + 1 WHERE b.prev_hash <> a.hash),
    'each row links to its predecessor hash');
  PERFORM jk_test.eq((SELECT prev_hash FROM audit_logs WHERE id = 1), decode(repeat('00', 32), 'hex'), 'genesis prev_hash = 32 zero bytes');
  PERFORM jk_test.eq(verify_audit_chain(), NULL::bigint, 'verify_audit_chain() = NULL on intact chain');
  PERFORM jk_test.eq(verify_audit_chain(v_first + 2, v_last - 1), NULL::bigint, 'ranged verification passes');
  PERFORM jk_test.eq((SELECT last_id FROM audit_chain_head), v_last, 'chain head tracks last id');

  -- caller cannot forge id/hash/time
  INSERT INTO audit_logs (id, occurred_at, actor_type, action, entity_type, prev_hash, hash)
  VALUES (999999, '2000-01-01', 'SYSTEM', 'forge.attempt', 'x', decode(repeat('ff', 32), 'hex'), decode(repeat('ff', 32), 'hex'))
  RETURNING * INTO v_row;
  PERFORM jk_test.ok(v_row.id = v_last + 1 AND v_row.occurred_at > now() - interval '1 minute'
                     AND v_row.prev_hash <> decode(repeat('ff', 32), 'hex'),
                     'trigger overrides caller-supplied id/occurred_at/prev_hash/hash');
  v_last := v_row.id;

  -- tamper as superuser: disable the guard, edit a row, re-enable
  v_mid := v_first + 3;
  ALTER TABLE audit_logs DISABLE TRIGGER trg_append_only;
  UPDATE audit_logs SET action = 'config.approve' WHERE id = v_mid;
  ALTER TABLE audit_logs ENABLE TRIGGER trg_append_only;
  PERFORM jk_test.eq(verify_audit_chain(), v_mid, 'tampered row data detected at its id');

  -- attacker also recomputes the tampered row's hash -> next link breaks
  ALTER TABLE audit_logs DISABLE TRIGGER trg_append_only;
  UPDATE audit_logs a SET hash = audit_log_compute_hash(a) WHERE id = v_mid;
  ALTER TABLE audit_logs ENABLE TRIGGER trg_append_only;
  PERFORM jk_test.eq(verify_audit_chain(), v_mid + 1, 'rehashed tamper detected at the next link');
  PERFORM jk_test.eq(verify_audit_chain(v_mid + 2, NULL), NULL::bigint, 'range after the tamper still verifies');
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE v_last bigint; v_del bigint;
BEGIN
  PERFORM jk_audit('SYSTEM', NULL, 'test.one', 'x', '1', NULL, NULL);
  PERFORM jk_audit('SYSTEM', NULL, 'test.two', 'x', '2', NULL, NULL);
  PERFORM jk_audit('SYSTEM', NULL, 'test.three', 'x', '3', NULL, NULL);
  SELECT max(id) INTO v_last FROM audit_logs;
  v_del := v_last - 1;
  ALTER TABLE audit_logs DISABLE TRIGGER trg_append_only;
  DELETE FROM audit_logs WHERE id = v_del;
  ALTER TABLE audit_logs ENABLE TRIGGER trg_append_only;
  PERFORM jk_test.eq(verify_audit_chain(), v_del, 'deleted middle row detected');
  ALTER TABLE audit_logs DISABLE TRIGGER trg_append_only;
  DELETE FROM audit_logs WHERE id >= v_del;
  ALTER TABLE audit_logs ENABLE TRIGGER trg_append_only;
  PERFORM jk_test.eq(verify_audit_chain(), v_del, 'truncated tail detected against audit_chain_head');
END $$;
ROLLBACK;
