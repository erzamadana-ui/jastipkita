-- 070_jobs_outbox.sql — job queue claim semantics (sequential simulation; true concurrency with
-- two sessions is exercised in test-db.sh), retries, lease reaping, outbox claim.
BEGIN;
DO $$
DECLARE
  v_ids uuid[];
  v_a uuid[]; v_b uuid[]; v_c uuid[];
  v_job jobs%ROWTYPE;
BEGIN
  INSERT INTO jobs (queue, name, priority, payload) SELECT 'test', 'job-' || i, CASE WHEN i = 5 THEN 1 ELSE 100 END, jsonb_build_object('i', i)
    FROM generate_series(1, 5) i;
  INSERT INTO jobs (queue, name, run_at) VALUES ('test', 'future', now() + interval '1 hour');
  INSERT INTO jobs (queue, name) VALUES ('other', 'other-queue');

  SELECT array_agg(id) INTO v_a FROM claim_jobs('test', 'worker-A', 2);
  SELECT array_agg(id) INTO v_b FROM claim_jobs('test', 'worker-B', 10);
  SELECT array_agg(id) INTO v_c FROM claim_jobs('test', 'worker-C', 10);
  PERFORM jk_test.eq(cardinality(v_a), 2, 'worker A claims its limit (2)');
  PERFORM jk_test.eq(cardinality(v_b), 3, 'worker B gets only the remaining runnable jobs');
  PERFORM jk_test.ok(v_c IS NULL, 'nothing left for worker C (future + other queue excluded)');
  PERFORM jk_test.ok(NOT (v_a && v_b), 'no job claimed twice');
  PERFORM jk_test.ok(EXISTS (SELECT 1 FROM jobs WHERE id = ANY (v_a) AND name = 'job-5'), 'lower priority value is claimed first');
  PERFORM jk_test.eq((SELECT count(*)::int FROM jobs WHERE queue = 'test' AND status = 'RUNNING' AND attempts = 1), 5, 'claimed jobs RUNNING with attempts=1');

  PERFORM jk_test.ok(complete_job(v_a[1], 'worker-A', '{"ok":true}'), 'complete_job by owner');
  PERFORM jk_test.ok(NOT complete_job(v_a[2], 'worker-B', NULL), 'complete_job by non-owner is a no-op');
  PERFORM jk_test.eq(fail_job(v_a[2], 'worker-A', 'boom'), 'QUEUED', 'fail_job re-queues with backoff');
  PERFORM jk_test.ok((SELECT run_at > now() FROM jobs WHERE id = v_a[2]), 'backoff pushes run_at into the future');

  UPDATE jobs SET max_attempts = 1 WHERE id = v_b[1];
  PERFORM jk_test.eq(fail_job(v_b[1], 'worker-B', 'fatal'), 'DEAD', 'exhausted attempts -> DEAD');

  UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id = v_b[2];
  PERFORM jk_test.ok(reap_expired_jobs() >= 1, 'expired lease reaped');
  PERFORM jk_test.eq((SELECT status FROM jobs WHERE id = v_b[2]), 'QUEUED', 'reaped job back in queue');

  INSERT INTO jobs (queue, name, dedupe_key) VALUES ('test', 'dedupe', 'payout:123');
  PERFORM jk_test.throws($s$INSERT INTO jobs (queue, name, dedupe_key) VALUES ('test', 'dedupe', 'payout:123')$s$,
                         '23505', 'dedupe_key unique while job is live');

  -- outbox claim
  PERFORM jk_outbox('test', 'a', 'test.event_one', '{}');
  PERFORM jk_outbox('test', 'b', 'test.event_two', '{}');
  PERFORM jk_test.eq((SELECT count(*)::int FROM claim_outbox('relay-1', 10)), 2, 'relay claims unpublished outbox rows');
  PERFORM jk_test.eq((SELECT count(*)::int FROM claim_outbox('relay-2', 10)), 0, 'leased rows not re-claimed by another relay');
  UPDATE outbox_events SET published_at = now() WHERE aggregate_type = 'test';
  PERFORM jk_test.succeeds($s$DELETE FROM outbox_events WHERE aggregate_type = 'test'$s$, 'published outbox rows may be purged');
END $$;
ROLLBACK;
