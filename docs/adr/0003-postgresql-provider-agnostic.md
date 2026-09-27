# ADR 0003 — Provider-agnostic PostgreSQL; Neon for staging

- Status: Accepted (2026-09)
- Deciders: owner (GM), engineering

## Context
Financial integrity (double-entry ledger, append-only audit, state machines, maker-checker) is enforced in the
database, not only in application code. Hosting must start at $0 and later move to a provider that meets
RPO ≤ 15 min / RTO ≤ 4 h without schema rewrites.

## Decision
- Plain SQL migrations (`db/migrations`, forward-only, checksummed) applied by a psql-only runner
  (`db/scripts/migrate.sh`); no ORM migrations, no provider-specific features (no RLS, no pg_cron, no
  Supabase `auth` schema, no superuser, only trusted extensions: pgcrypto, citext, pg_trgm, btree_gist).
- Roles: `jk_migrator` (owner, DDL), `jk_app` (API DML), `jk_readonly` (BI, column-level); per-environment LOGIN
  roles (`jk_migrate_staging`, `jk_api_staging`, …) are members of those.
- **Staging: Neon Free**, region `aws-ap-southeast-1` (Singapore, nearest to Indonesian users), pooled connection
  for the API, direct connection for migrations and backups.
- CI proves portability: `db/scripts/test-db.sh` on PostgreSQL 16 and 17, plus `scripts/ci/db-provider-parity.sh`
  which replays the Neon bootstrap as a non-superuser owner.

## Consequences
- Any managed PostgreSQL ≥ 15 (Neon, Supabase, RDS, Cloud SQL) can host production; the migration workflow is in
  `docs/08-backup-dr.md` §6.
- Known issue found by the parity test: on PostgreSQL ≥ 16 a non-superuser owner cannot apply 0016 unless the session
  sets `createrole_self_grant = 'set, inherit'` (documented workaround in `docs/07-deployment.md` §3, applied
  automatically by the deploy workflows). A permanent fix belongs to the DB owner.
- Neon Free limits (6 h PITR, compute-hour quota, scale-to-zero) make it unsuitable for production data.

## Alternatives considered
- Supabase free tier — pauses inactive projects, exposes PostgREST by default (mitigated by `jk_apply_grants()`).
- SQLite/D1 — no row-level locking semantics needed by SKIP LOCKED jobs and the ledger; rejected.
