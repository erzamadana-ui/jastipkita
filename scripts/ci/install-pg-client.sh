#!/usr/bin/env bash
# Installs the PostgreSQL client tools of a given major version on an Ubuntu GitHub runner (PGDG apt repo) and puts
# them first on PATH. pg_dump must be >= the server major version (Neon defaults to PostgreSQL 17).
#
#   bash scripts/ci/install-pg-client.sh 17
set -euo pipefail
major="${1:-17}"
if command -v "/usr/lib/postgresql/$major/bin/psql" >/dev/null 2>&1; then
  echo "postgresql-client-$major already installed"
else
  sudo apt-get update -qq
  sudo apt-get install -y -qq postgresql-common >/dev/null
  sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y >/dev/null
  sudo apt-get install -y -qq "postgresql-client-$major" >/dev/null
fi
echo "/usr/lib/postgresql/$major/bin" >> "${GITHUB_PATH:-/dev/null}"
"/usr/lib/postgresql/$major/bin/psql" --version
"/usr/lib/postgresql/$major/bin/pg_dump" --version
