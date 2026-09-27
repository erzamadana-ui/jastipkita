#!/usr/bin/env bash
# Post-deploy smoke test for the API.
#
#   bash scripts/ci/smoke-health.sh <api-base-url> <expected-env> <allowed-payment-modes> [expected-schema-version]
#   e.g. bash scripts/ci/smoke-health.sh https://jastipkita-api-staging.x.workers.dev staging "SANDBOX|MOCK" 0050
#
# Checks GET /health (liveness, no DB) and GET /v1/health: status ok, database ok, env, schema version = latest
# migration in the repo, and the payment integration mode (staging must be SANDBOX or MOCK, never LIVE).
# Retries for ~90 s (first request after a deploy may hit a cold Neon compute).
set -uo pipefail

base="${1:?api base url}"; want_env="${2:?expected env}"; modes="${3:?allowed payment modes, e.g. SANDBOX|MOCK}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
want_schema="${4:-$(find "$root/db/migrations" -maxdepth 1 -name '[0-9][0-9][0-9][0-9]_*.sql' -printf '%f\n' | sort | tail -1 | cut -c1-4)}"
base="${base%/}"
body=""; code=""; tmp=$(mktemp)
for attempt in $(seq 1 10); do
  code=$(curl -sS -o "$tmp" -w '%{http_code}' --max-time 20 -H 'X-Request-Id: ci-smoke' "$base/v1/health" 2>/dev/null || echo 000)
  body=$(cat "$tmp" 2>/dev/null || true)
  if [[ "$code" == "200" ]] && jq -e '.status == "ok"' >/dev/null 2>&1 <<<"$body"; then break; fi
  echo "attempt $attempt: HTTP $code — retrying in 9 s"; sleep 9
done
rm -f "$tmp"
echo "GET $base/v1/health → HTTP $code"
echo "$body" | jq '{status, version, env, database, integrations}' 2>/dev/null || echo "$body"

fail=0
check() { if eval "$2"; then echo "  PASS: $1"; else echo "  FAIL: $1"; [[ -n "${GITHUB_ACTIONS:-}" ]] && echo "::error title=smoke::$1"; fail=1; fi; }
live=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$base/health" || echo 000)
check "GET /health returns 200 (got $live)" '[[ "$live" == "200" ]]'
check "GET /v1/health returns 200" '[[ "$code" == "200" ]]'
check "status is ok" 'jq -e ".status == \"ok\"" >/dev/null <<<"$body"'
check "database.ok is true" 'jq -e ".database.ok == true" >/dev/null <<<"$body"'
check "env is $want_env" 'jq -e --arg e "$want_env" ".env == \$e" >/dev/null <<<"$body"'
check "schemaVersion is $want_schema (latest migration in repo)" 'jq -e --arg v "$want_schema" ".database.schemaVersion == \$v" >/dev/null <<<"$body"'
pm=$(jq -r '.integrations.payments // "missing"' <<<"$body" 2>/dev/null)
check "payments integration '$pm' is one of $modes" '[[ "$pm" =~ ^($modes)$ ]]'
# unknown routes must not leak stack traces and must use the error envelope
# shellcheck disable=SC2034 # used inside the eval of check()
nf=$(curl -sS --max-time 15 "$base/v1/__smoke_not_found" 2>/dev/null || true)
check "404 uses the error envelope" 'jq -e ".error.code == \"NOT_FOUND\"" >/dev/null <<<"$nf"'
exit $fail
