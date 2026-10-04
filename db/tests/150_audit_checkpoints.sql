-- 150_audit_checkpoints.sql — T12 audit chain anchors (migration 0140): append-only, one per UTC day, key layout,
-- grants (jk_app SELECT/INSERT only), and that a checkpoint detects a full-chain rewrite verify_audit_chain() misses.
BEGIN;
DO $$
DECLARE
  v_head audit_chain_head%ROWTYPE;
  v_n bigint;
  v_prev bytea;
  r audit_logs;
BEGIN
  PERFORM jk_audit('SYSTEM', NULL, 'test.checkpoint_one', 'x', '1', NULL, NULL);
  PERFORM jk_audit('SYSTEM', NULL, 'test.checkpoint_two', 'x', '2', NULL, NULL);
  PERFORM jk_audit('SYSTEM', NULL, 'test.checkpoint_three', 'x', '3', NULL, NULL);
  SELECT h.* INTO v_head FROM audit_chain_head h;
  SELECT count(*) INTO v_n FROM audit_logs WHERE id <= v_head.last_id;

  INSERT INTO audit_checkpoints (checkpoint_day, last_id, last_hash, row_count, head_updated_at, storage_key, object_sha256, storage_mode)
  VALUES ('2026-10-04', v_head.last_id, v_head.last_hash, v_n, v_head.updated_at, 'audit-checkpoints/2026/10/04.json',
          sha256('{}'::bytea), 'MOCK');
  PERFORM jk_test.eq((SELECT created_by FROM audit_checkpoints WHERE checkpoint_day = '2026-10-04'), 'job:infra.audit_checkpoint',
                     'created_by defaults to the job name');

  PERFORM jk_test.throws($s$UPDATE audit_checkpoints SET row_count = 0$s$, 'JK001', 'audit_checkpoints: UPDATE rejected (append-only)');
  PERFORM jk_test.throws($s$DELETE FROM audit_checkpoints$s$, 'JK001', 'audit_checkpoints: DELETE rejected (append-only)');
  PERFORM jk_test.throws($s$TRUNCATE audit_checkpoints$s$, 'JK001', 'audit_checkpoints: TRUNCATE rejected (append-only)');
  PERFORM jk_test.throws(format($s$INSERT INTO audit_checkpoints (checkpoint_day, last_id, last_hash, row_count, head_updated_at, storage_key, object_sha256, storage_mode)
                                  VALUES ('2026-10-04', %s, %L, %s, now(), 'audit-checkpoints/2026/10/04.json', sha256('x'::bytea), 'MOCK')$s$,
                                v_head.last_id, v_head.last_hash, v_n),
                         '23505', 'one checkpoint per day (UNIQUE checkpoint_day)');
  PERFORM jk_test.throws($s$INSERT INTO audit_checkpoints (checkpoint_day, last_id, last_hash, row_count, head_updated_at, storage_key, object_sha256, storage_mode)
                            VALUES ('2026-10-05', 1, sha256('a'::bytea), 1, now(), 'audit-checkpoints/2026/10/04.json', sha256('x'::bytea), 'MOCK')$s$,
                         '23514', 'storage_key must be audit-checkpoints/<checkpoint_day as YYYY/MM/DD>.json');
  PERFORM jk_test.throws($s$INSERT INTO audit_checkpoints (checkpoint_day, last_id, last_hash, row_count, head_updated_at, storage_key, object_sha256, storage_mode)
                            VALUES ('2026-10-06', 1, sha256('a'::bytea), 2, now(), 'audit-checkpoints/2026/10/06.json', sha256('x'::bytea), 'MOCK')$s$,
                         '23514', 'row_count cannot exceed last_id (ids are gapless)');
  PERFORM jk_test.throws($s$INSERT INTO audit_checkpoints (checkpoint_day, last_id, last_hash, row_count, head_updated_at, storage_key, object_sha256, storage_mode)
                            VALUES ('2026-10-07', 1, '\x00'::bytea, 1, now(), 'audit-checkpoints/2026/10/07.json', sha256('x'::bytea), 'MOCK')$s$,
                         '23514', 'last_hash must be 32 bytes');
  PERFORM jk_test.throws($s$INSERT INTO audit_checkpoints (checkpoint_day, last_id, last_hash, row_count, head_updated_at, storage_key, object_sha256, storage_mode)
                            VALUES ('2026-10-08', 1, sha256('a'::bytea), 1, now(), 'audit-checkpoints/2026/10/08.json', sha256('x'::bytea), 'S3')$s$,
                         '23514', 'storage_mode is MOCK / SANDBOX / LIVE');

  -- grants: the worker (jk_app) can read and append, never change or remove anchors; jk_readonly sees no hashes
  PERFORM jk_test.ok(has_table_privilege('jk_app', 'audit_checkpoints', 'SELECT') AND has_table_privilege('jk_app', 'audit_checkpoints', 'INSERT'),
                     'jk_app: SELECT, INSERT on audit_checkpoints');
  PERFORM jk_test.ok(NOT has_table_privilege('jk_app', 'audit_checkpoints', 'UPDATE') AND NOT has_table_privilege('jk_app', 'audit_checkpoints', 'DELETE')
                     AND NOT has_table_privilege('jk_app', 'audit_checkpoints', 'TRUNCATE'), 'jk_app: no UPDATE/DELETE/TRUNCATE on audit_checkpoints');
  PERFORM jk_test.ok(has_column_privilege('jk_readonly', 'audit_checkpoints', 'checkpoint_day', 'SELECT')
                     AND NOT has_column_privilege('jk_readonly', 'audit_checkpoints', 'last_hash', 'SELECT'),
                     'jk_readonly: metadata readable, *_hash columns hidden (registry rule)');
  PERFORM jk_test.eq((SELECT app_access FROM jk_grant_policies WHERE table_name = 'audit_checkpoints'), 'AUTO', 'grant policy registered');

  -- the anchor property: rewrite the chain from row 1 and recompute every hash + the head
  ALTER TABLE audit_logs DISABLE TRIGGER trg_append_only;
  UPDATE audit_logs SET meta = '{"forged": true}' WHERE id = (SELECT min(id) FROM audit_logs);
  v_prev := decode(repeat('00', 32), 'hex');
  FOR r IN SELECT * FROM audit_logs ORDER BY id LOOP
    r.prev_hash := v_prev;
    r.hash := audit_log_compute_hash(r);
    UPDATE audit_logs SET prev_hash = r.prev_hash, hash = r.hash WHERE id = r.id;
    v_prev := r.hash;
  END LOOP;
  UPDATE audit_chain_head SET last_hash = v_prev WHERE singleton;
  ALTER TABLE audit_logs ENABLE TRIGGER trg_append_only;
  PERFORM jk_test.eq(verify_audit_chain(), NULL::bigint, 'rehashed full rewrite fools verify_audit_chain() alone');
  PERFORM jk_test.ok(EXISTS (SELECT 1 FROM audit_checkpoints c JOIN audit_logs a ON a.id = c.last_id WHERE a.hash <> c.last_hash),
                     'checkpoint anchor (last_id, last_hash) exposes the rewrite');
END $$;
ROLLBACK;

DO $$
BEGIN
  PERFORM jk_test.ok(obj_description('audit_chain_checkpoints'::regclass, 'pg_class') LIKE 'Superseded by audit_checkpoints%',
                     'legacy audit_chain_checkpoints marked as superseded');
END $$;
