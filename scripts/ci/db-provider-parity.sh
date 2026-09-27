#!/usr/bin/env bash
# Provider-parity test: replays the documented Neon bootstrap (docs/07-deployment.md §3) on a FRESH PostgreSQL
# cluster where the migrations are applied by a NON-superuser owner with CREATEROLE/CREATEDB — like Neon's
# `neondb_owner`, Supabase `postgres`, RDS master user. db/scripts/test-db.sh runs as superuser and cannot see this.
#
#   PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres bash scripts/ci/db-provider-parity.sh
#
# Requirements: a cluster in which the jk_* roles do NOT exist yet (run before test-db.sh, or on its own service).
# Steps:
#   0. probe   — apply the migrations WITHOUT the workaround; on PG16+ migration 0016 is expected to fail with
#                "must be able to SET ROLE jk_migrator" (known issue, reported to the DB owner). Informational only.
#   1. owner   — apply migrations + seeds as the non-superuser owner WITH the documented workaround
#                (PGOPTIONS="-c createrole_self_grant=set,inherit" on PostgreSQL ≥ 16).
#   2. roles   — owner creates LOGIN roles jk_migrate_ci (IN ROLE jk_migrator) and jk_api_ci (IN ROLE jk_app).
#   3. deploy  — as jk_migrate_ci: --verify, apply (no pending), seeds (idempotent) — exactly what CI deploys do.
#   4. runtime — as jk_api_ci: reads work, DDL / audit tampering are denied.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export PGHOST="${PGHOST:-localhost}" PGPORT="${PGPORT:-5432}" PGUSER="${PGUSER:-postgres}"
SUPER=(psql -X -q -v ON_ERROR_STOP=1 --no-psqlrc -d postgres)
OWNER_PW="owner_$(openssl rand -hex 12)"; MIG_PW="mig_$(openssl rand -hex 12)"; API_PW="api_$(openssl rand -hex 12)"
url() { echo "postgres://$1:$2@${PGHOST}:${PGPORT}/$3"; }

pass=0; fail=0
ok()  { echo "  PASS: $1"; pass=$((pass + 1)); }
bad() { echo "  FAIL: $1"; fail=$((fail + 1)); [[ -n "${GITHUB_ACTIONS:-}" ]] && echo "::error title=db-provider-parity::$1"; }

server=$("${SUPER[@]}" -At -c "SHOW server_version_num")
echo "server_version_num=$server"
if "${SUPER[@]}" -At -c "SELECT 1 FROM pg_roles WHERE rolname='jk_migrator'" | grep -q 1; then
  echo "FATAL: jk_migrator already exists in this cluster — run on a fresh cluster (before test-db.sh)." >&2; exit 2
fi

"${SUPER[@]}" -c "CREATE ROLE jk_ci_owner LOGIN CREATEROLE CREATEDB PASSWORD '$OWNER_PW'" \
               -c "CREATE DATABASE jk_parity_probe OWNER jk_ci_owner" \
               -c "CREATE DATABASE jk_parity OWNER jk_ci_owner" >/dev/null || { echo "FATAL: setup failed" >&2; exit 2; }

echo; echo "== 0. probe: migrations as non-superuser owner WITHOUT workaround"
probe=$(DATABASE_URL="$(url jk_ci_owner "$OWNER_PW" jk_parity_probe)" bash "$ROOT/db/scripts/migrate.sh" 2>&1); rc=$?
if [[ $rc -eq 0 ]]; then
  echo "  NOTE: 0016 applies without the workaround on this server — the createrole_self_grant step in docs/07-deployment.md can be dropped."
  [[ -n "${GITHUB_ACTIONS:-}" ]] && echo "::notice title=db-provider-parity::0016 applied without createrole_self_grant workaround (server $server)"
else
  echo "$probe" | grep -E 'ERROR|FATAL' | head -3 | sed 's/^/    /'
  if grep -q 'must be able to SET ROLE "jk_migrator"' <<<"$probe"; then
    echo "  KNOWN ISSUE reproduced: 0016 needs SET on jk_migrator for a CREATEROLE (non-superuser) owner on PG16+."
    [[ -n "${GITHUB_ACTIONS:-}" ]] && echo "::warning title=db-provider-parity::Known issue: migration 0016 fails for a non-superuser owner on PG ${server} without PGOPTIONS='-c createrole_self_grant=set,inherit' (see docs/07-deployment.md §3)"
  else
    bad "probe failed for an unexpected reason (see output above)"
  fi
fi
# a failed 0016 rolls back completely (roles included); if it succeeded the roles exist and are owned correctly.

echo; echo "== 1. owner bootstrap WITH workaround"
OWNER_URL="$(url jk_ci_owner "$OWNER_PW" jk_parity)"
extra=""; log=$(mktemp)
[[ "$server" -ge 160000 ]] && extra="-c createrole_self_grant=set,inherit"
if PGOPTIONS="$extra" DATABASE_URL="$OWNER_URL" bash "$ROOT/db/scripts/migrate.sh" >"$log" 2>&1 \
   && DATABASE_URL="$OWNER_URL" bash "$ROOT/db/scripts/seed.sh" >/dev/null 2>&1; then
  ok "migrations + seeds applied by non-superuser owner (server $server)"
else
  bad "owner bootstrap failed"; tail -5 "$log" | sed 's/^/    /'
fi

echo; echo "== 2. LOGIN roles created by the owner (as in the Neon SQL editor)"
if psql -X -q -v ON_ERROR_STOP=1 "$OWNER_URL" \
     -c "CREATE ROLE jk_migrate_ci LOGIN PASSWORD '$MIG_PW' IN ROLE jk_migrator" \
     -c "CREATE ROLE jk_api_ci LOGIN PASSWORD '$API_PW' IN ROLE jk_app" >/dev/null 2>&1; then
  ok "owner can create jk_migrate_ci IN ROLE jk_migrator and jk_api_ci IN ROLE jk_app"
else
  bad "owner cannot create LOGIN roles"
fi

echo; echo "== 3. deploy steps as jk_migrate_ci"
MIG_URL="$(url jk_migrate_ci "$MIG_PW" jk_parity)"
DATABASE_URL="$MIG_URL" bash "$ROOT/db/scripts/migrate.sh" --verify >/dev/null 2>&1 && ok "migrate.sh --verify" || bad "migrate.sh --verify as migrator"
out=$(DATABASE_URL="$MIG_URL" bash "$ROOT/db/scripts/migrate.sh" 2>&1)
[[ "$out" == "no pending migrations" ]] && ok "migrate.sh reports no pending migrations" || bad "migrate.sh as migrator: $out"
DATABASE_URL="$MIG_URL" bash "$ROOT/db/scripts/seed.sh" >/dev/null 2>&1 && ok "seeds idempotent as migrator" || bad "seed.sh as migrator"
owners=$(psql -X -At "$MIG_URL" -c "SELECT string_agg(DISTINCT tableowner, ',') FROM pg_tables WHERE schemaname='public'")
[[ "$owners" == "jk_migrator" ]] && ok "every table owned by jk_migrator" || bad "table owners: $owners"

echo; echo "== 4. runtime role jk_api_ci"
API_URL="$(url jk_api_ci "$API_PW" jk_parity)"
n=$(psql -X -At "$API_URL" -c "SELECT count(*) FROM currencies" 2>/dev/null)
[[ "${n:-0}" -gt 0 ]] && ok "API role reads reference data ($n currencies)" || bad "API role cannot read currencies"
v=$(psql -X -At "$API_URL" -c "SELECT max(version) FROM schema_migrations" 2>/dev/null)
[[ -n "$v" ]] && ok "API role reads schema version ($v) for /v1/health" || bad "API role cannot read schema_migrations"
psql -X -q "$API_URL" -c "CREATE TABLE jk_should_fail (i int)" >/dev/null 2>&1 && bad "API role can run DDL" || ok "API role cannot run DDL"
psql -X -q "$API_URL" -c "DELETE FROM audit_logs" >/dev/null 2>&1 && bad "API role can delete audit logs" || ok "API role cannot delete audit logs"
psql -X -q "$API_URL" -c "UPDATE ledger_entries SET amount = amount" >/dev/null 2>&1 && bad "API role can update ledger entries" || ok "API role cannot update ledger entries"

rm -f "$log"
"${SUPER[@]}" -c "DROP DATABASE IF EXISTS jk_parity_probe WITH (FORCE)" -c "DROP DATABASE IF EXISTS jk_parity WITH (FORCE)" >/dev/null 2>&1
echo; echo "== result: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
