-- The application's login role: what the app connects as, and exactly what
-- it may touch. Used by scripts/db-deploy.sh (hosted databases).
--
--   psql … -v app_role=zet_app -v app_password=… -f db/app-role.sql
--
-- NOBYPASSRLS is explicit rather than assumed: it is the whole reason this
-- role exists instead of connecting as the owner. KEEP THE GRANTS BELOW IN
-- STEP WITH scripts/db-setup.sh (local), and add every new table to both.

SELECT format(
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_role')
       -- NOT restating NOBYPASSRLS here: a non-superuser owner (Neon's
       -- neondb_owner) is refused permission to touch that attribute at
       -- all, even to switch it off. The role was created without it, and
       -- db-deploy.sh checks rolbypassrls is false after every run.
       THEN 'ALTER ROLE %I LOGIN PASSWORD %L'
       ELSE 'CREATE ROLE %I LOGIN PASSWORD %L NOBYPASSRLS' END,
  :'app_role', :'app_password')
-- An empty password means "leave the role's password alone": no row, so
-- nothing is executed. db-deploy.sh passes it empty on every run after the
-- first, so that applying a migration never changes the live login.
 WHERE :'app_password' <> '' \gexec

SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'app_role') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_role') \gexec

SELECT format('GRANT SELECT ON restaurant, app_user, restaurant_user TO %I', :'app_role') \gexec
-- Card machines (migration 0010): read by every sheet, written only
-- through zet_admin_save_card_machines, which checks for an admin.
SELECT format('GRANT SELECT ON card_machine TO %I', :'app_role') \gexec
SELECT format('GRANT SELECT, INSERT ON zet_report_revision TO %I', :'app_role') \gexec
SELECT format($f$GRANT SELECT, INSERT, UPDATE, DELETE ON
  zet_report, zet_report_line, zet_report_slot,
  zet_expense_line, zet_cheque, zet_pending_receipt, zet_shift,
  zet_shift_payment, zet_report_invoice
  TO %I$f$, :'app_role') \gexec

-- Never zet_correction_lock: only the SECURITY DEFINER trigger writes it.
-- A role that can insert there can forge a correction and rewrite an
-- approved night's takings with no revision recorded (migration 0003).
SELECT format('REVOKE ALL ON zet_correction_lock FROM %I', :'app_role') \gexec

-- Logins (migration 0008). Never app_login itself: the password hashes are
-- reachable only through these functions, and the two admin_* ones check
-- inside the database that the caller is an admin.
SELECT format('REVOKE ALL ON app_login FROM %I', :'app_role') \gexec
-- Read-only since 0008. Membership is who sees which restaurant; a login
-- able to write it could make itself 'admin' of its own restaurant and
-- approve its own flagged nights. Only zet_admin_create_login writes it.
-- REVOKE as well as not granting: an existing role still holds the old grant.
SELECT format('REVOKE INSERT, UPDATE, DELETE ON restaurant_user FROM %I', :'app_role') \gexec
SELECT format($f$GRANT EXECUTE ON FUNCTION
  zet_caller_is_admin(), zet_login_lookup(text), zet_session_gen(uuid),
  zet_admin_create_login(text, text, text, text),
  zet_admin_set_password(uuid, text),
  zet_admin_save_card_machines(text, bigint[], text[])
  TO %I$f$, :'app_role') \gexec
