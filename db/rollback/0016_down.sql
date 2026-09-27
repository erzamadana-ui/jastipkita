-- 0016_down.sql — reverts 0016_roles_grants.sql inside THIS database:
--   * revokes every privilege held by jk_app / jk_readonly on schema public objects,
--   * returns ownership of all objects to the session user,
--   * removes the default privileges and jk_apply_grants().
-- Roles are cluster-wide and may be used by other databases, so they are NOT dropped here.
-- To remove them afterwards (ops step, once no database references them):
--   DROP ROLE jk_readonly; DROP ROLE jk_app; DROP ROLE jk_migrator;
-- Must be run by a superuser or a member of jk_migrator (e.g. the migration account).
BEGIN;
DO $$
DECLARE o record; r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['jk_app','jk_readonly'] LOOP
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
    EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
  END LOOP;
  -- column-level grants are not covered by ALL TABLES
  FOR o IN SELECT DISTINCT table_name, grantee FROM information_schema.column_privileges
            WHERE table_schema = 'public' AND grantee IN ('jk_app','jk_readonly') LOOP
    EXECUTE format('REVOKE ALL (%s) ON TABLE %I FROM %I',
      (SELECT string_agg(quote_ident(column_name), ', ') FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = o.table_name), o.table_name, o.grantee);
  END LOOP;
  -- ownership back to the account running the rollback
  FOR o IN SELECT c.oid::regclass AS obj, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S') AND pg_get_userbyid(c.relowner) = 'jk_migrator'
              AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
                                                    AND d.objid = c.oid AND d.deptype IN ('a','i'))) LOOP
    EXECUTE format('ALTER %s %s OWNER TO %I',
      CASE o.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, o.obj, session_user);
  END LOOP;
  FOR o IN SELECT p.oid::regprocedure AS sig, p.prokind FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) = 'jk_migrator' LOOP
    EXECUTE format('ALTER %s %s OWNER TO %I', CASE o.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, o.sig, session_user);
  END LOOP;
  -- restore PostgreSQL's default EXECUTE-to-PUBLIC on our functions
  EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO PUBLIC';
  IF session_user <> 'jk_migrator' THEN
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM jk_app', session_user);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM jk_app', session_user);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM jk_app', session_user);
  END IF;
END $$;
ALTER DEFAULT PRIVILEGES FOR ROLE jk_migrator IN SCHEMA public REVOKE ALL ON TABLES FROM jk_app;
ALTER DEFAULT PRIVILEGES FOR ROLE jk_migrator IN SCHEMA public REVOKE ALL ON SEQUENCES FROM jk_app;
ALTER DEFAULT PRIVILEGES FOR ROLE jk_migrator IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM jk_app;
ALTER DEFAULT PRIVILEGES FOR ROLE jk_migrator GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
DELETE FROM jk_grant_policies WHERE table_name IN ('schema_migrations','jk_sensitive_columns','jk_grant_policies','status_transitions',
  'transaction_transitions','trip_transitions','dispute_transitions','settlement_account_changes','trust_score_overrides',
  'business_configs','customs_rules','restricted_items','legal_documents','settlement_accounts');
DROP FUNCTION IF EXISTS jk_apply_grants();
COMMIT;
