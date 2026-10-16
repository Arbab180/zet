-- Digital ZET — only an admin approves a night, and only an admin changes
-- one that is approved.
--
-- Decided 05/10/2026, once each restaurant had its own login (0008): a
-- restaurant files its night and may keep fixing it while it is a draft or
-- submitted. Approving it, and correcting it after that, is the admin's.
--
-- The app checks this (src/server/saveReport.ts, src/server/approve.ts).
-- This trigger is the same rule in the database, so it does not depend on
-- every write path in the app remembering it — the same reasoning as the
-- row-level security in 0002.
--
-- Who counts as an admin: the caller (zet.user_id) holds the 'admin' role
-- for THIS report's restaurant in restaurant_user. Per restaurant, read on
-- every write, like everything else here.
--
-- With zet.user_id unset the check does not apply. That is the owner
-- running maintenance (db/demo.sql, a restore): the app's own role cannot
-- reach a single row without zet.user_id — row-level security hides them
-- all — so for it the check always applies.
--
-- Child rows of an approved report need nothing new: they can only be
-- written inside a correction (0003), and a correction starts with the
-- header UPDATE this trigger now guards.
--
--   ZET07  approving, or changing an approved report, needs an admin

BEGIN;

-- First statement on purpose: re-running this file fails here with
-- "already exists", which db-setup.sh / db-deploy.sh read as "applied".
CREATE FUNCTION zet_report_admin_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid := zet_current_user_id();
BEGIN
  IF v_user IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'approved' OR (TG_OP = 'UPDATE' AND OLD.status = 'approved') THEN
    IF NOT EXISTS (
      SELECT 1 FROM restaurant_user
       WHERE restaurant_id = NEW.restaurant_id
         AND user_id = v_user
         AND role = 'admin'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'ZET07',
        MESSAGE = format(
          'only an admin of %s may approve a report or change an approved one',
          NEW.restaurant_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Named to sort before zet_report_before_update (0001): triggers fire in
-- name order, so a refused correction is refused before anything is
-- archived or the correction lock is armed.
CREATE TRIGGER zet_report_admin_guard
  BEFORE INSERT OR UPDATE ON zet_report
  FOR EACH ROW EXECUTE FUNCTION zet_report_admin_guard();

COMMIT;
