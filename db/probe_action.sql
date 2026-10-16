-- Digital ZET — probe for the save action (src/server/saveReport.ts).
--
-- Run in order, after the migrations:
--   psql <connection> -f db/migrations/0001_init.sql
--   psql <connection> -f db/migrations/0002_harden_reports.sql
--   psql <connection> -f db/migrations/0003_close_correction_lock_forgery.sql
--   psql <connection> -f db/probe_action.sql
--
-- Everything runs inside one transaction that is ROLLBACK'd at the end, so
-- it is safe to run repeatedly against a real dev database.
--
-- What this proves that src/server/saveReport.test.ts cannot. Those unit
-- tests mock `pg`, so they can assert the ORDER of the statements the action
-- issues but not that Postgres accepts them. This file replays that exact
-- sequence — the same column lists, the same unnest inserts, the same
-- two-phase approve — against the real schema, with every trigger and every
-- policy live.
--
-- It answers NEXT_STEP's three questions:
--   1. a posted total is rejected     — sections 3 and 4
--   2. a correction archives a revision — section 5
--   3. a staff member cannot save for a restaurant they don't belong to
--                                      — section 7
--
-- Every attack asserts on a SPECIFIC SQLSTATE, never WHEN OTHERS, for the
-- reason db/probe.sql's header gives: a WHEN OTHERS handler stays green even
-- when the wrong mechanism (or a typo) raised the error.
--
--   ZET01  approved report — child row blocked outside a correction
--   ZET02  correction protocol violated on zet_report itself
--   428C9  generated_always — variance_cents is derived, never written
--   42501  insufficient_privilege — row-level security
--
-- Must be run as a role with CREATEROLE (the same role that applied the
-- migrations). Section 7 creates a genuinely unprivileged role and switches
-- into it: the migration owner bypasses RLS, so testing authorisation as
-- that role would pass for the wrong reason.
\set ON_ERROR_STOP on

BEGIN;

-- ── Seed ──────────────────────────────────────────────────────────────────

INSERT INTO restaurant (id, legal_name, display_name, layout) VALUES
  ('anamma', 'ΤΟ ΑΝΑΜΜΑ', 'ΤΟ ΑΝΑΜΜΑ · Λήδρας 87', 'ledger'),
  ('chop_engomi', 'CHOPSTICKS', 'CHOPSTICKS · Mall of Engomi', 'ledger');

INSERT INTO app_user (id, email, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'manager.anamma@example.test', 'ANAMMA Manager'),
  ('22222222-2222-2222-2222-222222222222', 'staff.engomi@example.test', 'Engomi Staff');

INSERT INTO restaurant_user (restaurant_id, user_id, role) VALUES
  ('anamma', '11111111-1111-1111-1111-111111111111', 'manager'),
  ('chop_engomi', '22222222-2222-2222-2222-222222222222', 'staff');

SET LOCAL zet.user_id = '11111111-1111-1111-1111-111111111111';

-- ── 1. The action's save-and-approve sequence, statement for statement ────
--
-- This is the ΑΝΑΜΜΑ 14/09/26 sheet: 2165,00 − 1640,33 − 84,80 − 31,80,
-- expected cash 408,07, counted 408,07. The figures below are what
-- src/lib/compute.ts produced; the action never stores a figure the browser
-- sent.
--
-- Note the status: 'submitted', NOT 'approved'. A report written as approved
-- cannot have its children inserted afterwards — section 2 proves that is a
-- hard error, and it is the reason the action approves in a second phase.

INSERT INTO zet_report
  (id, restaurant_id, business_date, status, closing_manager_name, signature_url,
   source_photo_url, expected_cents, actual_cents, created_by, submitted_at)
VALUES
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'anamma', '2026-09-14',
   'submitted'::report_status, 'Μαρία Γεωργίου', 'data:image/png;base64,iVBOR',
   NULL, 40807, 40807, '11111111-1111-1111-1111-111111111111',
   CASE WHEN 'submitted'::report_status = 'submitted' THEN now() END);

-- The action clears the child rows before rewriting them. On a first save
-- these match nothing; they must still be accepted.
DELETE FROM zet_report_slot
  WHERE report_line_id IN (SELECT id FROM zet_report_line
                            WHERE report_id = 'aaaaaaaa-0000-0000-0000-00000000000a');
DELETE FROM zet_report_line WHERE report_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
DELETE FROM zet_expense_line WHERE report_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
DELETE FROM zet_cheque WHERE report_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
DELETE FROM zet_pending_receipt WHERE report_id = 'aaaaaaaa-0000-0000-0000-00000000000a';

-- Every input row the ΑΝΑΜΜΑ form defines, in one unnest insert.
INSERT INTO zet_report_line (report_id, row_key, label_override, amount_cents)
SELECT 'aaaaaaaa-0000-0000-0000-00000000000a', k, l, a
  FROM unnest(
    ARRAY['gross','card1','card2','FOODY','B3','WOLT','BOLT','cheques','pending']::text[],
    ARRAY[NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL]::text[],
    ARRAY[216500,164033,0,8480,0,3180,0,0,0]::bigint[]
  ) AS t(k, l, a);

-- The α)…ε) order slots beside FOODY. They are NOT required to add up to
-- their row (SPEC.md §5 leaves that unenforced) — these deliberately do not.
INSERT INTO zet_report_slot (report_line_id, slot_index, amount_cents)
SELECT id, idx, amt
  FROM unnest(
    ARRAY[(SELECT id FROM zet_report_line
            WHERE report_id = 'aaaaaaaa-0000-0000-0000-00000000000a' AND row_key = 'FOODY'),
          (SELECT id FROM zet_report_line
            WHERE report_id = 'aaaaaaaa-0000-0000-0000-00000000000a' AND row_key = 'FOODY')]::uuid[],
    ARRAY[0,1]::smallint[],
    ARRAY[4000,100]::bigint[]
  ) AS t(id, idx, amt);

INSERT INTO zet_expense_line (report_id, line_no, description, amount_cents)
SELECT 'aaaaaaaa-0000-0000-0000-00000000000a', n, NULLIF(d,''), a
  FROM unnest(ARRAY[1]::smallint[], ARRAY['Λαχανικά']::text[], ARRAY[0]::bigint[]) AS t(n, d, a);

-- Phase two. OLD.status is 'submitted', so the archive trigger correctly
-- treats this as a plain status change: no revision, no correction_reason.
UPDATE zet_report SET
  status = 'approved',
  approved_at = now(),
  approved_by = '11111111-1111-1111-1111-111111111111'::uuid
WHERE id = 'aaaaaaaa-0000-0000-0000-00000000000a';

DO $$
DECLARE
  v_status report_status;
  v_rev int;
  v_variance bigint;
  v_lines int;
  v_revisions int;
BEGIN
  SELECT status, revision_no, variance_cents INTO v_status, v_rev, v_variance
    FROM zet_report WHERE id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  SELECT count(*) INTO v_lines FROM zet_report_line
    WHERE report_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  SELECT count(*) INTO v_revisions FROM zet_report_revision
    WHERE report_id = 'aaaaaaaa-0000-0000-0000-00000000000a';

  IF v_status <> 'approved' THEN
    RAISE EXCEPTION 'PROBE FAILED — report A should be approved, is %', v_status;
  END IF;
  IF v_rev <> 1 THEN
    RAISE EXCEPTION 'PROBE FAILED — approving is not a correction; revision_no should still be 1, is %', v_rev;
  END IF;
  IF v_revisions <> 0 THEN
    RAISE EXCEPTION 'PROBE FAILED — approving archived % revision(s); it should archive none', v_revisions;
  END IF;
  IF v_variance <> 0 THEN
    RAISE EXCEPTION 'PROBE FAILED — variance should be 408,07 counted minus 408,07 expected = 0, is %', v_variance;
  END IF;
  IF v_lines <> 9 THEN
    RAISE EXCEPTION 'PROBE FAILED — expected 9 ledger lines (every printed input row), got %', v_lines;
  END IF;
  RAISE NOTICE 'the action''s save-and-approve sequence is accepted end to end';
END $$;

\echo '1. save + two-phase approve accepted; variance derived as 0; no spurious revision'

-- ── 2. The trap the two-phase approve exists to avoid ────────────────────
--
-- A report written straight to 'approved' cannot have its children inserted
-- afterwards. The child guard (0002) refuses any write to an approved
-- report's rows unless zet_correction_lock holds this transaction's id, and
-- that lock is armed ONLY by the BEFORE UPDATE trigger when OLD.status is
-- already 'approved' — it never fires on INSERT. An action that inserted the
-- header as approved would fail here on its very first child row.

INSERT INTO zet_report
  (id, restaurant_id, business_date, status, expected_cents, actual_cents, created_by)
VALUES
  ('dddddddd-0000-0000-0000-00000000000d', 'anamma', '2026-09-17',
   'approved'::report_status, 0, 0, '11111111-1111-1111-1111-111111111111');

DO $$
BEGIN
  BEGIN
    INSERT INTO zet_report_line (report_id, row_key, amount_cents)
      VALUES ('dddddddd-0000-0000-0000-00000000000d', 'gross', 216500);
    RAISE EXCEPTION 'PROBE FAILED — a child row was written into a report inserted as approved';
  EXCEPTION WHEN SQLSTATE 'ZET01' THEN
    RAISE NOTICE 'inserting the header as approved makes its children unwritable, as expected: %', SQLERRM;
  END;
END $$;

\echo '2. confirmed: approve-then-write-children is rejected with ZET01 — hence phase two'

-- ── 3. A posted total, at the database's own boundary ────────────────────
--
-- The action rejects expected_cents / actual_cents / variance_cents in the
-- payload before it ever reaches SQL (see saveReport.test.ts). This is the
-- floor underneath that: even code that tried to write a variance cannot.

DO $$
BEGIN
  BEGIN
    EXECUTE $q$
      INSERT INTO zet_report
        (restaurant_id, business_date, status, expected_cents, actual_cents,
         variance_cents, created_by)
      VALUES ('anamma', '2026-09-20', 'draft', 100000, 100000, 999999,
              '11111111-1111-1111-1111-111111111111')
    $q$;
    RAISE EXCEPTION 'PROBE FAILED — a client-supplied variance_cents was accepted on INSERT';
  EXCEPTION WHEN SQLSTATE '428C9' THEN
    RAISE NOTICE 'variance_cents cannot be written, only derived: %', SQLERRM;
  END;
END $$;

\echo '3. a posted variance is refused by the column itself (428C9), not by convention'

-- ── 4. Recomputation is the only source of the stored totals ─────────────

-- A fresh draft, deliberately NOT report D: report D is approved, so any
-- UPDATE to it would be judged as a correction and refused with ZET02 —
-- which is section 6's subject, not this one.
INSERT INTO zet_report
  (id, restaurant_id, business_date, status, expected_cents, actual_cents, created_by)
VALUES
  ('eeeeeeee-0000-0000-0000-00000000000e', 'anamma', '2026-09-19',
   'draft'::report_status, 0, 0, '11111111-1111-1111-1111-111111111111');

DO $$
DECLARE v_variance bigint;
BEGIN
  UPDATE zet_report SET expected_cents = 40807, actual_cents = 39000
    WHERE id = 'eeeeeeee-0000-0000-0000-00000000000e';
  SELECT variance_cents INTO v_variance FROM zet_report
    WHERE id = 'eeeeeeee-0000-0000-0000-00000000000e';
  IF v_variance <> -1807 THEN
    RAISE EXCEPTION 'PROBE FAILED — variance should track actual - expected (-1807), is %', v_variance;
  END IF;
  RAISE NOTICE 'a shortage of 18,07 is stored as variance -1807, derived from the two stored figures';
END $$;

\echo '4. variance always tracks actual - expected; a shortage is negative'

-- ── 5. A correction archives a revision ──────────────────────────────────
--
-- The action's correction path: ONE UPDATE to zet_report that bumps
-- revision_no and carries correction_reason + correction_by, issued BEFORE
-- any child row is touched. That UPDATE is what archives the snapshot and
-- arms the lock; the child rewrites below are only legal because of it.

UPDATE zet_report SET
  revision_no = revision_no + 1,
  correction_reason = 'Η card1 είχε γραφτεί λάθος',
  correction_by = '11111111-1111-1111-1111-111111111111'::uuid,
  status = 'approved'::report_status,
  closing_manager_name = 'Μαρία Γεωργίου',
  signature_url = 'data:image/png;base64,iVBOR',
  source_photo_url = NULL,
  expected_cents = 45000,
  actual_cents = 45000,
  approved_at = now(),
  approved_by = '11111111-1111-1111-1111-111111111111'::uuid
WHERE id = 'aaaaaaaa-0000-0000-0000-00000000000a';

-- Now the children, inside the same transaction, under the lock the UPDATE
-- above opened.
DELETE FROM zet_report_slot
  WHERE report_line_id IN (SELECT id FROM zet_report_line
                            WHERE report_id = 'aaaaaaaa-0000-0000-0000-00000000000a');
DELETE FROM zet_report_line WHERE report_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
DELETE FROM zet_expense_line WHERE report_id = 'aaaaaaaa-0000-0000-0000-00000000000a';

INSERT INTO zet_report_line (report_id, row_key, label_override, amount_cents)
SELECT 'aaaaaaaa-0000-0000-0000-00000000000a', k, l, a
  FROM unnest(
    ARRAY['gross','card1','card2','FOODY','B3','WOLT','BOLT','cheques','pending']::text[],
    ARRAY[NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL]::text[],
    ARRAY[216500,159933,0,8480,0,3180,0,0,0]::bigint[]
  ) AS t(k, l, a);

DO $$
DECLARE
  v_rev int;
  v_reason text;
  v_by uuid;
  v_archived_gross text;
  v_archived_card1 text;
  v_archived_status report_status;
  v_archived_reason text;
  v_live_card1 bigint;
  v_count int;
BEGIN
  SELECT revision_no, correction_reason, correction_by
    INTO v_rev, v_reason, v_by
    FROM zet_report WHERE id = 'aaaaaaaa-0000-0000-0000-00000000000a';

  IF v_rev <> 2 THEN
    RAISE EXCEPTION 'PROBE FAILED — revision_no should be 2 after one correction, is %', v_rev;
  END IF;
  -- The trigger blanks these after archiving: they describe one UPDATE, not
  -- a lasting property of the report.
  IF v_reason IS NOT NULL OR v_by IS NOT NULL THEN
    RAISE EXCEPTION 'PROBE FAILED — correction_reason/correction_by should not persist past the UPDATE';
  END IF;

  SELECT count(*) INTO v_count FROM zet_report_revision
    WHERE report_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PROBE FAILED — expected exactly 1 archived revision, got %', v_count;
  END IF;

  SELECT status_at_revision, reason,
         snapshot->'report'->>'expected_cents',
         (SELECT l->>'amount_cents' FROM jsonb_array_elements(snapshot->'lines') l
           WHERE l->>'row_key' = 'card1')
    INTO v_archived_status, v_archived_reason, v_archived_gross, v_archived_card1
    FROM zet_report_revision
    WHERE report_id = 'aaaaaaaa-0000-0000-0000-00000000000a' AND revision_no = 1;

  IF v_archived_status <> 'approved' THEN
    RAISE EXCEPTION 'PROBE FAILED — the archived revision should record status approved, has %', v_archived_status;
  END IF;
  IF v_archived_reason <> 'Η card1 είχε γραφτεί λάθος' THEN
    RAISE EXCEPTION 'PROBE FAILED — the correction reason was not archived; got %', v_archived_reason;
  END IF;
  IF v_archived_gross <> '40807' THEN
    RAISE EXCEPTION 'PROBE FAILED — the snapshot should hold the PRE-correction expected 40807, holds %', v_archived_gross;
  END IF;
  -- The whole point: the child row as it was BEFORE the correction, even
  -- though the correction rewrote it later in the same transaction.
  IF v_archived_card1 <> '164033' THEN
    RAISE EXCEPTION 'PROBE FAILED — the snapshot should hold the pre-correction card1 164033, holds %', v_archived_card1;
  END IF;

  SELECT amount_cents INTO v_live_card1 FROM zet_report_line
    WHERE report_id = 'aaaaaaaa-0000-0000-0000-00000000000a' AND row_key = 'card1';
  IF v_live_card1 <> 159933 THEN
    RAISE EXCEPTION 'PROBE FAILED — the live card1 should be the corrected 159933, is %', v_live_card1;
  END IF;

  RAISE NOTICE 'correction archived revision 1 (card1 164033, expected 40807) and left the live row at 159933';
END $$;

\echo '5. a correction bumps the revision and archives the report AND its children as they were'

-- ── 6. The correction protocol is not optional ───────────────────────────
--
-- Report B is approved and has never been corrected in this transaction, so
-- no lock exists for it. Report A cannot be used here: its lock is already
-- armed for the rest of this transaction by section 5.

INSERT INTO zet_report
  (id, restaurant_id, business_date, status, expected_cents, actual_cents, created_by)
VALUES
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'anamma', '2026-09-15',
   'draft'::report_status, 10000, 10000, '11111111-1111-1111-1111-111111111111');

INSERT INTO zet_report_line (report_id, row_key, amount_cents)
  VALUES ('bbbbbbbb-0000-0000-0000-00000000000b', 'gross', 10000);

UPDATE zet_report SET status = 'approved', approved_at = now(),
  approved_by = '11111111-1111-1111-1111-111111111111'::uuid
  WHERE id = 'bbbbbbbb-0000-0000-0000-00000000000b';

-- 6a. Editing a child first — the ordering mistake the action is built to
-- make impossible — is refused.
DO $$
BEGIN
  BEGIN
    UPDATE zet_report_line SET amount_cents = 777777
      WHERE report_id = 'bbbbbbbb-0000-0000-0000-00000000000b';
    RAISE EXCEPTION 'PROBE FAILED — an approved report''s takings were rewritten with no revision';
  EXCEPTION WHEN SQLSTATE 'ZET01' THEN
    RAISE NOTICE 'child-first edit refused: %', SQLERRM;
  END;
END $$;

-- 6b. Updating the header without bumping revision_no is refused.
DO $$
BEGIN
  BEGIN
    UPDATE zet_report SET expected_cents = 1,
      correction_reason = 'x', correction_by = '11111111-1111-1111-1111-111111111111'
      WHERE id = 'bbbbbbbb-0000-0000-0000-00000000000b';
    RAISE EXCEPTION 'PROBE FAILED — an approved report was edited without bumping revision_no';
  EXCEPTION WHEN SQLSTATE 'ZET02' THEN
    RAISE NOTICE 'correction without a revision bump refused: %', SQLERRM;
  END;
END $$;

-- 6c. Bumping the revision but omitting the reason is refused.
DO $$
BEGIN
  BEGIN
    UPDATE zet_report SET revision_no = revision_no + 1, expected_cents = 1
      WHERE id = 'bbbbbbbb-0000-0000-0000-00000000000b';
    RAISE EXCEPTION 'PROBE FAILED — an approved report was corrected with no reason recorded';
  EXCEPTION WHEN SQLSTATE 'ZET02' THEN
    RAISE NOTICE 'correction without a reason refused: %', SQLERRM;
  END;
END $$;

DO $$
DECLARE v_amount bigint;
BEGIN
  SELECT amount_cents INTO v_amount FROM zet_report_line
    WHERE report_id = 'bbbbbbbb-0000-0000-0000-00000000000b';
  IF v_amount <> 10000 THEN
    RAISE EXCEPTION 'PROBE FAILED — report B''s takings changed despite every attempt being refused (now %)', v_amount;
  END IF;
  RAISE NOTICE 'report B is untouched at 10000 after three refused corrections';
END $$;

\echo '6. corrections must bump the revision, carry a reason, and start at the header'

-- ── 7. A staff member cannot save for a restaurant they don't belong to ──
--
-- Run as a genuinely unprivileged role. As the migration owner this would
-- pass regardless of whether the policies work, because owners bypass RLS.
-- Grants mirror what the app role actually needs.

-- A draft in ΑΝΑΜΜΑ for the child-insert test: against an approved report
-- the ZET01 guard fires before RLS's WITH CHECK is ever evaluated, which
-- would prove nothing about authorisation.
INSERT INTO zet_report
  (id, restaurant_id, business_date, status, expected_cents, actual_cents, created_by)
VALUES
  ('cccccccc-0000-0000-0000-00000000000c', 'anamma', '2026-09-16',
   'draft'::report_status, 500, 500, '11111111-1111-1111-1111-111111111111');

CREATE ROLE zet_action_probe_role NOLOGIN NOBYPASSRLS;

GRANT SELECT ON restaurant, app_user TO zet_action_probe_role;
GRANT SELECT ON zet_report_revision TO zet_action_probe_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  restaurant_user, zet_report, zet_report_line, zet_report_slot,
  zet_expense_line, zet_cheque, zet_pending_receipt, zet_shift,
  zet_shift_payment, zet_report_invoice
  TO zet_action_probe_role;

SET LOCAL ROLE zet_action_probe_role;
SET LOCAL zet.user_id = '22222222-2222-2222-2222-222222222222'; -- Engomi staff

-- 7a. The action's first statement is SELECT ... FOR UPDATE on
-- (restaurant_id, business_date). For an outsider it must find nothing —
-- which is also why it must not be the only gate: finding nothing is what
-- sends the action on to INSERT.
DO $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM zet_report
    WHERE restaurant_id = 'anamma' AND business_date = '2026-09-14';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'PROBE FAILED — Engomi staff can see ΑΝΑΜΜΑ''s report (% rows)', v_count;
  END IF;
  RAISE NOTICE 'RLS: Engomi staff sees 0 rows of ΑΝΑΜΜΑ''s 14/09 report';
END $$;

-- 7b. The role lookup the action authorises on returns nothing, so
-- authorizeRestaurantAccess denies with 'not_a_member' before any write.
DO $$
DECLARE v_role text;
BEGIN
  SELECT role::text INTO v_role FROM restaurant_user
    WHERE restaurant_id = 'anamma' AND user_id = '22222222-2222-2222-2222-222222222222';
  IF v_role IS NOT NULL THEN
    RAISE EXCEPTION 'PROBE FAILED — Engomi staff resolved a role of % for ΑΝΑΜΜΑ', v_role;
  END IF;
  RAISE NOTICE 'authorisation lookup: Engomi staff has no role for ΑΝΑΜΜΑ, so the action denies the save';
END $$;

-- 7c. And if that check were ever removed, the database still refuses the
-- INSERT. This is the floor under CLAUDE.md rule 3, not a duplicate of it.
DO $$
BEGIN
  BEGIN
    INSERT INTO zet_report
      (restaurant_id, business_date, status, expected_cents, actual_cents, created_by)
    VALUES ('anamma', '2026-09-18', 'submitted', 99999, 99999,
            '22222222-2222-2222-2222-222222222222');
    RAISE EXCEPTION 'PROBE FAILED — Engomi staff saved a report for ΑΝΑΜΜΑ';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    RAISE NOTICE 'RLS: Engomi staff cannot INSERT a report for ΑΝΑΜΜΑ: %', SQLERRM;
  END;
END $$;

-- 7d. Nor overwrite ΑΝΑΜΜΑ's existing one: the UPDATE matches no rows at all.
DO $$
DECLARE v_rows int;
BEGIN
  UPDATE zet_report SET actual_cents = 1
    WHERE id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'PROBE FAILED — Engomi staff''s UPDATE matched % row(s) of ΑΝΑΜΜΑ''s report', v_rows;
  END IF;
  RAISE NOTICE 'RLS: Engomi staff''s UPDATE matched 0 rows of ΑΝΑΜΜΑ''s report';
END $$;

-- 7e. Nor write a child row into ΑΝΑΜΜΑ's draft.
DO $$
BEGIN
  BEGIN
    INSERT INTO zet_report_line (report_id, row_key, amount_cents)
      VALUES ('cccccccc-0000-0000-0000-00000000000c', 'gross', 999999);
    RAISE EXCEPTION 'PROBE FAILED — Engomi staff inserted a line into ΑΝΑΜΜΑ''s draft';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    RAISE NOTICE 'RLS: Engomi staff cannot INSERT a line into ΑΝΑΜΜΑ''s draft: %', SQLERRM;
  END;
END $$;

RESET ROLE;

DO $$
DECLARE v_actual bigint; v_lines int;
BEGIN
  SELECT actual_cents INTO v_actual FROM zet_report
    WHERE id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  SELECT count(*) INTO v_lines FROM zet_report_line
    WHERE report_id = 'cccccccc-0000-0000-0000-00000000000c';
  IF v_actual <> 45000 THEN
    RAISE EXCEPTION 'PROBE FAILED — ΑΝΑΜΜΑ''s report was modified by Engomi staff (actual_cents=%)', v_actual;
  END IF;
  IF v_lines <> 0 THEN
    RAISE EXCEPTION 'PROBE FAILED — % line(s) landed in ΑΝΑΜΜΑ''s draft', v_lines;
  END IF;
  RAISE NOTICE 'confirmed as owner: nothing of ΑΝΑΜΜΑ''s was touched by Engomi staff';
END $$;

\echo '7. an outsider cannot read, create, overwrite or add lines to a report of another restaurant'

-- zet_action_probe_role holds grants on 13 tables; DROP ROLE alone fails
-- while any remain.
DROP OWNED BY zet_action_probe_role;
DROP ROLE zet_action_probe_role;

\echo 'ALL ACTION PROBES PASSED'

ROLLBACK;
