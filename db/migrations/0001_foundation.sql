-- 0001_foundation.sql
-- Extensions, migration ledger, shared trigger functions, numbering, FSM helper,
-- grant/sensitivity registries. Every later migration depends on this file.
--
-- Custom SQLSTATE catalogue (class "JK" is not used by PostgreSQL):
--   JK001  append-only / immutable row violation
--   JK403  actor not permitted (FSM actor check, maker-checker approver lacks role)
--   JK404  entity not found
--   JK409  optimistic-lock version conflict
--   JK422  illegal state transition
--   JK423  precondition failed (e.g. anonymize_user with active transactions)
--   JKC01  credit balance would become negative
--   JKL01  ledger journal has < 2 entries
--   JKL02  ledger journal not balanced per currency
--   JKL03  posting to a non-ACTIVE ledger account
--   JKQ01  quote lines do not sum to TOTAL / quotes.total_idr
BEGIN;

-- Extensions: only ones available on Neon, Supabase, RDS, Cloud SQL. All four are
-- "trusted" (PG13+), so a non-superuser owner with CREATE on the database can install them.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- Migration ledger (the runner bootstraps an identical definition before 0001).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version       text PRIMARY KEY CHECK (version ~ '^[0-9]{4}$'),
  name          text NOT NULL,
  checksum      text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at    timestamptz NOT NULL DEFAULT now(),
  execution_ms  integer,
  applied_by    text NOT NULL DEFAULT current_user
);

-- ---------------------------------------------------------------------------
-- Registries consumed by jk_apply_grants() (0016). Each migration registers the
-- columns/tables it creates that jk_readonly must never read.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jk_sensitive_columns (
  table_name  text NOT NULL,
  column_name text NOT NULL,            -- '*' = whole table hidden from jk_readonly
  reason      text NOT NULL,
  PRIMARY KEY (table_name, column_name)
);
COMMENT ON TABLE jk_sensitive_columns IS
  'Columns hidden from jk_readonly in addition to the automatic rule (*_enc, *_hash, password*, *secret*). column_name=''*'' hides the table.';

CREATE TABLE IF NOT EXISTS jk_grant_policies (
  table_name      text PRIMARY KEY,
  app_access      text NOT NULL CHECK (app_access IN ('AUTO','READ','NO_DELETE','NONE')),
  readonly_access text NOT NULL DEFAULT 'AUTO' CHECK (readonly_access IN ('AUTO','NONE')),
  reason          text NOT NULL
);
COMMENT ON TABLE jk_grant_policies IS
  'Overrides for jk_apply_grants(). AUTO = derive from triggers (append-only => SELECT,INSERT; restricted => column UPDATE); READ = SELECT only; NO_DELETE = SELECT,INSERT,UPDATE.';

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION jk_attach_updated_at(p_table regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE OR REPLACE TRIGGER trg_set_updated_at BEFORE UPDATE ON %s '
                 'FOR EACH ROW EXECUTE FUNCTION set_updated_at()', p_table);
END $$;

-- ---------------------------------------------------------------------------
-- Append-only guards
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION jk_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'JK001',
    MESSAGE = format('%s is append-only: %s is not allowed', TG_TABLE_NAME, TG_OP),
    HINT    = 'Write a compensating row instead (reversal journal, new event, new version).';
END $$;

-- Rows are immutable except for the columns passed as trigger arguments.
CREATE OR REPLACE FUNCTION jk_restrict_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_allowed text[] := TG_ARGV;
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION USING ERRCODE = 'JK001',
      MESSAGE = format('%s is append-only: %s is not allowed', TG_TABLE_NAME, TG_OP);
  END IF;
  IF (to_jsonb(OLD) - v_allowed) IS DISTINCT FROM (to_jsonb(NEW) - v_allowed) THEN
    RAISE EXCEPTION USING ERRCODE = 'JK001',
      MESSAGE = format('%s is append-only: only (%s) may be updated', TG_TABLE_NAME, array_to_string(v_allowed, ', '));
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION jk_make_append_only(p_table regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE OR REPLACE TRIGGER trg_append_only BEFORE UPDATE OR DELETE ON %s '
                 'FOR EACH ROW EXECUTE FUNCTION jk_append_only()', p_table);
  EXECUTE format('CREATE OR REPLACE TRIGGER trg_append_only_truncate BEFORE TRUNCATE ON %s '
                 'FOR EACH STATEMENT EXECUTE FUNCTION jk_append_only()', p_table);
END $$;

CREATE OR REPLACE FUNCTION jk_make_restricted(p_table regclass, VARIADIC p_cols text[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_args text;
BEGIN
  SELECT string_agg(quote_literal(c), ', ') INTO v_args FROM unnest(p_cols) c;
  EXECUTE format('CREATE OR REPLACE TRIGGER trg_restrict_update BEFORE UPDATE OR DELETE ON %s '
                 'FOR EACH ROW EXECUTE FUNCTION jk_restrict_update(%s)', p_table, v_args);
  EXECUTE format('CREATE OR REPLACE TRIGGER trg_append_only_truncate BEFORE TRUNCATE ON %s '
                 'FOR EACH STATEMENT EXECUTE FUNCTION jk_append_only()', p_table);
END $$;

-- ---------------------------------------------------------------------------
-- Actor context (optional). The API may SET LOCAL jk.actor_type / jk.actor_id /
-- jk.request_id so that trigger-written events and audit rows carry the actor.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION jk_ctx_actor_type() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('jk.actor_type', true), ''), 'SYSTEM') $$;

CREATE OR REPLACE FUNCTION jk_ctx_actor_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('jk.actor_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION jk_ctx_request_id() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('jk.request_id', true), '') $$;

-- ---------------------------------------------------------------------------
-- Human-readable numbers: PREFIX-YYMMDD-XXXXXX (Crockford base32, WIB date).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION jk_crockford_random(p_len integer) RETURNS text
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_bytes bytea := uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid());
  v_out text := '';
BEGIN
  IF p_len < 1 OR p_len > 16 THEN RAISE EXCEPTION 'p_len must be 1..16'; END IF;
  FOR i IN 0 .. p_len - 1 LOOP
    -- 256 is a multiple of 32, so byte % 32 is uniform. Skip bytes 6 and 8 of each
    -- uuid (version / variant nibbles) by reading odd offsets only.
    v_out := v_out || substr(v_alphabet, (get_byte(v_bytes, (i * 2 + 1) % 32) % 32) + 1, 1);
  END LOOP;
  RETURN v_out;
END $$;

CREATE OR REPLACE FUNCTION jk_human_number(p_prefix text) RETURNS text
LANGUAGE sql VOLATILE AS $$
  SELECT p_prefix || '-' || to_char(now() AT TIME ZONE 'Asia/Jakarta', 'YYMMDD') || '-' || jk_crockford_random(6)
$$;

-- BEFORE INSERT trigger: fills NEW.number when NULL, retrying on (rare) collisions.
-- TG_ARGV[0] = prefix. The UNIQUE constraint remains the final guard.
CREATE OR REPLACE FUNCTION jk_assign_number() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_candidate text;
  v_exists boolean;
BEGIN
  IF NEW.number IS NOT NULL THEN RETURN NEW; END IF;
  FOR attempt IN 1 .. 8 LOOP
    v_candidate := jk_human_number(TG_ARGV[0]);
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE number = $1)', TG_TABLE_SCHEMA, TG_TABLE_NAME)
      INTO v_exists USING v_candidate;
    IF NOT v_exists THEN
      NEW.number := v_candidate;
      RETURN NEW;
    END IF;
  END LOOP;
  RAISE EXCEPTION 'could not allocate a unique % number after 8 attempts', TG_ARGV[0];
END $$;

CREATE OR REPLACE FUNCTION jk_number_pattern(p_prefix text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT '^' || p_prefix || '-[0-9]{6}-[0-9A-HJKMNP-TV-Z]{6}$' $$;

-- ---------------------------------------------------------------------------
-- Generic FSM guard for secondary state machines (payments, refunds, payouts,
-- price confirmations, quotes, fx locks). Transactions/trips/disputes have their
-- own actor-aware tables + transition_*() functions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS status_transitions (
  machine     text NOT NULL CHECK (machine ~ '^[A-Z_]+$'),
  from_status text NOT NULL,
  to_status   text NOT NULL,
  note        text,
  PRIMARY KEY (machine, from_status, to_status),
  CHECK (from_status <> to_status)
);

CREATE OR REPLACE FUNCTION jk_enforce_fsm() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
       SELECT 1 FROM status_transitions
        WHERE machine = TG_ARGV[0] AND from_status = OLD.status AND to_status = NEW.status) THEN
    RAISE EXCEPTION USING ERRCODE = 'JK422',
      MESSAGE = format('illegal %s transition %s -> %s', TG_ARGV[0], OLD.status, NEW.status);
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION jk_attach_fsm(p_table regclass, p_machine text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE OR REPLACE TRIGGER trg_enforce_fsm BEFORE UPDATE OF status ON %s '
                 'FOR EACH ROW EXECUTE FUNCTION jk_enforce_fsm(%L)', p_table, p_machine);
END $$;

-- Guard that blocks direct status changes on tables whose status may only change
-- through a transition_*() function. The function sets jk.fsm_ctx = '<table>:<id>'
-- (transaction-local) around its UPDATE. This protects against accidental writes
-- by application code; it is not a security boundary against a malicious jk_app.
CREATE OR REPLACE FUNCTION jk_status_via_function_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM TG_ARGV[0] THEN
      RAISE EXCEPTION USING ERRCODE = 'JK422',
        MESSAGE = format('%s must be created with status %s (got %s)', TG_TABLE_NAME, TG_ARGV[0], NEW.status);
    END IF;
    NEW.version := 1;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND coalesce(current_setting('jk.fsm_ctx', true), '') <> TG_TABLE_NAME || ':' || OLD.id THEN
    RAISE EXCEPTION USING ERRCODE = 'JK422',
      MESSAGE = format('%s.status can only change through transition function', TG_TABLE_NAME),
      HINT = 'Use transition_transaction() / transition_trip() / transition_dispute().';
  END IF;
  IF NEW.version < OLD.version THEN
    RAISE EXCEPTION USING ERRCODE = 'JK409', MESSAGE = format('%s.version cannot decrease', TG_TABLE_NAME);
  END IF;
  RETURN NEW;
END $$;

COMMIT;
