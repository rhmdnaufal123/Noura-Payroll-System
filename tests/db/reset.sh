#!/usr/bin/env bash
# Buat ulang database uji: shim Supabase + seluruh migrasi + seed.
# Pemakaian: PGDATABASE=noura_test tests/db/reset.sh   (butuh akses superuser lewat psql)
set -euo pipefail
DB="${PGDATABASE:-noura_test}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PSQL="psql -v ON_ERROR_STOP=1 -q"
$PSQL -d postgres -c "drop database if exists \"$DB\" with (force);" -c "create database \"$DB\";"
$PSQL -d "$DB" -f "$ROOT/tests/db/supabase_shim.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  $PSQL -d "$DB" -f "$f"
done
$PSQL -d "$DB" -f "$ROOT/supabase/seed.sql"
echo "Database $DB siap."
