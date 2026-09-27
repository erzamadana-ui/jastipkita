#!/usr/bin/env bash
# Applies every db/seeds/*.sql in lexical order (0001_reference, 0100_customs_rules,
# 0101_restricted_items, ...). Seeds must be idempotent; each file manages its own
# transaction. Runs as jk_migrator when available (seeds write migrator-only tables
# such as the *_transitions state machines).
set -euo pipefail

DB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PSQL=(psql -X -q -v ON_ERROR_STOP=1 --no-psqlrc)
if [[ -n "${DATABASE_URL:-}" ]]; then PSQL+=("$DATABASE_URL"); fi

ok=$("${PSQL[@]}" -At -c "SELECT (to_regclass('schema_migrations') IS NOT NULL
       AND EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0016')
       AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jk_migrator')
       AND (current_user = 'jk_migrator' OR pg_has_role(current_user, 'jk_migrator', 'MEMBER')))::int")
if [[ "$ok" == "1" ]]; then export PGOPTIONS="${PGOPTIONS:-} -c role=jk_migrator"; fi

shopt -s nullglob
files=("$DB_DIR"/seeds/*.sql)
if [[ ${#files[@]} -eq 0 ]]; then echo "no seed files"; exit 0; fi
for f in "${files[@]}"; do
  "${PSQL[@]}" -f "$f" >/dev/null
  echo "seeded $(basename "$f")"
done
