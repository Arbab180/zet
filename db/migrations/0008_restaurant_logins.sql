-- Digital ZET — one login per restaurant, and an admin who sees them all.
--
-- Until now there was a single login, configured from the environment
-- (src/server/auth.ts), acting as one app_user who is a member of every
-- restaurant. Every night of every restaurant was one password away.
--
-- After this migration:
--
--   - Each restaurant can have its own login: an app_user with a username
--     and a password hash, and ONE restaurant_user row — its own
--     restaurant, role 'manager'. Row-level security (0002) already scopes
--     every report read and write to restaurant_user membership, so a
--     restaurant login sees its own nights and nothing else. Nothing new
--     is needed for that part; it is the existing floor doing its job.
--   - The admin stays the environment login, unchanged, and keeps seeing
--     every restaurant because it is a member of every restaurant (the
--     seed links it to all of them). Not because anything bypasses RLS:
--     the app still connects as zet_app, NOBYPASSRLS.
--   - app_user.is_admin marks who may manage logins. Only the owner (the
--     seed, a migration) can set it: zet_app has SELECT on app_user and
--     nothing more, so the app cannot promote anyone, itself included.
--
-- ── Where the password hashes live ──────────────────────────────────────
--
-- In app_login, a table zet_app has NO grant on at all — the same
-- treatment as zet_correction_lock. The app never selects a hash table
-- directly. It goes through SECURITY DEFINER functions:
--
--   zet_login_lookup(username)           the one row a login attempt needs
--   zet_session_gen(user)                is this session still current?
--   zet_admin_create_login(...)          admin only, checked IN the function
--   zet_admin_set_password(user, hash)   admin only, checked IN the function
--
-- "Admin only" is decided by the database from zet.user_id, not by the
-- page that called it. A bug in the accounts page cannot create a login,
-- and neither can a restaurant login calling the function directly.
--
-- session_gen is bumped by every password reset. The session cookie
-- carries the generation it was issued under and every request re-checks
-- it, so resetting a password signs that restaurant out everywhere at
-- once instead of up to eight hours later.
--
-- Raised errors carry their own SQLSTATE, as since 0003:
--   ZET04  caller is not an admin
--   ZET05  bad input to an account function (unknown user/restaurant)
--   ZET06  the restaurant already has a login
-- A taken username is the built-in 23505 unique_violation; a malformed one
-- is 23514 check_violation.

BEGIN;

-- First statement on purpose: re-running this file fails here with
-- "already exists", which db-setup.sh / db-deploy.sh read as "applied".
CREATE TABLE app_login (
  user_id        uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  password_hash  text NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
  session_gen    int  NOT NULL DEFAULT 1,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES app_user(id)
);

-- Owner-only. Explicit, so a later blanket GRANT does not open it.
REVOKE ALL ON app_login FROM PUBLIC;

-- What is typed on the login form. Lower-case by construction, so "Anamma"
-- and "anamma" can never be two accounts. Not secret, so it lives on
-- app_user where the accounts page can list it.
ALTER TABLE app_user ADD COLUMN username text UNIQUE
  CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,31}$');

ALTER TABLE app_user ADD COLUMN is_admin boolean NOT NULL DEFAULT false;

-- A restaurant login has no email address. The column stays UNIQUE.
ALTER TABLE app_user ALTER COLUMN email DROP NOT NULL;

-- The seeded admin (db/seed.sql) is the admin. The seed sets it too, so a
-- fresh database gets it either way.
UPDATE app_user SET is_admin = true WHERE email = 'admin@chinaspice.local';

-- ── Functions ────────────────────────────────────────────────────────────

CREATE FUNCTION zet_caller_is_admin()
RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(
    (SELECT is_admin FROM app_user WHERE id = zet_current_user_id()),
    false);
$$;

-- Zero or one row. Called before anyone is signed in, so it cannot key off
-- zet.user_id; it answers for exactly the username asked about, never a
-- list.
CREATE FUNCTION zet_login_lookup(p_username text)
RETURNS TABLE (user_id uuid, password_hash text, session_gen int)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT u.id, l.password_hash, l.session_gen
    FROM app_user u
    JOIN app_login l ON l.user_id = u.id
   WHERE u.username = lower(btrim(p_username));
$$;

-- The generation a session must carry to still be valid, or NULL when the
-- user has no login row.
CREATE FUNCTION zet_session_gen(p_user_id uuid)
RETURNS int
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT session_gen FROM app_login WHERE user_id = p_user_id;
$$;

CREATE FUNCTION zet_admin_create_login(
  p_restaurant_id text,
  p_username      text,
  p_name          text,
  p_password_hash text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  IF NOT zet_caller_is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = 'ZET04', MESSAGE = 'only an admin can create logins';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM restaurant WHERE id = p_restaurant_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZET05',
      MESSAGE = format('unknown restaurant %s', p_restaurant_id);
  END IF;

  -- One login per restaurant: a second is a second password for the same
  -- nights that nobody remembers to reset. Checked here, under a lock held
  -- to the end of the transaction, so two admins pressing "create" at the
  -- same moment cannot both pass the check.
  PERFORM pg_advisory_xact_lock(hashtext('zet_restaurant_login:' || p_restaurant_id));
  IF EXISTS (
    SELECT 1 FROM restaurant_user ru
      JOIN app_user u ON u.id = ru.user_id
     WHERE ru.restaurant_id = p_restaurant_id
       AND u.username IS NOT NULL AND NOT u.is_admin
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZET06',
      MESSAGE = format('restaurant %s already has a login', p_restaurant_id);
  END IF;

  INSERT INTO app_user (username, name)
  VALUES (lower(btrim(p_username)), btrim(p_name))
  RETURNING id INTO v_user_id;

  INSERT INTO app_login (user_id, password_hash, updated_by)
  VALUES (v_user_id, p_password_hash, zet_current_user_id());

  -- 'manager', not 'admin': approving and correcting approved nights are
  -- the admin's (src/server/approve.ts, migration 0009).
  INSERT INTO restaurant_user (restaurant_id, user_id, role)
  VALUES (p_restaurant_id, v_user_id, 'manager');

  RETURN v_user_id;
END;
$$;

CREATE FUNCTION zet_admin_set_password(p_user_id uuid, p_password_hash text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT zet_caller_is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = 'ZET04', MESSAGE = 'only an admin can set passwords';
  END IF;

  UPDATE app_login
     SET password_hash = p_password_hash,
         session_gen   = session_gen + 1,
         updated_at    = now(),
         updated_by    = zet_current_user_id()
   WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'ZET05',
      MESSAGE = format('user %s has no login', p_user_id);
  END IF;
END;
$$;

-- Functions are EXECUTE-able by PUBLIC by default. Take that away; the app
-- role is granted them by name in db/app-role.sql and scripts/db-setup.sh.
REVOKE ALL ON FUNCTION zet_caller_is_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION zet_login_lookup(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION zet_session_gen(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION zet_admin_create_login(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION zet_admin_set_password(uuid, text) FROM PUBLIC;

COMMIT;
