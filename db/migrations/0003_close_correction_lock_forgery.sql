-- Digital ZET — close the correction-lock forgery hole.
--
-- Confirmed exploitable against 0002_harden_reports.sql:
--
--   BEGIN;
--   SET LOCAL zet.correcting_report_id = '<approved report id>';
--   UPDATE zet_report_line SET amount_cents = 777777 WHERE ...;
--   COMMIT;
--
-- rewrites an approved report's takings with no revision recorded. The root
-- cause: zet.correcting_report_id was a plain session GUC. Postgres does
-- not gate custom GUCs by privilege at all — any role that can run SET
-- LOCAL, which is every role, can set zet.correcting_report_id to any
-- report id and walk straight through the guard added in 0002. The guard
-- was checking a flag anyone could forge, not proof that the trusted
-- archive trigger had actually run.
--
-- Fix: replace the GUC with a lock keyed by the current transaction's own
-- id (pg_current_xact_id()), stored in a table that no ordinary role has
-- any grant on — only a SECURITY DEFINER function can write to it. A role
-- can set a session variable to anything it likes; it cannot make its own
-- transaction BE a transaction it isn't. Forging "my report_id matches"
-- is trivial. Forging "my transaction id matches a transaction that
-- already committed" is not possible — that id was assigned by Postgres
-- to a different, already-finished transaction.
--
-- Also: every hand-raised exception in this schema (the child guard, the
-- correction-protocol checks, the revision-immutability trigger) now
-- carries its own SQLSTATE instead of the PL/pgSQL default P0001, so a
-- caller — including db/probe.sql — can assert exactly which mechanism
-- rejected a write instead of catching WHEN OTHERS and hoping.
--
--   ZET01  approved report — child row blocked outside a correction
--   ZET02  correction protocol violated on zet_report itself
--          (revision_no not bumped / correction_reason or correction_by missing)
--   ZET03  zet_report_revision is append-only
--
-- (Built-in codes already in play and unchanged: 42501 insufficient_privilege
-- for RLS, 428C9 generated_always for variance_cents, 23503
-- foreign_key_violation for deleting a report with revision history.)
--
-- Operational note superseding 0002's: zet_report_archive_before_correction
-- is now SECURITY DEFINER, so it no longer needs the calling role to hold
-- INSERT on zet_report_revision — it writes as the table owner regardless.
-- The app/invoicing role's required grant on zet_report_revision drops
-- from "SELECT, INSERT" to just SELECT. It needs no grant at all on
-- zet_correction_lock — nothing outside the two functions below should
-- ever touch that table directly.

CREATE TABLE zet_correction_lock (
  report_id  uuid PRIMARY KEY REFERENCES zet_report(id) ON DELETE CASCADE,
  txid       xid8 NOT NULL,
  locked_at  timestamptz NOT NULL DEFAULT now(),
  locked_by  uuid NOT NULL REFERENCES app_user(id)
);

-- Belt and braces: table privileges are owner-only by default in Postgres
-- (unlike functions, which default to PUBLIC EXECUTE), so this is
-- redundant today. It stays explicit so a later blanket
-- "GRANT ALL ON ALL TABLES IN SCHEMA public" doesn't silently open it.
REVOKE ALL ON zet_correction_lock FROM PUBLIC;

-- No RLS here: nothing but the two SECURITY DEFINER functions below is
-- ever meant to read or write this table, and both bypass RLS as the
-- table owner regardless. Enabling it would add nothing.

CREATE OR REPLACE FUNCTION zet_assert_report_editable(p_report_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status report_status;
BEGIN
  SELECT status INTO v_status FROM zet_report WHERE id = p_report_id;
  IF v_status = 'approved' THEN
    IF NOT EXISTS (
      SELECT 1 FROM zet_correction_lock
      WHERE report_id = p_report_id AND txid = pg_current_xact_id()
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'ZET01',
        MESSAGE = format(
          'report %s is approved; child rows cannot be written outside a correction (update zet_report with revision_no bumped and correction_reason/correction_by set first)',
          p_report_id);
    END IF;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION zet_report_archive_before_correction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.status = 'approved' THEN
    IF NEW.revision_no <= OLD.revision_no THEN
      RAISE EXCEPTION USING
        ERRCODE = 'ZET02',
        MESSAGE = format(
          'correcting an approved report must increment revision_no (was %s, got %s)',
          OLD.revision_no, NEW.revision_no);
    END IF;
    IF NEW.correction_reason IS NULL OR btrim(NEW.correction_reason) = '' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'ZET02',
        MESSAGE = 'correcting an approved report requires correction_reason';
    END IF;
    IF NEW.correction_by IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'ZET02',
        MESSAGE = 'correcting an approved report requires correction_by';
    END IF;

    INSERT INTO zet_report_revision
      (report_id, revision_no, status_at_revision, snapshot, reason, changed_by)
    VALUES
      (OLD.id, OLD.revision_no, OLD.status, zet_report_snapshot(OLD.id),
       NEW.correction_reason, NEW.correction_by);

    INSERT INTO zet_correction_lock (report_id, txid, locked_by)
    VALUES (OLD.id, pg_current_xact_id(), NEW.correction_by)
    ON CONFLICT (report_id) DO UPDATE
      SET txid = EXCLUDED.txid, locked_at = now(), locked_by = EXCLUDED.locked_by;

    NEW.correction_reason := NULL;
    NEW.correction_by := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION zet_revision_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'ZET03',
    MESSAGE = 'zet_report_revision rows are append-only; they cannot be updated or deleted';
END;
$$;
