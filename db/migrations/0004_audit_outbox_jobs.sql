-- 0004_audit_outbox_jobs.sql
-- Hash-chained audit log, transactional outbox, Postgres job queue, idempotency keys.
BEGIN;

-- ---------------------------------------------------------------------------
-- audit_logs: append-only, hash chain.
--   hash = sha256(prev_hash || utf8(audit_log_canonical(row)))
-- Linearity: the BEFORE INSERT trigger locks the single audit_chain_head row
-- (SELECT ... FOR UPDATE), assigns id = last_id + 1 (gapless) and prev_hash =
-- last_hash, then advances the head. Concurrent writers queue on that row lock
-- until the holder commits; under REPEATABLE READ/SERIALIZABLE a concurrent
-- writer gets a serialization failure and must retry (never a fork).
-- Rule for callers: write audit rows as the LAST statement before COMMIT, so the
-- head lock is held as briefly as possible and cannot participate in deadlocks.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id          bigint PRIMARY KEY,                 -- assigned by trigger (gapless)
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_type  text NOT NULL CHECK (actor_type IN ('USER','BUYER','TRAVELER','ADMIN','SYSTEM','WEBHOOK','JOB')),
  actor_id    uuid,
  actor_role  text,
  action      text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'),
  entity_type text NOT NULL,
  entity_id   text,
  request_id  text,
  ip_hash     bytea,
  before      jsonb,
  after       jsonb,
  meta        jsonb NOT NULL DEFAULT '{}',
  prev_hash   bytea NOT NULL CHECK (octet_length(prev_hash) = 32),
  hash        bytea NOT NULL UNIQUE CHECK (octet_length(hash) = 32)
);
CREATE INDEX IF NOT EXISTS audit_logs_entity_idx ON audit_logs (entity_type, entity_id, id DESC);
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx ON audit_logs (actor_id, id DESC) WHERE actor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs (action, occurred_at DESC);

CREATE TABLE IF NOT EXISTS audit_chain_head (
  singleton  boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_id    bigint NOT NULL,
  last_hash  bytea NOT NULL CHECK (octet_length(last_hash) = 32),
  updated_at timestamptz NOT NULL DEFAULT now()
) WITH (fillfactor = 50);
INSERT INTO audit_chain_head (singleton, last_id, last_hash)
VALUES (true, 0, decode(repeat('00', 32), 'hex'))
ON CONFLICT DO NOTHING;
INSERT INTO jk_grant_policies VALUES
  ('audit_chain_head','READ','AUTO','advanced only by the SECURITY DEFINER audit trigger')
ON CONFLICT DO NOTHING;

-- Periodic external anchors of the chain tail (e.g. copied to object-lock storage)
-- so that a privileged full rewrite of the chain is detectable too.
CREATE TABLE IF NOT EXISTS audit_chain_checkpoints (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  last_id     bigint NOT NULL,
  last_hash   bytea NOT NULL,
  anchored_to text,                 -- e.g. s3://audit-anchors/2026/09/27.json (object-lock)
  created_at  timestamptz NOT NULL DEFAULT now()
);
SELECT jk_make_append_only('audit_chain_checkpoints');

CREATE OR REPLACE FUNCTION audit_log_canonical(r audit_logs) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_array(
           r.id,
           to_char(r.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           r.actor_type, r.actor_id, r.actor_role, r.action, r.entity_type, r.entity_id,
           r.request_id, encode(r.ip_hash, 'hex'), r.before, r.after, r.meta
         )::text
$$;

CREATE OR REPLACE FUNCTION audit_log_compute_hash(r audit_logs) RETURNS bytea
LANGUAGE sql STABLE AS $$
  SELECT sha256(r.prev_hash || convert_to(audit_log_canonical(r), 'UTF8'))
$$;

CREATE OR REPLACE FUNCTION jk_audit_chain() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_head audit_chain_head%ROWTYPE;
BEGIN
  SELECT * INTO v_head FROM audit_chain_head WHERE singleton FOR UPDATE;
  NEW.id := v_head.last_id + 1;
  NEW.occurred_at := now();                      -- DB time; callers cannot backdate
  NEW.meta := coalesce(NEW.meta, '{}'::jsonb);
  NEW.request_id := coalesce(NEW.request_id, jk_ctx_request_id());
  NEW.prev_hash := v_head.last_hash;
  NEW.hash := audit_log_compute_hash(NEW);
  UPDATE audit_chain_head SET last_id = NEW.id, last_hash = NEW.hash, updated_at = now() WHERE singleton;
  RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER trg_audit_chain BEFORE INSERT ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION jk_audit_chain();
SELECT jk_make_append_only('audit_logs');

-- Returns the first id in [p_from_id, p_to_id] whose link or hash is broken, or NULL.
-- When the whole chain is verified (no bounds), a truncated tail is also detected by
-- comparing with audit_chain_head (returns last_id + 1 conceptually: the head id).
CREATE OR REPLACE FUNCTION verify_audit_chain(p_from_id bigint DEFAULT NULL, p_to_id bigint DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_prev bytea;
  v_last_id bigint := 0;
  r audit_logs%ROWTYPE;
  v_head audit_chain_head%ROWTYPE;
BEGIN
  IF p_from_id IS NULL OR p_from_id <= 1 THEN
    v_prev := decode(repeat('00', 32), 'hex');
  ELSE
    SELECT hash INTO v_prev FROM audit_logs WHERE id = p_from_id - 1;
    IF NOT FOUND THEN RETURN p_from_id - 1; END IF;   -- predecessor missing (gapless ids)
    v_last_id := p_from_id - 1;
  END IF;

  FOR r IN SELECT * FROM audit_logs
            WHERE (p_from_id IS NULL OR id >= p_from_id) AND (p_to_id IS NULL OR id <= p_to_id)
            ORDER BY id
  LOOP
    IF r.id <> v_last_id + 1 THEN RETURN v_last_id + 1; END IF;          -- deleted row
    IF r.prev_hash IS DISTINCT FROM v_prev THEN RETURN r.id; END IF;     -- broken link
    IF r.hash IS DISTINCT FROM audit_log_compute_hash(r) THEN RETURN r.id; END IF;  -- tampered data
    v_prev := r.hash;
    v_last_id := r.id;
  END LOOP;

  IF p_to_id IS NULL THEN
    SELECT * INTO v_head FROM audit_chain_head WHERE singleton;
    IF v_head.last_id <> v_last_id OR v_head.last_hash IS DISTINCT FROM v_prev THEN
      RETURN v_last_id + 1;                                              -- truncated tail
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- Convenience writer used by DB functions (transition_*, config activation, ...).
CREATE OR REPLACE FUNCTION jk_audit(p_actor_type text, p_actor_id uuid, p_action text, p_entity_type text,
                                    p_entity_id text, p_before jsonb, p_after jsonb, p_meta jsonb DEFAULT '{}')
RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  INSERT INTO audit_logs (actor_type, actor_id, action, entity_type, entity_id, before, after, meta)
  VALUES (p_actor_type, p_actor_id, p_action, p_entity_type, p_entity_id, p_before, p_after, coalesce(p_meta, '{}'))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- Transactional outbox. Rows are written in the same DB transaction as the state
-- change; a relay publishes them (push/email/webhooks/analytics) at-least-once.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outbox_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id       uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,
  aggregate_id   text NOT NULL,
  event_type     text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'),
  payload        jsonb NOT NULL DEFAULT '{}',
  headers        jsonb NOT NULL DEFAULT '{}',
  available_at   timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  attempts       integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error     text,
  locked_by      text,
  locked_until   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx ON outbox_events (available_at, id) WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS outbox_aggregate_idx ON outbox_events (aggregate_type, aggregate_id, id);
CREATE INDEX IF NOT EXISTS outbox_published_idx ON outbox_events (published_at) WHERE published_at IS NOT NULL;
INSERT INTO jk_sensitive_columns VALUES
  ('outbox_events','payload','event payloads may carry free-text reasons'),
  ('outbox_events','headers','transport metadata')
ON CONFLICT DO NOTHING;
-- Payload is immutable; only delivery bookkeeping may change. Published rows may be
-- purged by the retention job (DELETE is allowed only for published rows).
CREATE OR REPLACE FUNCTION jk_outbox_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.published_at IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'JK001', MESSAGE = 'outbox_events: unpublished events cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(OLD) - ARRAY['available_at','published_at','attempts','last_error','locked_by','locked_until'])
     IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['available_at','published_at','attempts','last_error','locked_by','locked_until']) THEN
    RAISE EXCEPTION USING ERRCODE = 'JK001', MESSAGE = 'outbox_events: event content is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER trg_outbox_guard BEFORE UPDATE OR DELETE ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION jk_outbox_guard();

CREATE OR REPLACE FUNCTION jk_outbox(p_aggregate_type text, p_aggregate_id text, p_event_type text, p_payload jsonb)
RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
  VALUES (p_aggregate_type, p_aggregate_id, p_event_type, coalesce(p_payload, '{}'))
  RETURNING id
$$;

CREATE OR REPLACE FUNCTION claim_outbox(p_worker text, p_limit integer DEFAULT 100, p_lease_seconds integer DEFAULT 60)
RETURNS SETOF outbox_events
LANGUAGE sql AS $$
  WITH picked AS (
    SELECT id FROM outbox_events
     WHERE published_at IS NULL AND available_at <= now()
       AND (locked_until IS NULL OR locked_until < now())
     ORDER BY available_at, id
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE outbox_events o
     SET locked_by = p_worker,
         locked_until = now() + make_interval(secs => p_lease_seconds),
         attempts = o.attempts + 1
    FROM picked WHERE o.id = picked.id
  RETURNING o.*
$$;

-- ---------------------------------------------------------------------------
-- Job queue
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue        text NOT NULL CHECK (queue ~ '^[a-z][a-z0-9_.-]*$'),
  name         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  priority     smallint NOT NULL DEFAULT 100,          -- lower runs first
  run_at       timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','DEAD','CANCELLED')),
  attempts     integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 10 CHECK (max_attempts > 0),
  dedupe_key   text,
  locked_by    text,
  locked_at    timestamptz,
  lease_until  timestamptz,
  last_error   text,
  result       jsonb,
  finished_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'RUNNING' OR (locked_by IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs (queue, priority, run_at, id) WHERE status = 'QUEUED';
CREATE INDEX IF NOT EXISTS jobs_lease_idx ON jobs (lease_until) WHERE status = 'RUNNING';
CREATE INDEX IF NOT EXISTS jobs_finished_idx ON jobs (finished_at) WHERE status IN ('SUCCEEDED','CANCELLED','DEAD');
CREATE UNIQUE INDEX IF NOT EXISTS jobs_dedupe_uq ON jobs (queue, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('QUEUED','RUNNING');
SELECT jk_attach_updated_at('jobs');
INSERT INTO jk_sensitive_columns VALUES
  ('jobs','payload','job arguments may carry recipient addresses'),
  ('jobs','result','job output')
ON CONFLICT DO NOTHING;

-- Claims up to p_limit runnable jobs. FOR UPDATE SKIP LOCKED lets any number of
-- workers poll concurrently without blocking each other or double-claiming.
CREATE OR REPLACE FUNCTION claim_jobs(p_queue text, p_worker text, p_limit integer DEFAULT 1,
                                      p_lease_seconds integer DEFAULT 300)
RETURNS SETOF jobs
LANGUAGE sql AS $$
  WITH picked AS (
    SELECT id FROM jobs
     WHERE queue = p_queue AND status = 'QUEUED' AND run_at <= now()
     ORDER BY priority, run_at, id
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE jobs j
     SET status = 'RUNNING', attempts = j.attempts + 1, locked_by = p_worker,
         locked_at = now(), lease_until = now() + make_interval(secs => p_lease_seconds)
    FROM picked WHERE j.id = picked.id
  RETURNING j.*
$$;

CREATE OR REPLACE FUNCTION complete_job(p_id uuid, p_worker text, p_result jsonb DEFAULT NULL)
RETURNS boolean LANGUAGE sql AS $$
  WITH u AS (
    UPDATE jobs SET status = 'SUCCEEDED', result = p_result, finished_at = now(),
                    locked_by = NULL, lease_until = NULL
     WHERE id = p_id AND status = 'RUNNING' AND locked_by = p_worker
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u)
$$;

-- Exponential backoff: 2^attempts seconds (capped at 1h) plus up to 25% jitter.
CREATE OR REPLACE FUNCTION fail_job(p_id uuid, p_worker text, p_error text)
RETURNS text LANGUAGE sql AS $$
  WITH u AS (
    UPDATE jobs
       SET status = CASE WHEN attempts >= max_attempts THEN 'DEAD' ELSE 'QUEUED' END,
           last_error = left(p_error, 4000),
           run_at = now() + make_interval(secs => least(3600, power(2, attempts))::int * (1 + random() * 0.25)),
           finished_at = CASE WHEN attempts >= max_attempts THEN now() END,
           locked_by = NULL, locked_at = NULL, lease_until = NULL
     WHERE id = p_id AND status = 'RUNNING' AND locked_by = p_worker
    RETURNING status)
  SELECT status FROM u
$$;

-- Returns RUNNING jobs whose lease expired (crashed worker) to the queue.
CREATE OR REPLACE FUNCTION reap_expired_jobs() RETURNS integer
LANGUAGE sql AS $$
  WITH u AS (
    UPDATE jobs
       SET status = CASE WHEN attempts >= max_attempts THEN 'DEAD' ELSE 'QUEUED' END,
           last_error = coalesce(last_error, '') || ' [lease expired: ' || coalesce(locked_by, '?') || ']',
           finished_at = CASE WHEN attempts >= max_attempts THEN now() END,
           locked_by = NULL, locked_at = NULL, lease_until = NULL
     WHERE status = 'RUNNING' AND lease_until < now()
    RETURNING 1)
  SELECT count(*)::int FROM u
$$;

-- ---------------------------------------------------------------------------
-- Idempotency keys for financial mutations (Idempotency-Key header).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key              text NOT NULL CHECK (char_length(key) BETWEEN 8 AND 255),
  method           text NOT NULL CHECK (method IN ('POST','PUT','PATCH','DELETE')),
  path             text NOT NULL,
  request_hash     bytea NOT NULL,
  status           text NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS','COMPLETED','FAILED')),
  locked_until     timestamptz,
  response_status  smallint,
  response_body    jsonb,
  response_headers jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  expires_at       timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (user_id, key),
  CHECK (status <> 'COMPLETED' OR response_status IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idempotency_keys_expires_at_idx ON idempotency_keys (expires_at);
INSERT INTO jk_sensitive_columns VALUES ('idempotency_keys','*','stored API responses may contain PII') ON CONFLICT DO NOTHING;

COMMIT;
