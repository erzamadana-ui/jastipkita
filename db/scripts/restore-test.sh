#!/usr/bin/env bash
# Restore drill (launch checklist T5): pg_dump (custom format) of a source database → restore into a FRESH database →
# integrity checks → Markdown report with timings. Never touches the source except for reading (and the optional
# db_operations RESTORE_TEST row with --record-url).
#
#   SOURCE_URL=postgres://… TARGET_ADMIN_URL=postgres://…/postgres bash db/scripts/restore-test.sh [options]
#
# Options
#   --source URL         source database (or env SOURCE_URL). Use a DIRECT connection (not a transaction pooler):
#                        the counts and pg_dump share one exported snapshot, so they agree even on a live database.
#   --dump FILE          test an existing custom-format dump (e.g. the decrypted daily backup) instead of dumping;
#                        without --source the source-comparison checks are reported as N/A.
#   --target-admin URL   a database on the target server where CREATE DATABASE may run (or env TARGET_ADMIN_URL;
#                        default: the source URL with database "postgres").
#   --target-db NAME     name of the database to create (default jk_restore_test_<UTC timestamp>). Must not exist.
#   --jobs N             pg_restore parallel jobs (default 1).
#   --fingerprint-max-rows N   per-table content fingerprint (md5 of all rows, ordered, UTC) only for tables with at
#                        most N rows (default 200000); larger tables are compared by row count only.
#   --report FILE        also write the Markdown report to FILE.
#   --record-url URL     insert the outcome as db_operations type RESTORE_TEST into that database (Admin DB Center).
#   --environment ENV    DEVELOPMENT | STAGING | PRODUCTION for --record-url (default DEVELOPMENT).
#   --label TEXT         free text for the report / record (default "restore drill").
#   --keep               keep the restored database (default: dropped at the end).
#   --keep-dump          keep the dump file (default: deleted; it holds personal data in ciphertext and plaintext form).
#
# Checks (all must pass; exit code 1 otherwise)
#   restore      pg_restore --no-owner --no-privileges --exit-on-error succeeded
#   row_counts   every public table: same row count as the source snapshot (and same table set)
#   content      md5 fingerprint of every table ≤ --fingerprint-max-rows identical to the source snapshot
#   objects      tables, views, functions, triggers, indexes, constraints, extensions identical
#   sequences    every sequence restored at the same position
#   ledger       no journal/currency with debit ≠ credit; global debit = credit per currency
#   audit_chain  verify_audit_chain() IS NULL on the restored copy, head = source head, audit checkpoints still match
#   migrations   schema_migrations checksums = SHA-256 of db/migrations/*.sql in this checkout; same schema version
#
# Portable: bash 3.2 (macOS) and Linux; needs psql / pg_dump / pg_restore (client ≥ server major version).
set -euo pipefail

DB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_URL="${SOURCE_URL:-}"
TARGET_ADMIN_URL="${TARGET_ADMIN_URL:-}"
DUMP_IN=""; TARGET_DB=""; JOBS=1; FP_MAX=200000; REPORT=""; RECORD_URL=""; ENVIRONMENT="DEVELOPMENT"; LABEL="restore drill"
KEEP=0; KEEP_DUMP=0

usage() { sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-2}"; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) SOURCE_URL="$2"; shift 2 ;;
    --dump) DUMP_IN="$2"; shift 2 ;;
    --target-admin) TARGET_ADMIN_URL="$2"; shift 2 ;;
    --target-db) TARGET_DB="$2"; shift 2 ;;
    --jobs) JOBS="$2"; shift 2 ;;
    --fingerprint-max-rows) FP_MAX="$2"; shift 2 ;;
    --report) REPORT="$2"; shift 2 ;;
    --record-url) RECORD_URL="$2"; shift 2 ;;
    --environment) ENVIRONMENT="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --keep-dump) KEEP_DUMP=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
done

die() { echo "FATAL: $*" >&2; exit 2; }
[[ -n "$SOURCE_URL" || -n "$DUMP_IN" ]] || die "--source URL or --dump FILE required"
[[ -z "$DUMP_IN" || -f "$DUMP_IN" ]] || die "dump file not found: $DUMP_IN"
[[ "$JOBS" =~ ^[0-9]+$ && "$FP_MAX" =~ ^[0-9]+$ ]] || die "--jobs / --fingerprint-max-rows must be integers"
case "$ENVIRONMENT" in DEVELOPMENT|STAGING|PRODUCTION) ;; *) die "--environment must be DEVELOPMENT, STAGING or PRODUCTION" ;; esac
for bin in psql pg_dump pg_restore; do command -v "$bin" >/dev/null || die "$bin not found"; done

with_db() { # $1 = URL, $2 = database name → same URL pointing at that database (query string kept)
  printf '%s' "$1" | sed -E "s#^(postgres(ql)?://[^/]*)(/[^?]*)?#\\1/$2#"
}
mask() { # host only, first 2 chars + domain; never user/password/database
  local h; h=$(printf '%s' "$1" | sed -E 's#^postgres(ql)?://([^@/]*@)?([^/:?]*).*#\3#')
  case "$h" in localhost|127.0.0.1|'') printf '%s' "${h:-local socket}" ;; *) printf '%s***%s' "${h:0:2}" "$(printf '%s' "$h" | sed -E 's/^[^.]*//')" ;; esac
}
now() { if [[ -n "${EPOCHREALTIME:-}" ]]; then printf '%s\n' "${EPOCHREALTIME/,/.}"; else perl -MTime::HiRes=time -e 'printf("%.3f\n", time)'; fi; }
dur() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.2f", b - a }'; }
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
fsize() { wc -c <"$1" | tr -d ' '; }
wipe() { [[ -f "$1" ]] || return 0; if command -v shred >/dev/null; then shred -u "$1"; else rm -P "$1" 2>/dev/null || rm -f "$1"; fi; }

export PGTZ=UTC PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"
PSQL=(psql -X -q -At -v ON_ERROR_STOP=1 --no-psqlrc)
[[ -n "$TARGET_ADMIN_URL" ]] || { [[ -n "$SOURCE_URL" ]] || die "--target-admin URL required with --dump only"; TARGET_ADMIN_URL=$(with_db "$SOURCE_URL" postgres); }
TS=$(date -u +%Y%m%dT%H%M%SZ)
TARGET_DB="${TARGET_DB:-jk_restore_test_$(date -u +%Y%m%d_%H%M%S)}"
[[ "$TARGET_DB" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "--target-db must be a plain lower-case identifier"
TARGET_URL=$(with_db "$TARGET_ADMIN_URL" "$TARGET_DB")

WORK=$(mktemp -d "${TMPDIR:-/tmp}/jk-restore-test.XXXXXX"); chmod 700 "$WORK"
SNAP_PID=""
created_target=0
cleanup() {
  exec 3>&- 2>/dev/null || true
  [[ -n "$SNAP_PID" ]] && kill "$SNAP_PID" 2>/dev/null || true
  if [[ $KEEP -eq 0 && $created_target -eq 1 ]]; then
    "${PSQL[@]}" "$TARGET_ADMIN_URL" -c "DROP DATABASE IF EXISTS \"$TARGET_DB\" WITH (FORCE)" >/dev/null 2>&1 || true
  fi
  if [[ $KEEP_DUMP -eq 0 && -z "$DUMP_IN" ]]; then wipe "$WORK/source.dump"; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

log() { echo "[restore-test $(date -u +%H:%M:%S)] $*" >&2; }

# ------------------------------------------------------------------ SQL shared by source snapshot and target
# One row per public table: name|rows|fingerprint ("skipped" above the size cap). Run with \gexec.
GEN_COUNTS="SELECT format(\$f\$SELECT %L || '|' || n || '|' || CASE WHEN n <= $FP_MAX THEN (SELECT md5(coalesce(string_agg(t::text, chr(10) ORDER BY t::text COLLATE \"C\"), '')) FROM %I.%I t) ELSE 'skipped' END FROM (SELECT count(*) AS n FROM %I.%I) c\$f\$, tablename, schemaname, tablename, schemaname, tablename) FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
META_SQL="
SELECT 'objects.tables=' || count(*) FROM pg_tables WHERE schemaname = 'public';
SELECT 'objects.views=' || count(*) FROM pg_views WHERE schemaname = 'public';
SELECT 'objects.functions=' || count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public';
SELECT 'objects.triggers=' || count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal;
SELECT 'objects.indexes=' || count(*) FROM pg_indexes WHERE schemaname = 'public';
SELECT 'objects.constraints=' || count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public';
SELECT 'objects.extensions=' || coalesce(string_agg(extname || '@' || extversion, ',' ORDER BY extname), '') FROM pg_extension;
SELECT 'sequence.' || sequencename || '=' || coalesce(last_value::text, 'unset') FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename;
SELECT 'schema_version=' || coalesce(max(version), 'none') FROM schema_migrations;
SELECT 'audit_head=' || last_id || ':' || encode(last_hash, 'hex') FROM audit_chain_head WHERE singleton;
"

# ------------------------------------------------------------------ 1. source snapshot + dump
T0=$(now)
SRC_INFO="—"; DUMP="$WORK/source.dump"; T_DUMP="n/a"; SNAPSHOT=0
if [[ -n "$DUMP_IN" ]]; then
  DUMP="$DUMP_IN"
  log "using existing dump $(basename "$DUMP_IN")"
fi
if [[ -n "$SOURCE_URL" ]]; then
  SRC_INFO=$("${PSQL[@]}" "$SOURCE_URL" -c "SELECT current_setting('server_version') || ' · ' || pg_size_pretty(pg_database_size(current_database()))") \
    || die "cannot connect to the source"
  if [[ -z "$DUMP_IN" ]]; then
    log "source $(mask "$SOURCE_URL") (PostgreSQL $SRC_INFO): exporting a snapshot, counting rows, fingerprinting …"
    mkfifo "$WORK/snap.in"
    "${PSQL[@]}" "$SOURCE_URL" -f "$WORK/snap.in" >"$WORK/snap.out" 2>"$WORK/snap.err" &
    SNAP_PID=$!
    exec 3>"$WORK/snap.in"
    {
      echo "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;"
      echo "\\o $WORK/snapshot.id"
      echo "SELECT pg_export_snapshot();"
      echo "\\o $WORK/source.counts"
      echo "$GEN_COUNTS \\gexec"
      echo "\\o $WORK/source.meta"
      echo "$META_SQL"
      echo "\\o $WORK/source.ready"
      echo "SELECT 'ready';"
      echo "\\o"
    } >&3
    for _ in $(seq 1 36000); do  # ≤ 1 h for counting/fingerprinting
      [[ -s "$WORK/source.ready" ]] && break
      kill -0 "$SNAP_PID" 2>/dev/null || die "snapshot session failed: $(cat "$WORK/snap.err")"
      sleep 0.1
    done
    [[ -s "$WORK/source.ready" ]] || die "snapshot session did not finish counting"
    SNAPSHOT_ID=$(head -1 "$WORK/snapshot.id")
    T1=$(now)
    log "snapshot $SNAPSHOT_ID: $(wc -l <"$WORK/source.counts" | tr -d ' ') tables counted in $(dur "$T0" "$T1") s; pg_dump -Fc …"
    pg_dump -Fc --snapshot="$SNAPSHOT_ID" -f "$DUMP" "$SOURCE_URL" || die "pg_dump failed"
    T2=$(now)
    T_DUMP=$(dur "$T1" "$T2")
    echo "COMMIT;" >&3
    exec 3>&-
    wait "$SNAP_PID" || die "snapshot session failed at COMMIT: $(cat "$WORK/snap.err")"
    SNAP_PID=""
    SNAPSHOT=1
  fi
fi
DUMP_BYTES=$(fsize "$DUMP")
DUMP_SHA=$(sha256 "$DUMP")
TOC_ENTRIES=$(pg_restore --list "$DUMP" | grep -c -v '^;' || true)
TOC_DATA=$(pg_restore --list "$DUMP" | grep -c 'TABLE DATA' || true)
log "dump: $DUMP_BYTES bytes, sha256 ${DUMP_SHA:0:16}…, TOC $TOC_ENTRIES entries ($TOC_DATA TABLE DATA)"

# ------------------------------------------------------------------ 2. restore into a fresh database
exists=$("${PSQL[@]}" "$TARGET_ADMIN_URL" -c "SELECT 1 FROM pg_database WHERE datname = '$TARGET_DB'")
[[ -z "$exists" ]] || die "target database $TARGET_DB already exists — refusing to touch it"
"${PSQL[@]}" "$TARGET_ADMIN_URL" -c "CREATE DATABASE \"$TARGET_DB\"" || die "CREATE DATABASE failed"
created_target=1
TGT_INFO=$("${PSQL[@]}" "$TARGET_URL" -c "SELECT current_setting('server_version')")
log "restoring into $TARGET_DB on $(mask "$TARGET_ADMIN_URL") (PostgreSQL $TGT_INFO), jobs=$JOBS …"
T3=$(now)
RESTORE_OK=1
pg_restore --no-owner --no-privileges --exit-on-error --jobs="$JOBS" -d "$TARGET_URL" "$DUMP" 2>"$WORK/restore.err" || RESTORE_OK=0
T4=$(now)
T_RESTORE=$(dur "$T3" "$T4")
log "pg_restore $([[ $RESTORE_OK -eq 1 ]] && echo OK || echo FAILED) in $T_RESTORE s"

# ------------------------------------------------------------------ 3. integrity checks
CHECKS=()   # "name|PASS/FAIL/N/A|detail"
add() { local d="${3//|/:}"; CHECKS+=("$1|$2|$d"); }
q() { "${PSQL[@]}" "$TARGET_URL" -c "$1"; }

if [[ $RESTORE_OK -eq 1 ]]; then add restore PASS "pg_restore exit 0 (--no-owner --no-privileges --exit-on-error)"
else add restore FAIL "$(head -3 "$WORK/restore.err" | tr '\n' ' ' | cut -c1-300)"; fi

if [[ $RESTORE_OK -eq 1 ]]; then
  echo "$GEN_COUNTS \\gexec" | "${PSQL[@]}" "$TARGET_URL" >"$WORK/target.counts"
  echo "$META_SQL" | "${PSQL[@]}" "$TARGET_URL" >"$WORK/target.meta"
  TABLES=$(wc -l <"$WORK/target.counts" | tr -d ' ')
  ROWS=$(awk -F'|' '{ s += $2 } END { print s + 0 }' "$WORK/target.counts")
  FP_DONE=$(awk -F'|' '$3 != "skipped"' "$WORK/target.counts" | wc -l | tr -d ' ')

  if [[ $SNAPSHOT -eq 1 ]]; then
    cut -d'|' -f1,2 "$WORK/source.counts" | sort >"$WORK/s.rc"; cut -d'|' -f1,2 "$WORK/target.counts" | sort >"$WORK/t.rc"
    diff_rc=$(diff "$WORK/s.rc" "$WORK/t.rc" | grep -c '^[<>]' || true)
    if [[ "$diff_rc" == "0" ]]; then add row_counts PASS "$TABLES tables, $ROWS rows — identical to the source snapshot"
    else add row_counts FAIL "$(diff "$WORK/s.rc" "$WORK/t.rc" | grep '^[<>]' | head -6 | tr '\n' ' ')"; fi
    sort "$WORK/source.counts" >"$WORK/s.fp"; sort "$WORK/target.counts" >"$WORK/t.fp"
    diff_fp=$(diff "$WORK/s.fp" "$WORK/t.fp" | grep -c '^[<>]' || true)
    if [[ "$diff_fp" == "0" ]]; then add content PASS "$FP_DONE/$TABLES tables fingerprinted (md5 of all rows, ≤ $FP_MAX rows), all identical"
    else add content FAIL "differs: $(diff "$WORK/s.fp" "$WORK/t.fp" | grep '^>' | cut -d'|' -f1 | sed 's/^> //' | head -8 | tr '\n' ' ')"; fi
    grep '^objects\.' "$WORK/source.meta" | sort >"$WORK/s.obj"; grep '^objects\.' "$WORK/target.meta" | sort >"$WORK/t.obj"
    if diff -q "$WORK/s.obj" "$WORK/t.obj" >/dev/null; then add objects PASS "$(grep -v extensions "$WORK/t.obj" | sed 's/^objects\.//' | tr '\n' ' ')"
    else add objects FAIL "$(diff "$WORK/s.obj" "$WORK/t.obj" | grep '^[<>]' | head -6 | tr '\n' ' ')"; fi
    grep '^sequence\.' "$WORK/source.meta" | sort >"$WORK/s.seq"; grep '^sequence\.' "$WORK/target.meta" | sort >"$WORK/t.seq"
    if diff -q "$WORK/s.seq" "$WORK/t.seq" >/dev/null; then add sequences PASS "$(wc -l <"$WORK/t.seq" | tr -d ' ') sequences at the source position"
    else add sequences FAIL "$(diff "$WORK/s.seq" "$WORK/t.seq" | grep '^[<>]' | head -6 | tr '\n' ' ')"; fi
  else
    add row_counts N/A "no source snapshot (--dump without dumping): $TABLES tables, $ROWS rows restored"
    add content N/A "no source snapshot"
    add objects N/A "no source snapshot: $(grep '^objects\.' "$WORK/target.meta" | grep -v extensions | sed 's/^objects\.//' | tr '\n' ' ')"
    add sequences N/A "no source snapshot"
  fi

  unbalanced=$(q "SELECT count(*) FROM (SELECT journal_id, currency FROM ledger_entries GROUP BY 1, 2
                    HAVING sum(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END) <> 0) x")
  global=$(q "SELECT count(*) FROM (SELECT currency FROM ledger_entries GROUP BY 1
               HAVING sum(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END) <> 0) x")
  journals=$(q "SELECT count(*) || ' journals / ' || (SELECT count(*) FROM ledger_entries) || ' entries' FROM ledger_journals")
  if [[ "$unbalanced" == "0" && "$global" == "0" ]]; then add ledger PASS "$journals; 0 unbalanced journal/currency; debit = credit per currency"
  else add ledger FAIL "$unbalanced unbalanced journal/currency pairs, $global currencies with debit ≠ credit ($journals)"; fi

  chain=$(q "SELECT coalesce(verify_audit_chain()::text, 'OK')")
  head_t=$(grep '^audit_head=' "$WORK/target.meta" | cut -d= -f2)
  cps=$(q "SELECT CASE WHEN to_regclass('public.audit_checkpoints') IS NULL THEN 'n/a' ELSE (
             SELECT count(*) FILTER (WHERE a.hash IS DISTINCT FROM c.last_hash AND c.last_id > 0) || '/' || count(*)
               FROM audit_checkpoints c LEFT JOIN audit_logs a ON a.id = c.last_id) END")
  cp_bad=${cps%%/*}
  head_hash=${head_t#*:}
  audit_detail="verify_audit_chain()=$chain, head #${head_t%%:*} (${head_hash:0:16}…)"
  audit_ok=1
  [[ "$chain" == "OK" ]] || audit_ok=0
  [[ "$cps" == "n/a" || "$cp_bad" == "0" ]] || audit_ok=0
  if [[ $SNAPSHOT -eq 1 ]]; then
    head_s=$(grep '^audit_head=' "$WORK/source.meta" | cut -d= -f2)
    [[ "$head_s" == "$head_t" ]] || { audit_ok=0; audit_detail="$audit_detail; head differs from source (#${head_s%%:*})"; }
    audit_detail="$audit_detail; head = source"
  fi
  audit_detail="$audit_detail; checkpoints mismatched/total: $cps"
  if [[ $audit_ok -eq 1 ]]; then add audit_chain PASS "$audit_detail"; else add audit_chain FAIL "$audit_detail"; fi

  q "SELECT version || ' ' || checksum FROM schema_migrations ORDER BY version" >"$WORK/applied"
  mig_bad=""; mig_ok=0; mig_pending=""
  for f in "$DB_DIR"/migrations/[0-9][0-9][0-9][0-9]_*.sql; do
    v=$(basename "$f"); v=${v%%_*}
    applied=$(awk -v v="$v" '$1 == v { print $2 }' "$WORK/applied")
    if [[ -z "$applied" ]]; then mig_pending="$mig_pending $v"
    elif [[ "$applied" == "$(sha256 "$f")" ]]; then mig_ok=$((mig_ok + 1))
    else mig_bad="$mig_bad $v"; fi
  done
  unknown=""
  while read -r v _; do
    [[ -n "$v" ]] || continue
    ls "$DB_DIR"/migrations/"${v}"_*.sql >/dev/null 2>&1 || unknown="$unknown $v"
  done <"$WORK/applied"
  sv_t=$(grep '^schema_version=' "$WORK/target.meta" | cut -d= -f2)
  mig_detail="schema $sv_t; $mig_ok checksums match db/migrations"
  [[ -z "$mig_pending" ]] || mig_detail="$mig_detail; not applied in the backup (newer in this checkout):$mig_pending"
  mig_good=1
  [[ -z "$mig_bad" ]] || { mig_good=0; mig_detail="$mig_detail; CHECKSUM MISMATCH:$mig_bad"; }
  [[ -z "$unknown" ]] || { mig_good=0; mig_detail="$mig_detail; applied but not in this checkout:$unknown"; }
  if [[ $SNAPSHOT -eq 1 ]]; then
    sv_s=$(grep '^schema_version=' "$WORK/source.meta" | cut -d= -f2)
    [[ "$sv_s" == "$sv_t" ]] || { mig_good=0; mig_detail="$mig_detail; source schema $sv_s"; }
  fi
  if [[ $mig_good -eq 1 ]]; then add migrations PASS "$mig_detail"; else add migrations FAIL "$mig_detail"; fi
fi
T5=$(now)
T_CHECKS=$(dur "$T4" "$T5")
T_TOTAL=$(dur "$T0" "$T5")

# ------------------------------------------------------------------ 4. report
passed=0; failed=0
for c in "${CHECKS[@]}"; do case "$(echo "$c" | cut -d'|' -f2)" in PASS) passed=$((passed + 1)) ;; FAIL) failed=$((failed + 1)) ;; esac; done
RESULT=$([[ $failed -eq 0 && $RESTORE_OK -eq 1 ]] && echo PASS || echo FAIL)
{
  echo "## Restore drill — $TS"
  echo
  echo "| | |"
  echo "|---|---|"
  echo "| Label | $LABEL |"
  echo "| Source | $([[ -n "$SOURCE_URL" ]] && mask "$SOURCE_URL" || echo '—') · PostgreSQL $SRC_INFO |"
  echo "| Target | $(mask "$TARGET_ADMIN_URL") · database \`$TARGET_DB\` · PostgreSQL $TGT_INFO$([[ $KEEP -eq 1 ]] && echo ' (kept)' || echo ' (dropped after the drill)') |"
  echo "| Dump | custom format, $DUMP_BYTES bytes, sha256 \`$DUMP_SHA\`, TOC $TOC_ENTRIES entries ($TOC_DATA TABLE DATA)$([[ $SNAPSHOT -eq 1 ]] && echo ', same exported snapshot as the source counts') |"
  echo "| Result | **$RESULT** — $passed passed, $failed failed |"
  echo
  echo "| Phase | Seconds |"
  echo "|---|---:|"
  if [[ $SNAPSHOT -eq 1 ]]; then echo "| Source snapshot: row counts + fingerprints | $(dur "$T0" "$T1") |"; fi
  echo "| pg_dump -Fc | $T_DUMP |"
  echo "| pg_restore (jobs=$JOBS) | $T_RESTORE |"
  echo "| Integrity checks on the restored copy | $T_CHECKS |"
  echo "| **Total** | **$T_TOTAL** |"
  echo
  echo "| Check | Result | Detail |"
  echo "|---|---|---|"
  for c in "${CHECKS[@]}"; do
    IFS='|' read -r n r d <<<"$c"
    echo "| $n | $r | $d |"
  done
} >"$WORK/report.md"
cat "$WORK/report.md"
[[ -z "$REPORT" ]] || cp "$WORK/report.md" "$REPORT"

if [[ -n "$RECORD_URL" ]]; then
  status=$([[ "$RESULT" == PASS ]] && echo SUCCEEDED || echo FAILED)
  checks_json=$(for c in "${CHECKS[@]}"; do IFS='|' read -r n r _ <<<"$c"; printf '"%s":"%s",' "$n" "$r"; done | sed 's/,$//')
  "${PSQL[@]}" "$RECORD_URL" -v env="$ENVIRONMENT" -v status="$status" -v label="$LABEL" -v sha="$DUMP_SHA" -v bytes="$DUMP_BYTES" \
    -v tdb="$TARGET_DB" -v checks="{$checks_json}" -v restore_s="$T_RESTORE" -v total_s="$T_TOTAL" -v dump_s="$T_DUMP" >/dev/null <<'SQL' \
    && log "recorded as db_operations RESTORE_TEST ($status)" || log "WARNING: could not record in db_operations"
INSERT INTO db_operations (type, status, environment, provider, reason, params, result, started_at, finished_at)
VALUES ('RESTORE_TEST', :'status', :'env', 'LOCAL', 'db/scripts/restore-test.sh: ' || :'label',
        jsonb_build_object('dumpSha256', :'sha', 'dumpBytes', :'bytes'::bigint, 'targetDatabase', :'tdb'),
        jsonb_build_object('checks', :'checks'::jsonb, 'seconds', jsonb_build_object('dump', CASE WHEN :'dump_s' ~ '^[0-9.]+$' THEN to_jsonb(:'dump_s'::numeric) END, 'restore', :'restore_s'::numeric, 'total', :'total_s'::numeric)),
        now() - make_interval(secs => :'total_s'::numeric), now());
SQL
fi

echo "RESULT: $RESULT ($passed passed, $failed failed; restore ${T_RESTORE}s, total ${T_TOTAL}s)" >&2
[[ "$RESULT" == PASS ]]
