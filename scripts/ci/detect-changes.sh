#!/usr/bin/env bash
# Decides which CI jobs must run (saves GitHub Actions minutes — private repos on GitHub Free have a monthly quota).
# Writes key=true|false lines to $GITHUB_OUTPUT (or stdout).
#
#   BASE_SHA=<sha> HEAD_SHA=<sha> EVENT=<push|pull_request|main-push|…> bash scripts/ci/detect-changes.sh
#
#   push / pull_request → only jobs whose inputs changed
#   main-push           → every deployable part (core, db, api, web, admin) always; mobile only when it changed
#                         (mobile is not deployed by deploy-staging.yml and is the most expensive job)
#   anything else, no base commit, failed diff, shared build inputs changed → everything
set -uo pipefail

out="${GITHUB_OUTPUT:-/dev/stdout}"
keys=(core db api web admin mobile)
all() { for k in "${keys[@]}"; do echo "$k=true" >>"$out"; done; echo "reason=$1" >>"$out"; echo "running all jobs: $1" >&2; exit 0; }

mode="diff"
case "${EVENT:-push}" in
  push|pull_request) ;;
  main-push) mode="main" ;;
  *) all "event ${EVENT:-unknown}" ;;
esac
base="${BASE_SHA:-}"; head="${HEAD_SHA:-HEAD}"
[[ -z "$base" || "$base" =~ ^0+$ ]] && all "no base commit"
git cat-file -e "$base^{commit}" 2>/dev/null || all "base $base not available"
files=$(git diff --name-only "$base" "$head" 2>/dev/null) || all "git diff failed"
[[ -z "$files" ]] && all "empty diff"

match() { grep -qE "$1" <<<"$files"; }
# Shared inputs: every job depends on them.
if match '^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.base\.json|\.github/workflows/ci\.yml|scripts/ci/)'; then
  all "shared build input changed"
fi

flag() { # key regex
  local v=false
  if [[ "$mode" == main && "$1" != mobile ]]; then v=true; elif match "$2"; then v=true; fi
  echo "$1=$v" >>"$out"; echo "$1: $v" >&2
}
flag core   '^packages/(core|design-tokens)/'
flag db     '^(db/|packages/core/src/config/|docs/00-domain-model\.md)'
flag api    '^(apps/api/|packages/core/|db/|docs/api/openapi\.json|docs/00-domain-model\.md|infra/cloudflare/|infra/docker/)'
flag web    '^(apps/web/|packages/)'
flag admin  '^(apps/admin/|packages/)'
flag mobile '^(apps/mobile/|packages/design-tokens/|brand/)'
echo "reason=$mode" >>"$out"
