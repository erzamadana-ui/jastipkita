#!/usr/bin/env bash
# Database test harness.
#   bash db/scripts/test-db.sh            # uses database jk_schema_check on localhost as postgres
#   JK_TEST_DB=foo PGHOST=... PGUSER=... bash db/scripts/test-db.sh
#
# 1. drops & recreates a scratch database
# 2. applies migrations up to 0016, rollback round-trip of the reversible 0016/0015, re-apply
# 3. applies the remaining migrations + all db/seeds/*.sql in order
# 4. idempotency: re-applies every migration raw + seeds again; checksum verify; rollback refusals;
#    generator --check (committed seed up to date, and doc drift detected)
# 5. runs db/tests/*.sql (DO blocks; "PASS:" notices; any exception fails the file)
# 6. multi-session tests: deferred ledger check at real COMMIT, SKIP LOCKED with two live
#    sessions, audit chain linearity under concurrent writers
set -uo pipefail

DB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGHOST="${PGHOST:-localhost}" PGUSER="${PGUSER:-postgres}"
export PGDATABASE="${JK_TEST_DB:-jk_schema_check}"
unset DATABASE_URL
PSQL=(psql -X -q -v ON_ERROR_STOP=1 --no-psqlrc)

pass=0; fail=0
ok()   { echo "  PASS: $1"; pass=$((pass + 1)); }
bad()  { echo "  FAIL: $1"; fail=$((fail + 1)); }
step() { echo; echo "== $1"; }
die()  { echo "FATAL: $1" >&2; exit 1; }

step "fresh database $PGDATABASE"
"${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS \"$PGDATABASE\" WITH (FORCE)" -c "CREATE DATABASE \"$PGDATABASE\"" \
  || die "cannot (re)create $PGDATABASE"

step "migrations up to 0016 + rollback round-trip (reversible migrations 0016, 0015)"
bash "$DB_DIR/scripts/migrate.sh" --to 0016 || die "migrations up to 0016 failed"
if bash "$DB_DIR/scripts/migrate.sh" --rollback 0016 >/dev/null && bash "$DB_DIR/scripts/migrate.sh" --rollback 0015 >/dev/null; then
  views=$("${PSQL[@]}" -At -c "SELECT count(*) FROM pg_views WHERE schemaname='public' AND viewname IN ('v_gmv_daily','v_take_rate')")
  owner=$("${PSQL[@]}" -At -c "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tableowner='jk_migrator'")
  [[ "$views" == "0" && "$owner" == "0" ]] && ok "0016/0015 down scripts remove grants/ownership and metric views" || bad "rollback left objects (views=$views, owned=$owner)"
  reapply=$(bash "$DB_DIR/scripts/migrate.sh" --to 0016 2>&1)
  grep -q "applied 0016_roles_grants" <<<"$reapply" && ok "re-apply after rollback" || bad "re-apply after rollback: $reapply"
else
  bad "rollback scripts failed"
fi

step "remaining migrations"
bash "$DB_DIR/scripts/migrate.sh" || die "migrations failed"
step "seeds"
bash "$DB_DIR/scripts/seed.sh" || die "seeds failed"

step "idempotency & drift checks"
raw_ok=1; errf=$(mktemp)
for f in "$DB_DIR"/migrations/[0-9][0-9][0-9][0-9]_*.sql; do
  PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -f "$f" >/dev/null 2>"$errf" \
    || { raw_ok=0; echo "    re-apply failed: $(basename "$f")"; cat "$errf"; }
done
rm -f "$errf"
[[ $raw_ok -eq 1 ]] && ok "every migration re-applies cleanly (idempotent)" || bad "migration re-apply"
bash "$DB_DIR/scripts/seed.sh" >/dev/null && ok "seeds re-apply cleanly (idempotent)" || bad "seed re-apply"
bash "$DB_DIR/scripts/migrate.sh" --verify >/dev/null && ok "schema_migrations checksums match files" || bad "checksum verify"
[[ "$(bash "$DB_DIR/scripts/migrate.sh")" == "no pending migrations" ]] && ok "runner reports no pending migrations" || bad "runner pending state"
bash "$DB_DIR/scripts/migrate.sh" --rollback 0010 >/dev/null 2>&1 && bad "rollback of a non-latest migration allowed" \
  || ok "rollback refuses a non-latest migration"
latest=$("${PSQL[@]}" -At -c "SELECT max(version) FROM schema_migrations")
if [[ ! -f "$DB_DIR/rollback/${latest}_down.sql" ]]; then
  bash "$DB_DIR/scripts/migrate.sh" --rollback "$latest" >/dev/null 2>&1 && bad "rollback of irreversible $latest allowed" \
    || ok "rollback refuses irreversible latest migration $latest (no down script)"
fi
if command -v node >/dev/null; then
  node "$DB_DIR/scripts/gen-reference-seed.mjs" --check >/dev/null && ok "0001_reference.sql matches generator output" || bad "reference seed is stale"
  # drift detection: a changed §15 table in a copy of the doc must make --check fail
  tmp=$(mktemp -d); root="$DB_DIR/.."
  mkdir -p "$tmp/db/scripts" "$tmp/db/seeds" "$tmp/docs" "$tmp/packages/core/src"
  cp "$DB_DIR/scripts/gen-reference-seed.mjs" "$tmp/db/scripts/"; cp "$DB_DIR/seeds/0001_reference.sql" "$tmp/db/seeds/"
  cp -r "$root/packages/core/src/config" "$tmp/packages/core/src/"
  sed 's/^| ON_HOLD | CANCELLED | ADMIN |/| ON_HOLD | CANCELLED | ADMIN, SYSTEM |/' "$root/docs/00-domain-model.md" > "$tmp/docs/00-domain-model.md"
  if cmp -s "$root/docs/00-domain-model.md" "$tmp/docs/00-domain-model.md"; then
    bad "drift fixture did not modify the doc (payout table changed?)"
  else
    node "$tmp/db/scripts/gen-reference-seed.mjs" --check >/dev/null 2>&1 && bad "generator --check missed a doc change" \
      || ok "generator --check fails when a §15 table changes (drift detection)"
  fi
  rm -rf "$tmp"
fi

step "SQL tests"
for f in "$DB_DIR"/tests/*.sql; do
  name=$(basename "$f")
  out=$("${PSQL[@]}" -f "$f" 2>&1); rc=$?
  n=$(grep -c 'PASS: ' <<<"$out" || true)
  grep -o 'PASS: .*' <<<"$out" | sed 's/^/  /'
  if [[ $rc -ne 0 ]]; then
    bad "$name (psql exit $rc)"; grep -E 'ERROR|FAIL' <<<"$out" | head -5 | sed 's/^/    /'
  fi
  pass=$((pass + n))
done

step "multi-session tests"
# (a) unbalanced journal rejected at a real COMMIT; balanced journal commits
out=$("${PSQL[@]}" 2>&1 <<'SQL'
BEGIN;
WITH j AS (INSERT INTO ledger_journals (kind, description) VALUES ('TEST','unbalanced @commit') RETURNING id)
INSERT INTO ledger_entries (journal_id, account_id, currency, direction, amount)
SELECT j.id, a.id, 'IDR', CASE a.bucket WHEN 'CLEARING' THEN 'DEBIT' ELSE 'CREDIT' END,
       CASE a.bucket WHEN 'CLEARING' THEN 1000 ELSE 999 END
  FROM j, ledger_accounts a WHERE a.code IN ('SYS:CLEARING:IDR','SYS:PROVIDER_CASH:IDR');
COMMIT;
SQL
)
grep -q 'not balanced' <<<"$out" && ok "unbalanced journal rejected at COMMIT (JKL02)" || bad "unbalanced journal committed: $out"
n=$("${PSQL[@]}" -At -c "SELECT count(*) FROM ledger_journals WHERE description = 'unbalanced @commit'")
[[ "$n" == "0" ]] && ok "rejected journal left no rows" || bad "rejected journal persisted"
"${PSQL[@]}" -c "SELECT post_journal('TEST','balanced @commit','[{\"bucket\":\"CLEARING\",\"direction\":\"DEBIT\",\"amount\":1000},{\"bucket\":\"PROVIDER_CASH\",\"direction\":\"CREDIT\",\"amount\":1000}]')" >/dev/null 2>&1 \
  && ok "balanced journal commits" || bad "balanced journal failed to commit"

# (b) SKIP LOCKED with two live sessions
"${PSQL[@]}" -c "INSERT INTO jobs (queue, name) SELECT 'concurrency', 'c' || i FROM generate_series(1,4) i" >/dev/null
( "${PSQL[@]}" -c "BEGIN" -c "SELECT count(*) FROM claim_jobs('concurrency','worker-A',2)" -c "SELECT pg_sleep(3)" -c "COMMIT" >/dev/null 2>&1 ) &
bg=$!
sleep 1
start=$(date +%s%N)
got_b=$("${PSQL[@]}" -At -c "SET lock_timeout = '1s'" -c "SELECT count(*) FROM claim_jobs('concurrency','worker-B',10)" 2>&1 | tail -1)
elapsed_ms=$(( ($(date +%s%N) - start) / 1000000 ))
wait $bg
dist=$("${PSQL[@]}" -At -c "SELECT string_agg(locked_by || '=' || n, ',' ORDER BY locked_by) FROM (SELECT locked_by, count(*) n FROM jobs WHERE queue='concurrency' GROUP BY 1) s")
[[ "$got_b" == "2" && "$dist" == "worker-A=2,worker-B=2" ]] \
  && ok "SKIP LOCKED: worker B skipped A's 2 locked rows without blocking (${elapsed_ms} ms) → $dist" \
  || bad "SKIP LOCKED: B got '$got_b', distribution '$dist'"

# (c) audit chain stays linear with concurrent writers
( "${PSQL[@]}" -c "BEGIN" -c "SELECT jk_audit('SYSTEM', NULL, 'test.concurrent_a', 'x', 'a', NULL, NULL)" -c "SELECT pg_sleep(2)" -c "COMMIT" >/dev/null 2>&1 ) &
bg=$!
sleep 0.5
"${PSQL[@]}" -c "SELECT jk_audit('SYSTEM', NULL, 'test.concurrent_b', 'x', 'b', NULL, NULL)" >/dev/null 2>&1
wait $bg
chk=$("${PSQL[@]}" -At -c "SELECT coalesce(verify_audit_chain()::text, 'OK') || ':' || (SELECT string_agg(action, '>' ORDER BY id) FROM audit_logs WHERE action LIKE 'test.concurrent_%')")
[[ "$chk" == "OK:test.concurrent_a>test.concurrent_b" ]] \
  && ok "audit chain linear under concurrency (B waited for A's head lock) → $chk" || bad "audit concurrency: $chk"

step "result"
echo "  $pass passed, $fail failed"
[[ $fail -eq 0 ]] || exit 1
