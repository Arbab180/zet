#!/usr/bin/env bash
#
# Sets up (or updates) a HOSTED database — Neon, or any Postgres where you
# are given an owner login rather than a superuser.
#
#   OWNER_DATABASE_URL='postgresql://neondb_owner:…@…/neondb?sslmode=require' \
#     ./scripts/db-deploy.sh
#
# Safe to re-run after every new migration: already-applied migrations are
# skipped, the role's grants are re-applied, the seed is idempotent.
#
# What it does, in the same order as db-setup.sh does locally:
#   1. migrations, in filename order, as the OWNER (so the owner owns the
#      tables and the SECURITY DEFINER functions)
#   2. the LOGIN role `zet_app`: not the owner, NOBYPASSRLS, and only the
#      grants in db/app-role.sql. The app connects as this role and nothing
#      else — src/lib/db.ts refuses to serve a query as the owner, because
#      owners bypass row-level security and every restaurant would see
#      every other restaurant's nights.
#   3. the seed: the six restaurants and the admin
#
# It prints the two values the host needs: DATABASE_URL (as zet_app) and
# ADMIN_USER_ID. The owner URL itself is NEVER given to the app.
#
# The zet_app password, in order:
#   - zet_app already exists (every run after the first): its password is
#     LEFT ALONE. This is the normal case — applying a new migration must
#     not log the live site out of its own database, which is what
#     happened to the default before 05/10/2026.
#   - ROTATE_PASSWORD=1: a new random one is set, and the printed
#     DATABASE_URL must replace the one the host has (then a new rollout).
#   - ZET_APP_PASSWORD=…: that exact password is set.
#   - zet_app does not exist yet (first run): a new random one is set.

set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n\n' "$*" >&2; exit 1; }

[ -n "${OWNER_DATABASE_URL:-}" ] || die "Set OWNER_DATABASE_URL to the database's OWNER connection string (Neon: the one for neondb_owner)."
command -v psql >/dev/null 2>&1 || die "psql is not installed (brew install postgresql@16)."

APP_ROLE="zet_app"

PSQL=(psql "$OWNER_DATABASE_URL" -q -v ON_ERROR_STOP=1)

WHO=$("${PSQL[@]}" -tA -c "select format('%s on %s (PostgreSQL %s)', current_user, current_database(), current_setting('server_version'))") \
  || die "Could not connect with OWNER_DATABASE_URL. Check it was copied whole, including ?sslmode=require."
say "Connected as: $WHO"

ROLE_EXISTS=$("${PSQL[@]}" -tA -c "select count(*) from pg_roles where rolname = '$APP_ROLE'")
if [ -n "${ZET_APP_PASSWORD:-}" ]; then
  APP_PASSWORD="$ZET_APP_PASSWORD"; PASSWORD_MODE="given"
elif [ "$ROLE_EXISTS" = "1" ] && [ "${ROTATE_PASSWORD:-}" != "1" ]; then
  APP_PASSWORD=""; PASSWORD_MODE="kept"
else
  APP_PASSWORD="$(openssl rand -hex 24)"; PASSWORD_MODE="new"
fi
case "$APP_PASSWORD" in *[!A-Za-z0-9]*) die "ZET_APP_PASSWORD must be letters and digits only (it goes into a URL).";; esac

IS_SUPER=$("${PSQL[@]}" -tA -c "select rolsuper from pg_roles where rolname = current_user")
[ "$IS_SUPER" = "f" ] || echo "  note: connected as a superuser. Fine for setup; the app must still use $APP_ROLE."

# ── 1. Migrations ───────────────────────────────────────────────────────
say "Applying migrations"
ERR=$(mktemp)
for f in db/migrations/*.sql; do
  printf '  %s ... ' "$(basename "$f")"
  if "${PSQL[@]}" -f "$f" >/dev/null 2>"$ERR"; then
    echo "ok"
  elif grep -q "already exists" "$ERR"; then
    echo "already applied"
  else
    echo "FAILED"
    cat "$ERR" >&2
    die "Migration $(basename "$f") failed. Nothing after it was applied."
  fi
done

# ── 2. The application role ─────────────────────────────────────────────
say "Role $APP_ROLE (non-owner, NOBYPASSRLS)"
"${PSQL[@]}" -v app_role="$APP_ROLE" -v app_password="$APP_PASSWORD" -f db/app-role.sql

# ── 3. Seed ─────────────────────────────────────────────────────────────
say "Seeding restaurants and the admin user"
ADMIN_USER_ID=$("${PSQL[@]}" -tA -f db/seed.sql | tail -1 | tr -d '[:space:]')
[ -n "$ADMIN_USER_ID" ] || die "Seed did not return an admin user id."

# ── 4. Prove the role is what the app needs ─────────────────────────────
# Connect AS zet_app and ask: not super, no BYPASSRLS, not the owner.
# The same three things db.ts checks on every connection.
REST="${OWNER_DATABASE_URL#*://}"
REST="${REST#*@}"
APP_URL="postgresql://$APP_ROLE:$APP_PASSWORD@$REST"
# Neon's copied URL ends in &channel_binding=require. psql understands it;
# the app's driver (node-postgres) does not, so it is left off the app's URL.
# sslmode=require stays: the connection is still encrypted.
APP_URL=$(printf '%s' "$APP_URL" | sed -E 's/\?channel_binding=[^&]*&/?/; s/[?&]channel_binding=[^&]*//')
case "$APP_URL" in *sslmode=*) ;; *\?*) APP_URL="$APP_URL&sslmode=require" ;; *) APP_URL="$APP_URL?sslmode=require" ;; esac

if [ "$PASSWORD_MODE" = "kept" ]; then
  # The password is not known here, so the role is checked from the
  # owner's side instead of by logging in as it: the same three facts.
  say "Checking the app's role"
  CHECK=$("${PSQL[@]}" -tA -c "
    select r.rolsuper, r.rolbypassrls,
           (select tableowner from pg_tables where tablename = 'zet_report') = r.rolname
      from pg_roles r where r.rolname = '$APP_ROLE'")
  [ "$CHECK" = "f|f|f" ] || die "$APP_ROLE is not safe to run the app as (super|bypassrls|owner = $CHECK)."
  echo "  $APP_ROLE: not superuser, no BYPASSRLS, not the owner"

  say "Done. The database is up to date."
  cat <<OUT

  $APP_ROLE's password was left as it is, so the DATABASE_URL the host
  already has still works. Nothing to change there.

  ADMIN_USER_ID (unchanged)
  $ADMIN_USER_ID

OUT
  exit 0
fi

say "Checking the app's login"
CHECK=$(psql "$APP_URL" -tA -v ON_ERROR_STOP=1 -c "
  select r.rolsuper, r.rolbypassrls,
         (select tableowner from pg_tables where tablename = 'zet_report') = current_user
    from pg_roles r where r.rolname = current_user") || die "Could not log in as $APP_ROLE."
[ "$CHECK" = "f|f|f" ] || die "$APP_ROLE is not safe to run the app as (super|bypassrls|owner = $CHECK)."
echo "  $APP_ROLE logs in; not superuser, no BYPASSRLS, not the owner"

say "Done. Give the host these two values:"
cat <<OUT

  DATABASE_URL   (secret)
  $APP_URL

  ADMIN_USER_ID
  $ADMIN_USER_ID

OUT
if [ "$PASSWORD_MODE" = "new" ]; then
  echo "A NEW $APP_ROLE password was just set. If the host already had a"
  echo "DATABASE_URL, replace it with the one above (then create a rollout)"
  echo "or the app cannot log in."
  echo
fi
