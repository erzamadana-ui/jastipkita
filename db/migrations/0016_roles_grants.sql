-- 0016_roles_grants.sql
-- Database roles, object ownership and privileges. Reversible: db/rollback/0016_down.sql.
--
--   jk_migrator  NOLOGIN  owns every object; runs DDL (migrations run `SET ROLE jk_migrator`)
--   jk_app       NOLOGIN  API runtime: DML only. Append-only tables: SELECT, INSERT.
--                         Restricted tables: SELECT, INSERT + UPDATE on bookkeeping columns.
--                         No DDL, no TRUNCATE, no REFERENCES/TRIGGER.
--   jk_readonly  NOLOGIN  BI/analytics: SELECT on non-sensitive tables & views; never *_enc,
--                         *_hash, secrets, contact PII or chat bodies (column-level grants).
--
-- LOGIN users are environment-specific and created per provider, e.g.
--   CREATE ROLE jk_api_prod LOGIN PASSWORD '...' IN ROLE jk_app;          -- INHERIT (default)
--   CREATE ROLE jk_migrate_prod LOGIN PASSWORD '...' IN ROLE jk_migrator;
-- (see docs/03-database.md "Provider portability").
--
-- jk_apply_grants() recomputes all privileges from the catalog + registries and is
-- idempotent. Every future migration that adds a table must end with
--   SELECT jk_apply_grants();
-- (the migration runner also calls it after the last pending migration).
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jk_migrator') THEN CREATE ROLE jk_migrator NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jk_app')      THEN CREATE ROLE jk_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jk_readonly') THEN CREATE ROLE jk_readonly NOLOGIN; END IF;
  -- The account applying migrations must be able to SET ROLE jk_migrator. On PostgreSQL 16+
  -- membership alone is not enough for non-superuser owners (e.g. Neon's neondb_owner):
  -- the grant needs the SET (and INHERIT) option, and the check must test 'SET'.
  IF current_setting('server_version_num')::int >= 160000 THEN
    IF current_user <> 'jk_migrator' AND NOT pg_has_role(current_user, 'jk_migrator', 'SET') THEN
      EXECUTE format('GRANT jk_migrator TO %I WITH INHERIT TRUE, SET TRUE', current_user);
    END IF;
  ELSIF current_user <> 'jk_migrator' AND NOT pg_has_role(current_user, 'jk_migrator', 'MEMBER') THEN
    EXECUTE format('GRANT jk_migrator TO %I', current_user);
  END IF;
END $$;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO jk_app', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO jk_readonly', current_database());
  EXECUTE format('GRANT CONNECT, CREATE ON DATABASE %I TO jk_migrator', current_database());
END $$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO jk_migrator;
GRANT USAGE ON SCHEMA public TO jk_app, jk_readonly;

-- Tables that only migrations/seeds may change.
INSERT INTO jk_grant_policies (table_name, app_access, readonly_access, reason) VALUES
  ('schema_migrations',       'READ',      'AUTO', 'written by the migration runner as jk_migrator'),
  ('jk_sensitive_columns',    'READ',      'AUTO', 'registry, changed by migrations'),
  ('jk_grant_policies',       'READ',      'AUTO', 'registry, changed by migrations'),
  ('status_transitions',      'READ',      'AUTO', 'state machines are seeded, not edited at runtime'),
  ('transaction_transitions', 'READ',      'AUTO', 'state machines are seeded, not edited at runtime'),
  ('trip_transitions',        'READ',      'AUTO', 'state machines are seeded, not edited at runtime'),
  ('dispute_transitions',     'READ',      'AUTO', 'state machines are seeded, not edited at runtime'),
  ('settlement_account_changes', 'NO_DELETE', 'AUTO', 'maker-checker history'),
  ('trust_score_overrides',   'NO_DELETE', 'AUTO', 'maker-checker history'),
  ('business_configs',        'NO_DELETE', 'AUTO', 'versioned config history (drafts are rejected, not deleted)'),
  ('customs_rules',           'NO_DELETE', 'AUTO', 'versioned regulatory rules'),
  ('restricted_items',        'NO_DELETE', 'AUTO', 'versioned regulatory rules'),
  ('legal_documents',         'NO_DELETE', 'AUTO', 'consent evidence'),
  ('settlement_accounts',     'NO_DELETE', 'AUTO', 'written only via apply_settlement_account_change()')
ON CONFLICT (table_name) DO UPDATE SET app_access = EXCLUDED.app_access, reason = EXCLUDED.reason;

CREATE OR REPLACE FUNCTION jk_apply_grants() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  t record;
  f record;
  r text;
  v_rel text;
  v_all_cols text;
  v_ro_cols text;
  v_ro_hidden integer;
  v_app text;
  v_ro text;
  v_append boolean;
  v_restricted text[];
BEGIN
  FOR t IN
    SELECT c.oid, c.relname, c.relkind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
     ORDER BY c.relname
  LOOP
    v_rel := quote_ident(t.relname);
    SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO v_all_cols
      FROM pg_attribute WHERE attrelid = t.oid AND attnum > 0 AND NOT attisdropped;

    -- Reset (table- and column-level) for managed roles and provider API roles.
    FOREACH r IN ARRAY ARRAY['jk_app','jk_readonly','anon','authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', v_rel, r);
        EXECUTE format('REVOKE ALL (%s) ON TABLE %s FROM %I', v_all_cols, v_rel, r);
      END IF;
    END LOOP;
    EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC', v_rel);

    SELECT app_access, readonly_access INTO v_app, v_ro FROM jk_grant_policies WHERE table_name = t.relname;
    v_app := coalesce(v_app, 'AUTO');
    v_ro := coalesce(v_ro, 'AUTO');

    -- ---- jk_app ----
    v_append := EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = t.oid AND tgname = 'trg_append_only');
    SELECT array_remove(string_to_array(encode(tgargs, 'escape'), '\000'), '') INTO v_restricted
      FROM pg_trigger WHERE tgrelid = t.oid AND tgname = 'trg_restrict_update';

    IF t.relkind IN ('v','m') OR v_app = 'READ' THEN
      EXECUTE format('GRANT SELECT ON TABLE %s TO jk_app', v_rel);
    ELSIF v_app = 'NONE' THEN
      NULL;
    ELSIF v_append THEN
      EXECUTE format('GRANT SELECT, INSERT ON TABLE %s TO jk_app', v_rel);
    ELSIF v_restricted IS NOT NULL THEN
      EXECUTE format('GRANT SELECT, INSERT ON TABLE %s TO jk_app', v_rel);
      EXECUTE format('GRANT UPDATE (%s) ON TABLE %s TO jk_app',
                     (SELECT string_agg(quote_ident(c), ', ') FROM unnest(v_restricted) c), v_rel);
    ELSIF v_app = 'NO_DELETE' THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE %s TO jk_app', v_rel);
    ELSE
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %s TO jk_app', v_rel);
    END IF;

    -- ---- jk_readonly ----
    IF v_ro = 'NONE' OR EXISTS (SELECT 1 FROM jk_sensitive_columns WHERE table_name = t.relname AND column_name = '*') THEN
      CONTINUE;
    END IF;
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) FILTER (WHERE NOT s.hidden),
           count(*) FILTER (WHERE s.hidden)
      INTO v_ro_cols, v_ro_hidden
      FROM pg_attribute a
      CROSS JOIN LATERAL (SELECT (a.attname ~ '(_enc|_hash)$' OR a.attname ~ '(^password|secret|token)'
                                  OR EXISTS (SELECT 1 FROM jk_sensitive_columns sc
                                              WHERE sc.table_name = t.relname AND sc.column_name = a.attname)) AS hidden) s
     WHERE a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped;
    IF v_ro_hidden = 0 THEN
      EXECUTE format('GRANT SELECT ON TABLE %s TO jk_readonly', v_rel);
    ELSIF v_ro_cols IS NOT NULL THEN
      EXECUTE format('GRANT SELECT (%s) ON TABLE %s TO jk_readonly', v_ro_cols, v_rel);
    END IF;
  END LOOP;

  -- Sequences (identity sequences need no grant for INSERT; kept for explicit nextval users)
  EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO jk_app';

  -- Functions: nobody by default; jk_app gets runtime functions, not the DDL helpers.
  FOR f IN
    SELECT p.oid::regprocedure AS sig, p.prokind, p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind IN ('f','p')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('REVOKE ALL ON %s %s FROM PUBLIC', CASE f.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, f.sig);
    FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON %s %s FROM %I', CASE f.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, f.sig, r);
      END IF;
    END LOOP;
    IF f.proname ~ '^jk_(apply_|make_|attach_)' THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM jk_app', f.sig);
    ELSE
      EXECUTE format('GRANT EXECUTE ON %s %s TO jk_app', CASE f.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, f.sig);
    END IF;
  END LOOP;
END $$;

-- Transfer ownership of everything we created to jk_migrator (idempotent).
DO $$
DECLARE o record;
BEGIN
  FOR o IN
    SELECT c.oid::regclass AS obj, c.relkind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S')
       AND pg_get_userbyid(c.relowner) <> 'jk_migrator'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
       -- identity/serial sequences follow their table
       AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
                                             AND d.objid = c.oid AND d.deptype IN ('a','i')))
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO jk_migrator',
                   CASE o.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
                   o.obj);
  END LOOP;
  FOR o IN
    SELECT p.oid::regprocedure AS sig, p.prokind
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind IN ('f','p')
       AND pg_get_userbyid(p.proowner) <> 'jk_migrator'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO jk_migrator', CASE o.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, o.sig);
  END LOOP;
END $$;

-- Safety net for objects created later by jk_migrator (or by the admin account applying
-- migrations) before jk_apply_grants() runs. jk_readonly deliberately gets nothing by
-- default: new tables may contain sensitive columns.
ALTER DEFAULT PRIVILEGES FOR ROLE jk_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO jk_app;
ALTER DEFAULT PRIVILEGES FOR ROLE jk_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO jk_app;
ALTER DEFAULT PRIVILEGES FOR ROLE jk_migrator IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO jk_app;
ALTER DEFAULT PRIVILEGES FOR ROLE jk_migrator REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
DO $$
BEGIN
  IF current_user <> 'jk_migrator' THEN
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO jk_app', current_user);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO jk_app', current_user);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO jk_app', current_user);
  END IF;
END $$;

SELECT jk_apply_grants();

COMMIT;
