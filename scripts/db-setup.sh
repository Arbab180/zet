#!/usr/bin/env bash
#
# Sets up the local development database from nothing.
#
#   ./scripts/db-setup.sh          create and seed (safe to re-run)
#   ./scripts/db-setup.sh --reset  drop it first, then do all of it
#
# What it creates:
#   - a database `zet`, owned by your own macOS user
#   - the schema, by running db/migrations/*.sql in order
#   - a LOGIN role `zet_app` that does NOT own the tables and does NOT have
#     BYPASSRLS. This matters: table owners and superusers bypass row-level
#     security silently, which would switch off per-restaurant
#     authorisation without a single error. src/lib/db.ts refuses to serve
#     a query if it detects it is connected as any of those.
#   - the four restaurants and one admin (db/seed.sql)
#
# Then it writes DATABASE_URL and ADMIN_USER_ID into .env.local, leaving
# anything already there alone.

set -euo pipefail

DB_NAME="${ZET_DB_NAME:-zet}"
APP_ROLE="zet_app"
APP_PASSWORD="${ZET_APP_PASSWORD:-zet_dev_password}"
ENV_FILE=".env.local"

cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n\n' "$*" >&2; exit 1; }

# ── 1. Is Postgres here and running? ────────────────────────────────────
command -v psql >/dev/null 2>&1 || die \
"Postgres is not installed.

    brew install postgresql@16
    brew services start postgresql@16
    echo 'export PATH=\"/opt/homebrew/opt/postgresql@16/bin:\$PATH\"' >> ~/.zshrc

Open a new terminal, then run this script again."

pg_isready -q 2>/dev/null || die \
"Postgres is installed but not running.

    brew services start postgresql@16

Then run this script again."

say "Postgres found: $(psql --version)"

# ── 2. The database ─────────────────────────────────────────────────────
if [ "${1:-}" = "--reset" ]; then
  say "Dropping $DB_NAME (--reset)"
  dropdb --if-exists "$DB_NAME"
fi

if psql -lqt | cut -d'|' -f1 | grep -qw "$DB_NAME"; then
  say "Database $DB_NAME already exists"
else
  say "Creating database $DB_NAME"
  createdb "$DB_NAME"
fi

# ── 3. Migrations, in filename order ────────────────────────────────────
say "Applying migrations"
for f in db/migrations/*.sql; do
  printf '  %s ... ' "$(basename "$f")"
  if psql -q -d "$DB_NAME" -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>/tmp/zet_mig_err; then
    echo "ok"
  elif grep -q "already exists" /tmp/zet_mig_err; then
    echo "already applied"
  else
    echo "FAILED"
    cat /tmp/zet_mig_err >&2
    die "Migration $(basename "$f") failed. Re-run with --reset for a clean database."
  fi
done

# ── 4. The application role ─────────────────────────────────────────────
# The same grants, for hosted databases, are in db/app-role.sql — keep both
# lists in step when a table is added.
# NOBYPASSRLS is explicit rather than assumed: it is the whole reason this
# role exists instead of connecting as the owner.
say "Creating role $APP_ROLE (non-owner, NOBYPASSRLS)"
psql -q -d "$DB_NAME" -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$APP_ROLE') THEN
    CREATE ROLE $APP_ROLE LOGIN PASSWORD '$APP_PASSWORD' NOBYPASSRLS;
  ELSE
    ALTER ROLE $APP_ROLE LOGIN PASSWORD '$APP_PASSWORD' NOBYPASSRLS;
  END IF;
END
\$\$;

GRANT CONNECT ON DATABASE $DB_NAME TO $APP_ROLE;
GRANT USAGE ON SCHEMA public TO $APP_ROLE;

GRANT SELECT ON restaurant, app_user, restaurant_user TO $APP_ROLE;
-- Card machines (migration 0010): read by every sheet, written only
-- through zet_admin_save_card_machines, which checks for an admin.
GRANT SELECT ON card_machine TO $APP_ROLE;
GRANT SELECT, INSERT ON zet_report_revision TO $APP_ROLE;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  zet_report, zet_report_line, zet_report_slot,
  zet_expense_line, zet_cheque, zet_pending_receipt, zet_shift,
  zet_shift_payment, zet_report_invoice
  TO $APP_ROLE;

-- Never zet_correction_lock: only the SECURITY DEFINER trigger writes it.
-- A role that can insert there can forge a correction and rewrite an
-- approved night's takings with no revision recorded (migration 0003).
REVOKE ALL ON zet_correction_lock FROM $APP_ROLE;

-- Logins (migration 0008). Never app_login itself: the password hashes are
-- reachable only through these functions, and the two admin_* ones check
-- inside the database that the caller is an admin.
REVOKE ALL ON app_login FROM $APP_ROLE;
-- Read-only since 0008. Membership is who sees which restaurant; a login
-- able to write it could make itself 'admin' of its own restaurant and
-- approve its own flagged nights. Only zet_admin_create_login writes it.
-- REVOKE as well as not granting: an existing role still holds the old grant.
REVOKE INSERT, UPDATE, DELETE ON restaurant_user FROM $APP_ROLE;
GRANT EXECUTE ON FUNCTION
  zet_caller_is_admin(), zet_login_lookup(text), zet_session_gen(uuid),
  zet_admin_create_login(text, text, text, text),
  zet_admin_set_password(uuid, text),
  zet_admin_save_card_machines(text, bigint[], text[])
  TO $APP_ROLE;
SQL

# ── 5. Seed ─────────────────────────────────────────────────────────────
say "Seeding restaurants and the admin user"
ADMIN_USER_ID=$(psql -qtA -d "$DB_NAME" -v ON_ERROR_STOP=1 -f db/seed.sql | tail -1 | tr -d '[:space:]')
[ -n "$ADMIN_USER_ID" ] || die "Seed did not return an admin user id."
echo "  admin user id: $ADMIN_USER_ID"

# ── 6. .env.local ───────────────────────────────────────────────────────
DATABASE_URL="postgres://$APP_ROLE:$APP_PASSWORD@localhost:5432/$DB_NAME"

touch "$ENV_FILE"
set_env() {
  local key="$1" value="$2"
  if grep -q "^$key=" "$ENV_FILE" 2>/dev/null; then
    # Existing value wins: never clobber a password hash or secret already
    # set up by hand.
    local current
    current=$(grep "^$key=" "$ENV_FILE" | head -1 | cut -d= -f2-)
    if [ -n "$current" ]; then
      echo "  $key already set — left alone"
      return
    fi
    # Present but empty: fill it in, portably (BSD and GNU sed differ on -i).
    local tmp
    tmp=$(mktemp)
    grep -v "^$key=" "$ENV_FILE" > "$tmp"
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
    mv "$tmp" "$ENV_FILE"
    echo "  $key written"
  else
    # A file whose last line has no newline would get this key glued onto
    # the end of that line — and silently become part of someone else's
    # value. That is how DATABASE_URL went "missing" on 05/10/2026.
    if [ -s "$ENV_FILE" ] && [ -n "$(tail -c 1 "$ENV_FILE")" ]; then
      printf '\n' >> "$ENV_FILE"
    fi
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
    echo "  $key written"
  fi
}

say "Writing $ENV_FILE"
set_env DATABASE_URL "$DATABASE_URL"
set_env ADMIN_USER_ID "$ADMIN_USER_ID"
set_env ADMIN_USERNAME "admin"

MISSING=""
grep -q '^ADMIN_PASSWORD_HASH=.\+' "$ENV_FILE" 2>/dev/null || MISSING="yes"
grep -q '^SESSION_SECRET=.\+' "$ENV_FILE" 2>/dev/null || MISSING="yes"

say "Database ready."
if [ -n "$MISSING" ]; then
  cat <<'NEXT'

One thing left — you still need a password:

    npm run hash-password

Paste the two lines it prints into .env.local, then:

    npm run dev

NEXT
else
  cat <<'NEXT'

    npm run dev

NEXT
fi
