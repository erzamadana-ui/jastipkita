#!/usr/bin/env bash
# Repository secret guard (complements gitleaks). Scans TRACKED files only and fails on:
#   * files that must never be committed (.env, keystores, private keys, Firebase configs, dumps, …)
#   * content that looks like a real credential (private keys, live/test provider keys, cloud DB URLs with password)
# Run locally:  bash scripts/ci/secret-grep.sh
# Exit 0 = clean, 1 = findings (printed with file:line, the matched value is NOT printed).
set -uo pipefail

cd "$(git rev-parse --show-toplevel)" || exit 2
fail=0
report() { # level file line rule
  local level="$1" file="$2" line="$3" rule="$4"
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    echo "::${level} file=${file},line=${line},title=secret-guard::${rule}"
  else
    echo "${level^^}: ${file}:${line}: ${rule}"
  fi
}

# ---------------------------------------------------------------- forbidden file names
# Allowed exceptions: *.env.example, .env.example, *.pem.example, dart_defines.example.json
forbidden_names='(^|/)\.env$|(^|/)\.env\.[^/]+$|(^|/)[^/]+\.env$|(^|/)\.dev\.vars$|\.(jks|keystore|p12|pfx|p8|pem|key|mobileprovision|age|dump|backup)$|(^|/)google-services\.json$|(^|/)GoogleService-Info\.plist$|(^|/)key\.properties$|(^|/)id_(rsa|ed25519|ecdsa)$|(^|/)service-account[^/]*\.json$|(^|/)dart_defines\.json$'
allowed_names='\.env\.example$|\.pem\.example$|\.key\.example$'
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  if grep -qE "$forbidden_names" <<<"$f" && ! grep -qE "$allowed_names" <<<"$f"; then
    report error "$f" 1 "file type must never be committed (secret/credential/backup). Remove it from git and rotate anything it contained."
    fail=1
  fi
done < <(git ls-files)

# ---------------------------------------------------------------- content patterns
# rule-name|extended-regex   (the regex must not match placeholders used in docs/tests, e.g. <password>)
rules=(
  'private key block|-----BEGIN ([A-Z]+ )?PRIVATE KEY( BLOCK)?-----'
  'Xendit API key|xnd_(production|development)_[A-Za-z0-9]{20,}'
  'Xendit public key|xnd_public_(production|development)_[A-Za-z0-9]{20,}'
  'Stripe-style live key|(sk|rk)_live_[A-Za-z0-9]{16,}'
  'AWS access key id|(^|[^A-Z0-9])(AKIA|ASIA)[0-9A-Z]{16}([^A-Z0-9]|$)'
  'age secret key|AGE-SECRET-KEY-1[0-9A-Z]{58}'
  'GitHub token|(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,}'
  'Slack token|xox[abposr]-[A-Za-z0-9-]{10,}'
  'Cloud Postgres URL with password|postgres(ql)?://[^:/@[:space:]]+:[^@[:space:]<>]{6,}@[^[:space:]/]*(neon\.tech|supabase\.co|supabase\.com|rds\.amazonaws\.com|cloudsql|render\.com|aivencloud\.com)'
  'Twilio auth/API key|(^|[^A-Za-z0-9])SK[0-9a-f]{32}([^A-Za-z0-9]|$)'
  'Google service account|"type"[[:space:]]*:[[:space:]]*"service_account"'
)
# Files that legitimately contain the patterns themselves.
exclude='^(scripts/ci/secret-grep\.sh|pnpm-lock\.yaml|docs/checklists/security-checklist\.md|docs/09-security\.md)$'

mapfile -d '' files < <(git ls-files -z)
for entry in "${rules[@]}"; do
  name="${entry%%|*}"; rx="${entry#*|}"
  while IFS= read -r hit; do
    [[ -z "$hit" ]] && continue
    file="${hit%%:*}"; rest="${hit#*:}"; line="${rest%%:*}"
    grep -qE "$exclude" <<<"$file" && continue
    report error "$file" "$line" "$name"
    fail=1
  done < <(printf '%s\0' "${files[@]}" | xargs -0 -r grep -IHnoE -e "$rx" 2>/dev/null | cut -d: -f1,2)
done

# ---------------------------------------------------------------- warnings (do not fail)
while IFS= read -r hit; do
  [[ -z "$hit" ]] && continue
  file="${hit%%:*}"; rest="${hit#*:}"; line="${rest%%:*}"
  report warning "$file" "$line" "Google API key (AIza…) — fine for restricted Firebase client keys, never for server keys"
done < <(printf '%s\0' "${files[@]}" | xargs -0 -r grep -IHnoE 'AIza[0-9A-Za-z_-]{35}' 2>/dev/null | cut -d: -f1,2)

if [[ $fail -eq 0 ]]; then echo "secret-guard: no findings in $(git ls-files | wc -l) tracked files"; fi
exit $fail
