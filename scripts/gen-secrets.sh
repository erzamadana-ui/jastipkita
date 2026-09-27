#!/usr/bin/env bash
# Prints freshly generated application secrets for ONE environment, to paste into the secret store
# (GitHub Environment secrets → pushed to Cloudflare Worker secrets by CI). NOTHING is written to disk.
#
#   bash scripts/gen-secrets.sh staging
#   bash scripts/gen-secrets.sh production --db-passwords   # also passwords for the Neon LOGIN roles
#
# Rules (read before pasting):
#   * Generate separately per environment. Never reuse staging values in production.
#   * HMAC_PEPPER must NEVER change once real data exists: phone/e-mail/ID/bank-account lookups are HMACs with it.
#   * DATA_ENCRYPTION_KEYS rotation = PREPEND a new "kid:key" and keep the old ones (decrypt-only); never drop an
#     old key while rows encrypted with it exist.
#   * Rotating JWT_SECRET signs everybody out (access tokens become invalid; refresh tokens are opaque and survive).
#   * Clear your terminal / scrollback after copying. Do not paste these into chat, e-mail, tickets or notes.
set -euo pipefail

env_name="${1:-}"
case "$env_name" in staging|production|development) ;; *)
  echo "usage: bash scripts/gen-secrets.sh <development|staging|production> [--db-passwords]" >&2; exit 2 ;; esac
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 2; }

prefix=$(printf '%s' "$env_name" | cut -c1-3)
kid="${prefix}$(date -u +%Y%m)"

echo "# ---- JastipKita secrets for: $env_name   (generated $(date -u +%Y-%m-%dT%H:%MZ), not stored anywhere)"
echo "JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')"
echo "DATA_ENCRYPTION_KEYS=${kid}:$(openssl rand -base64 32 | tr -d '\n')"
echo "HMAC_PEPPER=$(openssl rand -base64 48 | tr -d '\n')"
if [[ "${2:-}" == "--db-passwords" ]]; then
  # Neon requires ≥ 60 bits of entropy for passwords of roles created with SQL; these are 192 bits, URL-safe.
  echo "# Neon LOGIN role passwords (use in CREATE ROLE … PASSWORD '…' and in the connection strings)"
  echo "DB_PASSWORD_jk_migrate_${env_name}=$(openssl rand -hex 24)"
  echo "DB_PASSWORD_jk_api_${env_name}=$(openssl rand -hex 24)"
  echo "DB_PASSWORD_jk_backup_${env_name}=$(openssl rand -hex 24)"
fi
echo "# ---- end. Paste each value as a separate GitHub secret in Environment \"$env_name\" (docs/07-deployment.md §5)."
