#!/usr/bin/env bash
# Deploy the built JastipKita site into a local clone of the antarkita-landing GitHub Pages repo
# (erzamadana-ui/antarkita-landing → https://antarkitaindonesia.com/).
#
#   usage: scripts/deploy-to-landing.sh <path-to-antarkita-landing-clone> [--robots] [--no-build] [--dry-run]
#
# What it touches (and NOTHING else in the landing repo):
#   <landing>/jastipkita/                     ← mirror of apps/web/dist (rsync --delete, scoped to this folder)
#   <landing>/.well-known/assetlinks.json     ← from apps/web/well-known/ (other .well-known files untouched)
#   <landing>/.well-known/apple-app-site-association
#   <landing>/.nojekyll                       ← created only if missing (needed so Pages serves .well-known/);
#                                               refused if the repo uses Jekyll (_config.yml) unless --force-nojekyll
#   <landing>/robots.txt                      ← only with --robots: inserts/replaces the "# BEGIN/END JastipKita" block
# It never commits or pushes; review `git status` in the landing repo, then commit & push yourself.
set -euo pipefail

usage() { sed -n '2,15p' "$0"; exit 1; }
[[ $# -ge 1 ]] || usage
LANDING="$1"; shift || true
ROBOTS=0; BUILD=1; DRY=0; FORCE_NOJEKYLL=0
for a in "$@"; do
  case "$a" in
    --robots) ROBOTS=1 ;;
    --no-build) BUILD=0 ;;
    --dry-run) DRY=1 ;;
    --force-nojekyll) FORCE_NOJEKYLL=1 ;;
    *) echo "unknown option: $a"; usage ;;
  esac
done

WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -d "$LANDING" ]] || { echo "✗ landing repo not found: $LANDING"; exit 1; }
LANDING="$(cd "$LANDING" && pwd)"
[[ -d "$LANDING/.git" ]] || { echo "✗ $LANDING is not a git clone (no .git)"; exit 1; }
[[ "$LANDING" != "$WEB_DIR"* ]] || { echo "✗ refusing to deploy into the web app itself"; exit 1; }

if [[ $BUILD -eq 1 ]]; then
  echo "→ building apps/web"
  (cd "$WEB_DIR" && pnpm run build)
fi
DIST="$WEB_DIR/dist"
[[ -f "$DIST/index.html" && -f "$DIST/404.html" ]] || { echo "✗ $DIST is missing — run pnpm --filter @jastipkita/web build"; exit 1; }
grep -q '/jastipkita/' "$DIST/index.html" || { echo "✗ dist was not built with base /jastipkita"; exit 1; }

echo "→ syncing dist/ → $LANDING/jastipkita/"
TARGET="$LANDING/jastipkita"
if command -v rsync >/dev/null; then
  RSYNC_FLAGS=(-a --delete --checksum --exclude '.DS_Store')
  [[ $DRY -eq 1 ]] && RSYNC_FLAGS+=(--dry-run --itemize-changes)
  mkdir -p "$TARGET"
  rsync "${RSYNC_FLAGS[@]}" "$DIST/" "$TARGET/"
elif [[ $DRY -eq 1 ]]; then
  echo "  (dry run, no rsync) would replace $TARGET with a copy of $DIST"
else
  # Fallback without rsync: replace ONLY the jastipkita/ folder.
  case "$TARGET" in */jastipkita) ;; *) echo "✗ unexpected target $TARGET"; exit 1 ;; esac
  rm -rf "$TARGET"
  mkdir -p "$TARGET"
  cp -R "$DIST/." "$TARGET/"
fi

echo "→ copying .well-known files (existing unrelated files are kept)"
if [[ $DRY -eq 0 ]]; then
  mkdir -p "$LANDING/.well-known"
  cp "$WEB_DIR/well-known/assetlinks.json" "$LANDING/.well-known/assetlinks.json"
  cp "$WEB_DIR/well-known/apple-app-site-association" "$LANDING/.well-known/apple-app-site-association"
fi
if grep -q 'REPLACE_WITH_PLAY_APP_SIGNING_SHA256' "$WEB_DIR/well-known/assetlinks.json"; then
  echo "  ! assetlinks.json still has the placeholder SHA-256 — Android App Links will not verify yet"
fi
if grep -q 'TEAMID\.' "$WEB_DIR/well-known/apple-app-site-association"; then
  echo "  ! apple-app-site-association still has the TEAMID placeholder — Universal Links will not verify yet"
fi

if [[ ! -f "$LANDING/.nojekyll" ]]; then
  if [[ -f "$LANDING/_config.yml" && $FORCE_NOJEKYLL -eq 0 ]]; then
    echo "  ! $LANDING uses Jekyll (_config.yml). .nojekyll NOT written — without it GitHub Pages will not serve"
    echo "    /.well-known/. Re-run with --force-nojekyll after checking the landing site does not need Jekyll."
  else
    echo "→ writing .nojekyll (lets GitHub Pages serve dot-folders like .well-known/)"
    [[ $DRY -eq 0 ]] && : > "$LANDING/.nojekyll"
  fi
fi

if [[ $ROBOTS -eq 1 ]]; then
  echo "→ merging JastipKita block into $LANDING/robots.txt"
  BLOCK="$(cat "$DIST/robots.txt")"
  if [[ $DRY -eq 0 ]]; then
    touch "$LANDING/robots.txt"
    python3 - "$LANDING/robots.txt" "$BLOCK" <<'PY'
import re, sys
path, block = sys.argv[1], sys.argv[2].strip() + "\n"
text = open(path, encoding="utf-8").read()
pat = re.compile(r"# BEGIN JastipKita.*?# END JastipKita\n?", re.S)
text = pat.sub(block, text) if pat.search(text) else (text.rstrip("\n") + ("\n\n" if text.strip() else "") + block)
open(path, "w", encoding="utf-8").write(text)
PY
  fi
else
  echo "  (robots.txt untouched — pass --robots to merge the JastipKita block into the root robots.txt)"
fi

echo "✓ done. Next: cd \"$LANDING\" && git status && git add jastipkita .well-known .nojekyll robots.txt && git commit && git push"
echo "  Root 404 deep-link forwarding: paste apps/web/well-known/landing-404-snippet.html into $LANDING/404.html (manual, once)."
