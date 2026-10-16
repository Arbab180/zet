-- Digital ZET — probe for 0002_harden_reports.sql + 0003_close_correction_lock_forgery.sql.
--
-- Run in order:
--   psql <connection> -f db/migrations/0001_init.sql
--   psql <connection> -f db/migrations/0002_harden_reports.sql
--   psql <connection> -f db/migrations/0003_close_correction_lock_forgery.sql
--   psql <connection> -f db/probe.sql
--
-- Everything runs inside one transaction that is ROLLBACK'd at the end —
-- safe to run repeatedly against a real dev database, no residue.
--
-- Every attack asserts on a SPECIFIC SQLSTATE, never WHEN OTHERS. A prior
-- version of the RLS INSERT test caught WHEN OTHERS and stayed green even
-- with every RLS policy dropped, because it targeted an approved report:
-- the approved-report child guard raised first and the test could not
-- tell the two mechanisms apart. Pinning each assertion to the one
-- SQLSTATE its own mechanism raises (ZET01/ZET02/ZET03 for the hand-built
-- triggers, 42501/428C9/23503 for RLS/generated-column/FK) is what makes
-- that class of false pass impossible: if the wrong exception, or no
-- exception, comes back, the WHEN clause doesn't match and the error
-- propagates uncaught, aborting the script visibly under ON_ERROR_STOP.
--
-- Must be run as a role with CREATEROLE (the same admin/owner role used to
-- apply the migrations). The RLS section creates a genuinely unprivileged
-- role and switches into it rather than trusting the migration-running
-- connection's own results — the migration owner bypasses RLS by default,
-- so testing RLS as that role would pass for the wrong reason regardless
-- of whether the policies are correct.
\set ON_ERROR_STOP on

BEGIN;

-- ── Seed ──────────────────────────────────────────────────────────────

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

-- Report A — ΑΝΑΜΜΑ, approved, gets legitimately corrected later.
-- Seeded as 'draft' first: the child guard would otherwise reject these
-- very seed inserts, since it blocks child writes on an already-approved
-- report. Children go in while still a draft; the report is then approved
-- as a normal status transition (OLD.status <> 'approved' at that point,
-- so the archive trigger's correction requirements don't apply).
INSERT INTO zet_report
  (id, restaurant_id, business_date, status, expected_cents, actual_cents, created_by)
VALUES
  ('33333333-3333-3333-3333-333333333333', 'anamma', '2026-09-14', 'draft',
   216500, 216500, '11111111-1111-1111-1111-111111111111');

INSERT INTO zet_report_line (report_id, row_key, amount_cents) VALUES
  ('33333333-3333-3333-3333-333333333333', 'gross', 216500),
  ('33333333-3333-3333-3333-333333333333', 'FOODY', 5000);

INSERT INTO zet_report_slot (id, report_line_id, slot_index, amount_cents)
SELECT '44444444-4444-4444-4444-444444444444', id, 0, 5000
FROM zet_report_line
WHERE report_id = '33333333-3333-3333-3333-333333333333' AND row_key = 'FOODY';

UPDATE zet_report
SET status = 'approved', approved_at = now(),
    approved_by = '11111111-1111-1111-1111-111111111111'
WHERE id = '33333333-3333-3333-3333-333333333333';

-- Report B — Chopsticks Engomi, approved, never corrected. Exists purely
-- to prove the correction lock is scoped to the report it was issued for,
-- not "any correction happened in this transaction unlocks everything".
INSERT INTO zet_report
  (id, restaurant_id, business_date, status, expected_cents, actual_cents, created_by)
VALUES
  ('77777777-7777-7777-7777-777777777777', 'chop_engomi', '2026-09-14', 'draft',
   74004, 72009, '22222222-2222-2222-2222-222222222222');

INSERT INTO zet_report_line (report_id, row_key, amount_cents) VALUES
  ('77777777-7777-7777-7777-777777777777', 'gross', 74004);

UPDATE zet_report
SET status = 'approved', approved_at = now(),
    approved_by = '22222222-2222-2222-2222-222222222222'
WHERE id = '77777777-7777-7777-7777-777777777777';

-- Report C — ΑΝΑΜΜΑ, left as a draft. Used only for the RLS INSERT test:
-- it must NOT be approved, or the child guard fires first and the test
-- proves nothing about RLS (see the header note above).
INSERT INTO zet_report
  (id, restaurant_id, business_date, status, expected_cents, actual_cents, created_by)
VALUES
  ('88888888-8888-8888-8888-888888888888', 'anamma', '2026-09-15', 'draft',
   0, 0, '11111111-1111-1111-1111-111111111111');

\echo 'seed complete: report A (approved), report B (approved), report C (draft)'

-- ── Defect 1: direct writes to an approved report's children (ZET01) ────

DO $$
BEGIN
  BEGIN
    UPDATE zet_report_line SET amount_cents = 111111
      WHERE report_id = '33333333-3333-3333-3333-333333333333' AND row_key = 'gross';
    RAISE EXCEPTION 'PROBE FAILED — attack 1a succeeded: gross was rewritten on an approved report with no revision';
  EXCEPTION WHEN SQLSTATE 'ZET01' THEN
    RAISE NOTICE 'attack 1a (UPDATE zet_report_line, approved) correctly rejected: %', SQLERRM;
  END;
END $$;

DO $$
BEGIN
  BEGIN
    DELETE FROM zet_report_line
      WHERE report_id = '33333333-3333-3333-3333-333333333333' AND row_key = 'gross';
    RAISE EXCEPTION 'PROBE FAILED — attack 1b succeeded: a line was deleted from an approved report with no revision';
  EXCEPTION WHEN SQLSTATE 'ZET01' THEN
    RAISE NOTICE 'attack 1b (DELETE zet_report_line, approved) correctly rejected: %', SQLERRM;
  END;
END $$;

DO $$
BEGIN
  BEGIN
    INSERT INTO zet_report_line (report_id, row_key, amount_cents)
      VALUES ('33333333-3333-3333-3333-333333333333', 'card2', 999999);
    RAISE EXCEPTION 'PROBE FAILED — attack 1c succeeded: a new line was inserted into an approved report with no revision';
  EXCEPTION WHEN SQLSTATE 'ZET01' THEN
    RAISE NOTICE 'attack 1c (INSERT zet_report_line, approved) correctly rejected: %', SQLERRM;
  END;
END $$;

-- Two hops removed (report_line_id -> zet_report_line.report_id): proves
-- the guard composes through zet_report_slot, not just the direct tables.
DO $$
BEGIN
  BEGIN
    UPDATE zet_report_slot SET amount_cents = 1
      WHERE id = '44444444-4444-4444-4444-444444444444';
    RAISE EXCEPTION 'PROBE FAILED — attack 1d succeeded: an order slot was rewritten on an approved report with no revision';
  EXCEPTION WHEN SQLSTATE 'ZET01' THEN
    RAISE NOTICE 'attack 1d (UPDATE zet_report_slot, two hops, approved) correctly rejected: %', SQLERRM;
  END;
END $$;

\echo 'attacks 1a-1d rejected with ZET01 as expected'

-- ── Legitimate correction still works (positive-path check) ─────────────

UPDATE zet_report
SET actual_cents = 216000,
    revision_no = revision_no + 1,
    correction_reason = 'probe: legitimate correction',
    correction_by = '11111111-1111-1111-1111-111111111111'
WHERE id = '33333333-3333-3333-3333-333333333333';

UPDATE zet_report_line SET amount_cents = 216000
  WHERE report_id = '33333333-3333-3333-3333-333333333333' AND row_key = 'gross';

DO $$
DECLARE v_variance bigint;
BEGIN
  SELECT variance_cents INTO v_variance FROM zet_report
    WHERE id = '33333333-3333-3333-3333-333333333333';
  IF v_variance <> -500 THEN
    RAISE EXCEPTION 'PROBE FAILED — expected variance_cents -500 after correction, got %', v_variance;
  END IF;
  RAISE NOTICE 'legitimate correction succeeded, variance_cents recomputed to %', v_variance;
END $$;

DO $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM zet_report_revision
    WHERE report_id = '33333333-3333-3333-3333-333333333333';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PROBE FAILED — expected exactly 1 archived revision, got %', v_count;
  END IF;
  RAISE NOTICE 'one revision archived, as expected';
END $$;

\echo 'legitimate correction of report A succeeded and was archived'

-- ── Correction lock is scoped to the report it was issued for ───────────
-- Report A was just legitimately corrected in THIS transaction. Report B
-- is a different, never-corrected approved report. If the lock were keyed
-- only by "a correction happened in this transaction" rather than by
-- report_id, this would wrongly succeed.

DO $$
BEGIN
  BEGIN
    UPDATE zet_report_line SET amount_cents = 1
      WHERE report_id = '77777777-7777-7777-7777-777777777777' AND row_key = 'gross';
    RAISE EXCEPTION 'PROBE FAILED — report A''s correction lock leaked to report B';
  EXCEPTION WHEN SQLSTATE 'ZET01' THEN
    RAISE NOTICE 'lock correctly scoped: report B still rejected after correcting report A: %', SQLERRM;
  END;
END $$;

-- ── GUC forgery (the live defect from 0003) — must still be rejected ────
-- The guard no longer reads zet.correcting_report_id at all. Setting it
-- must have no effect, on report B specifically because it was never
-- legitimately corrected in this transaction — proving this isn't a false
-- pass from report A's real lock.

SET LOCAL zet.correcting_report_id = '77777777-7777-7777-7777-777777777777';

DO $$
BEGIN
  BEGIN
    UPDATE zet_report_line SET amount_cents = 777777
      WHERE report_id = '77777777-7777-7777-7777-777777777777' AND row_key = 'gross';
    RAISE EXCEPTION 'PROBE FAILED — GUC forgery succeeded: report B was rewritten by setting zet.correcting_report_id directly';
  EXCEPTION WHEN SQLSTATE 'ZET01' THEN
    RAISE NOTICE 'GUC forgery correctly rejected — the flag is no longer trusted: %', SQLERRM;
  END;
END $$;

\echo 'GUC forgery attack rejected; correction lock is unforgeable'

-- ── Audit trail itself: append-only (ZET03) ──────────────────────────────

DO $$
BEGIN
  BEGIN
    UPDATE zet_report_revision SET reason = 'tampered'
      WHERE report_id = '33333333-3333-3333-3333-333333333333';
    RAISE EXCEPTION 'PROBE FAILED — a revision row was edited after the fact';
  EXCEPTION WHEN SQLSTATE 'ZET03' THEN
    RAISE NOTICE 'revision UPDATE correctly rejected: %', SQLERRM;
  END;
END $$;

DO $$
BEGIN
  BEGIN
    DELETE FROM zet_report_revision
      WHERE report_id = '33333333-3333-3333-3333-333333333333';
    RAISE EXCEPTION 'PROBE FAILED — a revision row was deleted';
  EXCEPTION WHEN SQLSTATE 'ZET03' THEN
    RAISE NOTICE 'revision DELETE correctly rejected: %', SQLERRM;
  END;
END $$;

-- ── Defect 2: deleting a report must not destroy its revision history
-- (23503 foreign_key_violation) ──────────────────────────────────────────

DO $$
BEGIN
  BEGIN
    DELETE FROM zet_report WHERE id = '33333333-3333-3333-3333-333333333333';
    RAISE EXCEPTION 'PROBE FAILED — attack 2 succeeded: a report was deleted while its revision history still referenced it';
  EXCEPTION WHEN SQLSTATE '23503' THEN
    RAISE NOTICE 'attack 2 (DELETE zet_report, has revisions) correctly rejected: %', SQLERRM;
  END;
END $$;

\echo 'attack 2 rejected with 23503; revisions outlive their report'

-- ── Defect 3: variance_cents cannot be written directly (428C9) ─────────
-- Attempted alongside a well-formed correction (bumped revision_no, both
-- correction fields set) so the only possible failure is the generated
-- column, not a missing correction field (which would be ZET02, not this).

DO $$
BEGIN
  BEGIN
    UPDATE zet_report
    SET actual_cents = 500000,
        expected_cents = 400000,
        variance_cents = 999999,
        revision_no = revision_no + 1,
        correction_reason = 'probe: attack 3',
        correction_by = '11111111-1111-1111-1111-111111111111'
    WHERE id = '33333333-3333-3333-3333-333333333333';
    RAISE EXCEPTION 'PROBE FAILED — attack 3 succeeded: variance_cents accepted a value inconsistent with actual/expected';
  EXCEPTION WHEN SQLSTATE '428C9' THEN
    RAISE NOTICE 'attack 3 (direct write to variance_cents) correctly rejected: %', SQLERRM;
  END;
END $$;

DO $$
DECLARE v_revision_no int; v_revision_count int;
BEGIN
  SELECT revision_no INTO v_revision_no FROM zet_report
    WHERE id = '33333333-3333-3333-3333-333333333333';
  SELECT count(*) INTO v_revision_count FROM zet_report_revision
    WHERE report_id = '33333333-3333-3333-3333-333333333333';
  IF v_revision_no <> 2 OR v_revision_count <> 1 THEN
    RAISE EXCEPTION
      'PROBE FAILED — attack 3''s failed statement left side effects: revision_no=%, revision_count=% (expected 2 and 1)',
      v_revision_no, v_revision_count;
  END IF;
  RAISE NOTICE 'attack 3''s failure was atomic: no partial revision bump or archive';
END $$;

\echo 'attack 3 rejected with 428C9; variance_cents is derived, not writable'

-- ── Defect 4: a read-only role now exists (positive path) ───────────────

INSERT INTO app_user (id, email, name)
VALUES ('55555555-5555-5555-5555-555555555555', 'viewer.anamma@example.test', 'ANAMMA Viewer');

INSERT INTO restaurant_user (restaurant_id, user_id, role)
VALUES ('anamma', '55555555-5555-5555-5555-555555555555', 'viewer');

DO $$
DECLARE v_role restaurant_role;
BEGIN
  SELECT role INTO v_role FROM restaurant_user
    WHERE restaurant_id = 'anamma' AND user_id = '55555555-5555-5555-5555-555555555555';
  IF v_role <> 'viewer' THEN
    RAISE EXCEPTION 'PROBE FAILED — expected role viewer, got %', v_role;
  END IF;
  RAISE NOTICE 'read-only role viewer accepted';
END $$;

\echo 'defect 4 fixed; viewer role available for the PROMPTS.md step 2 test case'

-- ── RLS: a genuinely unprivileged role must not reach another
-- restaurant's data. Run as the migration owner, this would trivially
-- pass regardless of whether the policies work (owners bypass RLS), so a
-- real non-owner role is created and switched into for this section. Its
-- grants mirror what the app/invoicing role actually needs post-0003:
-- no access at all to zet_correction_lock, read-only on zet_report_revision.

CREATE ROLE zet_probe_role NOLOGIN NOBYPASSRLS;

GRANT SELECT ON restaurant, app_user TO zet_probe_role;
GRANT SELECT ON zet_report_revision TO zet_probe_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  restaurant_user, zet_report, zet_report_line, zet_report_slot,
  zet_expense_line, zet_cheque, zet_pending_receipt, zet_shift,
  zet_shift_payment, zet_report_invoice
  TO zet_probe_role;

SET LOCAL ROLE zet_probe_role;
SET LOCAL zet.user_id = '22222222-2222-2222-2222-222222222222'; -- Engomi staff

DO $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM zet_report
    WHERE id = '33333333-3333-3333-3333-333333333333';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'PROBE FAILED — RLS attack: Engomi staff could see ΑΝΑΜΜΑ''s report (% rows visible)', v_count;
  END IF;
  RAISE NOTICE 'RLS: Engomi staff correctly sees 0 rows of ΑΝΑΜΜΑ''s report A';
END $$;

DO $$
DECLARE v_rows int;
BEGIN
  UPDATE zet_report SET actual_cents = 1
    WHERE id = '33333333-3333-3333-3333-333333333333';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'PROBE FAILED — RLS attack: Engomi staff''s UPDATE matched % row(s) of ΑΝΑΜΜΑ''s report', v_rows;
  END IF;
  RAISE NOTICE 'RLS: Engomi staff''s UPDATE correctly matched 0 rows of ΑΝΑΜΜΑ''s report';
END $$;

-- The INSERT test: must target a DRAFT report (report C) in another
-- restaurant. Report A/B are approved — against them, the ZET01 child
-- guard (a BEFORE ROW trigger) fires before RLS's WITH CHECK is even
-- evaluated, so an approved target proves nothing about RLS specifically.
-- Report C is a draft, so the guard is a no-op here and RLS is the only
-- remaining gate — matching what was independently confirmed by hand:
-- "new row violates row-level security policy for table zet_report_line".
DO $$
BEGIN
  BEGIN
    INSERT INTO zet_report_line (report_id, row_key, amount_cents)
      VALUES ('88888888-8888-8888-8888-888888888888', 'sneaked_in', 1);
    RAISE EXCEPTION 'PROBE FAILED — RLS attack: Engomi staff inserted a line into ΑΝΑΜΜΑ''s draft report C';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    RAISE NOTICE 'RLS: Engomi staff correctly cannot INSERT into ΑΝΑΜΜΑ''s draft report C: %', SQLERRM;
  END;
END $$;

RESET ROLE;

DO $$
DECLARE v_actual bigint;
BEGIN
  SELECT actual_cents INTO v_actual FROM zet_report
    WHERE id = '33333333-3333-3333-3333-333333333333';
  IF v_actual = 1 THEN
    RAISE EXCEPTION 'PROBE FAILED — RLS attack: Engomi staff''s UPDATE actually changed ΑΝΑΜΜΑ''s report';
  END IF;
  RAISE NOTICE 'RLS: confirmed as owner that ΑΝΑΜΜΑ''s report was not modified by Engomi staff (actual_cents=%)', v_actual;
END $$;

-- zet_probe_role still owns the privileges granted above; DROP ROLE alone
-- fails while any GRANTs to it exist on 13 tables. DROP OWNED BY revokes
-- everything granted to the role (and drops anything it owns) first.
DROP OWNED BY zet_probe_role;
DROP ROLE zet_probe_role;

\echo 'ALL PROBES PASSED'

ROLLBACK;
