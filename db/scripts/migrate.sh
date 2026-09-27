#!/usr/bin/env bash
# JastipKita migration runner (psql only, no Node deps).
#
#   db/scripts/migrate.sh                 apply pending migrations
#   db/scripts/migrate.sh --to NNNN       apply pending migrations up to and including NNNN
#   db/scripts/migrate.sh --status        list migrations and their state
#   db/scripts/migrate.sh --verify        fail if an applied file's checksum changed
#   db/scripts/migrate.sh --rollback NNNN run db/rollback/NNNN_down.sql (NNNN must be the latest applied)
#
# Connection: DATABASE_URL, or the standard PG* environment variables.
# Each migration file must contain exactly one line `BEGIN;` and one line `COMMIT;`
# (so it can be applied by hand with psql). The runner strips those two lines and
# wraps the body together with its schema_migrations row in ONE transaction, under
# an advisory lock, as jk_migrator when that role exists (so new objects get the
# right owner and default privileges).
set -euo pipefail

DB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_DIR="$DB_DIR/migrations"
RB_DIR="$DB_DIR/rollback"
LOCK_KEY=727372010   # arbitrary constant: "jk migrations"

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"
PSQL=(psql -X -q -v ON_ERROR_STOP=1 --no-psqlrc)
if [[ -n "${DATABASE_URL:-}" ]]; then PSQL+=("$DATABASE_URL"); fi

sql() { "${PSQL[@]}" -At -c "$1"; }
sha() { sha256sum "$1" | cut -d' ' -f1; }

bootstrap() {
  "${PSQL[@]}" -c "CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY CHECK (version ~ '^[0-9]{4}\$'),
    name text NOT NULL,
    checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}\$'),
    applied_at timestamptz NOT NULL DEFAULT now(),
    execution_ms integer,
    applied_by text NOT NULL DEFAULT current_user)" >/dev/null 2>&1 || true
}

migration_files() { find "$MIG_DIR" -maxdepth 1 -type f -regex '.*/[0-9][0-9][0-9][0-9]_[a-z0-9_]*\.sql' | sort; }

role_clause() {
  # SET LOCAL ROLE jk_migrator once 0016 has been applied in THIS database (the role is
  # cluster-wide and may already exist, but only 0016 grants it CREATE on this database).
  local ok
  ok=$(sql "SELECT (EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0016')
                    AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jk_migrator')
                    AND (current_user = 'jk_migrator' OR pg_has_role(current_user, 'jk_migrator', 'MEMBER')))::int" 2>/dev/null || echo 0)
  if [[ "$ok" == "1" ]]; then echo "SET LOCAL ROLE jk_migrator;"; fi
}

check_wrapped() {
  local f="$1"
  [[ $(grep -c '^BEGIN;$' "$f") -eq 1 && $(grep -c '^COMMIT;$' "$f") -eq 1 ]] || {
    echo "ERROR: $f must contain exactly one 'BEGIN;' line and one 'COMMIT;' line" >&2; exit 2; }
}

cmd="${1:-apply}"
target="9999"
if [[ "$cmd" == "--to" ]]; then target="${2:?usage: migrate.sh --to NNNN}"; cmd="apply"; fi
bootstrap

case "$cmd" in
  --status)
    while read -r f; do
      base=$(basename "$f" .sql); v=${base%%_*}
      applied=$(sql "SELECT checksum FROM schema_migrations WHERE version = '$v'")
      if [[ -z "$applied" ]]; then state="PENDING"
      elif [[ "$applied" == "$(sha "$f")" ]]; then state="applied"
      else state="CHECKSUM MISMATCH"; fi
      printf '%-40s %s\n' "$base" "$state"
    done < <(migration_files)
    ;;

  --verify)
    bad=0
    while read -r f; do
      base=$(basename "$f" .sql); v=${base%%_*}
      applied=$(sql "SELECT checksum FROM schema_migrations WHERE version = '$v'")
      if [[ -n "$applied" && "$applied" != "$(sha "$f")" ]]; then
        echo "CHECKSUM MISMATCH: $base (applied $applied, file $(sha "$f"))" >&2; bad=1
      fi
    done < <(migration_files)
    [[ $bad -eq 0 ]] && echo "checksums OK"
    exit $bad
    ;;

  --rollback)
    v="${2:?usage: migrate.sh --rollback NNNN}"
    latest=$(sql "SELECT max(version) FROM schema_migrations")
    [[ "$v" == "$latest" ]] || { echo "ERROR: $v is not the latest applied migration ($latest)" >&2; exit 2; }
    down="$RB_DIR/${v}_down.sql"
    [[ -f "$down" ]] || { echo "ERROR: $v is irreversible (no $down). Use a compensating migration or restore from backup." >&2; exit 2; }
    check_wrapped "$down"
    {
      echo "BEGIN;"
      echo "SELECT pg_advisory_xact_lock($LOCK_KEY);"
      grep -v -x -e 'BEGIN;' -e 'COMMIT;' "$down"
      echo "DELETE FROM schema_migrations WHERE version = '$v';"
      echo "COMMIT;"
    } | "${PSQL[@]}" >/dev/null
    echo "rolled back $v"
    ;;

  apply)
    applied_any=0
    while read -r f; do
      base=$(basename "$f" .sql); v=${base%%_*}; name=${base#*_}; sum=$(sha "$f")
      [[ "$v" > "$target" ]] && break
      existing=$(sql "SELECT checksum FROM schema_migrations WHERE version = '$v'")
      if [[ -n "$existing" ]]; then
        if [[ "$existing" != "$sum" ]]; then
          echo "ERROR: checksum mismatch for applied migration $base. Never edit an applied migration; add a new one." >&2
          exit 3
        fi
        continue
      fi
      check_wrapped "$f"
      role=$(role_clause)
      {
        echo "BEGIN;"
        echo "SELECT pg_advisory_xact_lock($LOCK_KEY);"
        echo "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '$v') AS jk_already \\gset"
        echo "\\if :jk_already"
        echo "\\echo '$base already applied by a concurrent runner — skipped'"
        echo "\\else"
        echo "SELECT clock_timestamp() AS jk_t0 \\gset"
        echo "$role"
        grep -v -x -e 'BEGIN;' -e 'COMMIT;' "$f"
        echo "INSERT INTO schema_migrations (version, name, checksum, execution_ms, applied_by)"
        echo "VALUES ('$v', '$name', '$sum', (extract(epoch FROM clock_timestamp() - :'jk_t0'::timestamptz) * 1000)::int, session_user);"
        echo "\\endif"
        echo "COMMIT;"
      } | "${PSQL[@]}" >/dev/null
      echo "applied $base"
      applied_any=1
    done < <(migration_files)

    if [[ $applied_any -eq 1 ]]; then
      has=$(sql "SELECT count(*) FROM pg_proc WHERE proname = 'jk_apply_grants'")
      if [[ "$has" != "0" ]]; then
        role=$(role_clause)
        printf 'BEGIN;\n%s\nSELECT jk_apply_grants();\nCOMMIT;\n' "$role" | "${PSQL[@]}" >/dev/null
        echo "grants re-applied"
      fi
    else
      echo "no pending migrations"
    fi
    ;;

  *) echo "unknown command: $cmd" >&2; exit 2 ;;
esac
