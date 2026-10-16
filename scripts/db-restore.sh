#!/usr/bin/env bash
#
# Restores a nightly backup (from R2, daily/zet-….dump) into an EMPTY
# database — a new Neon branch or database, never the live one in place.
#
#   OWNER_DATABASE_URL='postgresql://…/restored?sslmode=require' \
#     ./scripts/db-restore.sh ~/Downloads/zet-2026-10-01T0230Z.dump
#
# Then run scripts/db-deploy.sh against the same URL: the dump carries no
# roles or grants (--no-owner --no-privileges), and db-deploy.sh recreates
# zet_app and its grants and prints the DATABASE_URL to point the app at.
#
# Needs pg_restore at least as new as the dump's pg_dump (18):
#   brew install postgresql@18

set -euo pipefail
die() { printf '\n\033[31m%s\033[0m\n\n' "$*" >&2; exit 1; }

DUMP="${1:-}"
[ -f "$DUMP" ] || die "Usage: OWNER_DATABASE_URL=… $0 path/to/zet-….dump"
[ -n "${OWNER_DATABASE_URL:-}" ] || die "Set OWNER_DATABASE_URL to the EMPTY target database's owner connection string."

TABLES=$(psql "$OWNER_DATABASE_URL" -tA -c "select count(*) from pg_tables where schemaname = 'public'")
[ "$TABLES" = "0" ] || die "That database already has $TABLES tables. Restore into an empty one — never over the live database."

pg_restore --dbname "$OWNER_DATABASE_URL" --no-owner --no-privileges --exit-on-error "$DUMP"
echo
echo "Restored. Nights on file per restaurant:"
psql "$OWNER_DATABASE_URL" -c "select restaurant_id, count(*) as nights, max(business_date) as latest from zet_report group by 1 order by 1"
echo "Now run: OWNER_DATABASE_URL=… ./scripts/db-deploy.sh"
