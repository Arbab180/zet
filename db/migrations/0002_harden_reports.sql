-- Digital ZET — harden approved reports against direct writes, and decide RLS.
--
-- Fixes four defects found by probing 0001_init.sql against Postgres 16:
--
--   1. AUDIT HOLE — the archive trigger only watched zet_report. Every
--      child table (zet_report_line, zet_report_slot, zet_expense_line,
--      zet_cheque, zet_pending_receipt, zet_shift, zet_shift_payment,
--      zet_shift_invoice) could be INSERTed, UPDATEd or DELETEd directly,
--      on an approved report, with no error and no revision recorded. The
--      0001 comment telling callers to "update zet_report first" was a
--      convention, not an enforcement mechanism — it relied on every future
--      caller reading and obeying a comment.
--   2. zet_report_revision.report_id was ON DELETE CASCADE, so deleting a
--      report destroyed its own audit trail — backwards from "corrections
--      are new revisions". Changed to ON DELETE RESTRICT: a report with any
--      revision history cannot be deleted at all, forcing a deliberate
--      decision about what happens to the history first.
--   3. variance_cents was a plain column that accepted any value regardless
--      of actual_cents/expected_cents. Converted to
--      GENERATED ALWAYS AS (actual_cents - expected_cents) STORED so an
--      inconsistent variance is not a validation rule to remember, it is a
--      write Postgres refuses to accept.
--   4. restaurant_role had no read-only value, and docs/PROMPTS.md step 2
--      explicitly asks for a "read-only role" test case. Added 'viewer'.
--
-- Also fixed proactively, same class of hole as #1: zet_report_revision
-- itself had no protection against UPDATE or DELETE once inserted. An
-- audit trail that can be edited is not an audit trail. Added a trigger
-- that rejects both, unconditionally.
--
-- ── RLS decision ──────────────────────────────────────────────────────
-- Enabled, deliberately, starting now rather than "when we get to it".
-- Reasoning: CLAUDE.md rule 3 ("authorise per restaurant on every
-- request") has so far been enforced only by the Next.js server layer.
-- SPEC.md §7 and §9 describe a second consumer reading this same database
-- directly — the AI invoicing project, joining on zet_expense_line and
-- zet_shift_invoice for their receipt_photo_url / supplier / invoice
-- fields. App-layer authorisation does not reach a connection that isn't
-- going through the app. If that project connects with its own Postgres
-- credentials and this database has no row security, "authorise per
-- restaurant on every request" becomes a promise the app keeps and the
-- database does not — one bug or one new consumer away from Engomi
-- reading ΑΝΑΜΜΑ's takings, which is the exact hole SPEC.md §6 names as
-- the known gap in the prototype.
--
-- Design: every restaurant-scoped table gets a policy keyed off
-- restaurant_user membership for a user id read from a session GUC
-- (zet.user_id), which the calling application must SET LOCAL at the
-- start of every request/transaction — not once per connection, matching
-- "not once at login". Child tables key off their parent's visibility
-- (report_id IN (SELECT id FROM zet_report), etc.) rather than repeating
-- the restaurant_user join, relying on Postgres composing RLS policies
-- across the subquery.
--
-- Scoped OUT of this migration, deliberately:
--   - restaurant: no RLS. Four restaurant names/addresses already printed
--     on a public paper form; not sensitive.
--   - app_user: no RLS. Scoping it correctly depends on the login/lookup
--     flow (auth needs to find a user by email before restaurant_user
--     membership is known) which isn't designed yet. Leaving it open is a
--     conscious gap, not an oversight — closing it before the auth flow
--     exists risks locking out login itself.
--   - Role-based policy (e.g. 'viewer' cannot read zet_report_revision):
--     not attempted. CLAUDE.md rule 3 asks for restaurant-level
--     authorisation; role-level restriction within a restaurant a user
--     already belongs to is a separate, later decision.
--
-- Operational requirement this depends on: the tables are owned by
-- whichever role runs migrations. Table owners bypass RLS by default. The
-- Next.js app and the invoicing project must both connect as a role that
-- is NOT that owner and does NOT have BYPASSRLS — otherwise RLS silently
-- does nothing for them, same as for the owner. That role needs, at
-- minimum: SELECT, INSERT, UPDATE, DELETE on restaurant_user, zet_report,
-- zet_report_line, zet_report_slot, zet_expense_line, zet_cheque,
-- zet_pending_receipt, zet_shift, zet_shift_payment, zet_shift_invoice;
-- SELECT, INSERT on zet_report_revision (the archive trigger runs as the
-- calling role, not as a definer, so it needs its own INSERT grant); and
-- SELECT on restaurant and app_user. No such role is created here —
-- provisioning real login roles/passwords belongs in infrastructure
-- tooling, not a committed migration.

-- ── 1. Child-table guards ────────────────────────────────────────────────
-- A session-local flag, set only by the archive trigger below, only for
-- the specific report_id it just archived, only for the rest of the
-- current transaction. Child-table triggers check it before refusing a
-- write to an approved report's children.

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
  IF v_status = 'approved'
     AND coalesce(current_setting('zet.correcting_report_id', true), '') <> p_report_id::text
  THEN
    RAISE EXCEPTION
      'report % is approved; child rows cannot be written outside a correction (update zet_report with revision_no bumped and correction_reason/correction_by set first)',
      p_report_id;
  END IF;
END;
$$;

-- Tables with a direct report_id column.
CREATE OR REPLACE FUNCTION zet_guard_report_id_child()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM zet_assert_report_editable(OLD.report_id);
    RETURN OLD;
  ELSE
    PERFORM zet_assert_report_editable(NEW.report_id);
    RETURN NEW;
  END IF;
END;
$$;

CREATE TRIGGER zet_report_line_guard
  BEFORE INSERT OR UPDATE OR DELETE ON zet_report_line
  FOR EACH ROW EXECUTE FUNCTION zet_guard_report_id_child();

CREATE TRIGGER zet_expense_line_guard
  BEFORE INSERT OR UPDATE OR DELETE ON zet_expense_line
  FOR EACH ROW EXECUTE FUNCTION zet_guard_report_id_child();

CREATE TRIGGER zet_cheque_guard
  BEFORE INSERT OR UPDATE OR DELETE ON zet_cheque
  FOR EACH ROW EXECUTE FUNCTION zet_guard_report_id_child();

CREATE TRIGGER zet_pending_receipt_guard
  BEFORE INSERT OR UPDATE OR DELETE ON zet_pending_receipt
  FOR EACH ROW EXECUTE FUNCTION zet_guard_report_id_child();

CREATE TRIGGER zet_shift_guard
  BEFORE INSERT OR UPDATE OR DELETE ON zet_shift
  FOR EACH ROW EXECUTE FUNCTION zet_guard_report_id_child();

-- zet_report_slot: one hop via report_line_id -> zet_report_line.report_id.
CREATE OR REPLACE FUNCTION zet_guard_slot_child()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_report_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT report_id INTO v_report_id FROM zet_report_line WHERE id = OLD.report_line_id;
    PERFORM zet_assert_report_editable(v_report_id);
    RETURN OLD;
  ELSE
    SELECT report_id INTO v_report_id FROM zet_report_line WHERE id = NEW.report_line_id;
    PERFORM zet_assert_report_editable(v_report_id);
    RETURN NEW;
  END IF;
END;
$$;

CREATE TRIGGER zet_report_slot_guard
  BEFORE INSERT OR UPDATE OR DELETE ON zet_report_slot
  FOR EACH ROW EXECUTE FUNCTION zet_guard_slot_child();

-- zet_shift_payment / zet_shift_invoice: one hop via shift_id -> zet_shift.report_id.
CREATE OR REPLACE FUNCTION zet_guard_shift_child()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_report_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT report_id INTO v_report_id FROM zet_shift WHERE id = OLD.shift_id;
    PERFORM zet_assert_report_editable(v_report_id);
    RETURN OLD;
  ELSE
    SELECT report_id INTO v_report_id FROM zet_shift WHERE id = NEW.shift_id;
    PERFORM zet_assert_report_editable(v_report_id);
    RETURN NEW;
  END IF;
END;
$$;

CREATE TRIGGER zet_shift_payment_guard
  BEFORE INSERT OR UPDATE OR DELETE ON zet_shift_payment
  FOR EACH ROW EXECUTE FUNCTION zet_guard_shift_child();

CREATE TRIGGER zet_shift_invoice_guard
  BEFORE INSERT OR UPDATE OR DELETE ON zet_shift_invoice
  FOR EACH ROW EXECUTE FUNCTION zet_guard_shift_child();

-- Teach the header trigger to open the gate the guards above check for,
-- scoped to exactly the report it just archived, for the rest of this
-- transaction only (set_config's third argument = true means SET LOCAL
-- semantics: gone at COMMIT or ROLLBACK, never leaks to another request).
-- Also switch to the ground-truth snapshot function (SECURITY DEFINER,
-- added below) so the archive is complete even under RLS.
CREATE OR REPLACE FUNCTION zet_report_archive_before_correction()
RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'approved' THEN
    IF NEW.revision_no <= OLD.revision_no THEN
      RAISE EXCEPTION
        'correcting an approved report must increment revision_no (was %, got %)',
        OLD.revision_no, NEW.revision_no;
    END IF;
    IF NEW.correction_reason IS NULL OR btrim(NEW.correction_reason) = '' THEN
      RAISE EXCEPTION 'correcting an approved report requires correction_reason';
    END IF;
    IF NEW.correction_by IS NULL THEN
      RAISE EXCEPTION 'correcting an approved report requires correction_by';
    END IF;

    INSERT INTO zet_report_revision
      (report_id, revision_no, status_at_revision, snapshot, reason, changed_by)
    VALUES
      (OLD.id, OLD.revision_no, OLD.status, zet_report_snapshot(OLD.id),
       NEW.correction_reason, NEW.correction_by);

    PERFORM set_config('zet.correcting_report_id', OLD.id::text, true);

    NEW.correction_reason := NULL;
    NEW.correction_by := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- zet_report_snapshot must see ground truth regardless of the calling
-- session's RLS visibility — it is the audit trail, not a data access path.
CREATE OR REPLACE FUNCTION zet_report_snapshot(p_report_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'report', to_jsonb(r.*),
    'lines', COALESCE((
      SELECT jsonb_agg(to_jsonb(l.*)) FROM zet_report_line l
      WHERE l.report_id = r.id), '[]'::jsonb),
    'slots', COALESCE((
      SELECT jsonb_agg(to_jsonb(s.*)) FROM zet_report_slot s
      JOIN zet_report_line l ON l.id = s.report_line_id
      WHERE l.report_id = r.id), '[]'::jsonb),
    'expenses', COALESCE((
      SELECT jsonb_agg(to_jsonb(e.*)) FROM zet_expense_line e
      WHERE e.report_id = r.id), '[]'::jsonb),
    'cheques', COALESCE((
      SELECT jsonb_agg(to_jsonb(c.*)) FROM zet_cheque c
      WHERE c.report_id = r.id), '[]'::jsonb),
    'pending_receipts', COALESCE((
      SELECT jsonb_agg(to_jsonb(p.*)) FROM zet_pending_receipt p
      WHERE p.report_id = r.id), '[]'::jsonb),
    'shifts', COALESCE((
      SELECT jsonb_agg(to_jsonb(sh.*)) FROM zet_shift sh
      WHERE sh.report_id = r.id), '[]'::jsonb),
    'shift_payments', COALESCE((
      SELECT jsonb_agg(to_jsonb(sp.*)) FROM zet_shift_payment sp
      JOIN zet_shift sh ON sh.id = sp.shift_id
      WHERE sh.report_id = r.id), '[]'::jsonb),
    'shift_invoices', COALESCE((
      SELECT jsonb_agg(to_jsonb(si.*)) FROM zet_shift_invoice si
      JOIN zet_shift sh ON sh.id = si.shift_id
      WHERE sh.report_id = r.id), '[]'::jsonb)
  )
  FROM zet_report r WHERE r.id = p_report_id;
$$;

-- The audit trail itself: append-only, no exceptions.
CREATE OR REPLACE FUNCTION zet_revision_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'zet_report_revision rows are append-only; they cannot be updated or deleted';
END;
$$;

CREATE TRIGGER zet_report_revision_immutable
  BEFORE UPDATE OR DELETE ON zet_report_revision
  FOR EACH ROW EXECUTE FUNCTION zet_revision_immutable();

-- ── 2. Revisions must outlive their report ──────────────────────────────

ALTER TABLE zet_report_revision
  DROP CONSTRAINT zet_report_revision_report_id_fkey;

ALTER TABLE zet_report_revision
  ADD CONSTRAINT zet_report_revision_report_id_fkey
  FOREIGN KEY (report_id) REFERENCES zet_report(id) ON DELETE RESTRICT;

-- ── 3. variance_cents becomes derived, not stored input ─────────────────
-- Postgres cannot ALTER a plain column into a generated one in place;
-- drop and re-add. Nothing depends on its position in the row.

ALTER TABLE zet_report DROP COLUMN variance_cents;

ALTER TABLE zet_report
  ADD COLUMN variance_cents bigint
  GENERATED ALWAYS AS (actual_cents - expected_cents) STORED;

-- ── 4. A read-only role ──────────────────────────────────────────────────

ALTER TYPE restaurant_role ADD VALUE IF NOT EXISTS 'viewer';

-- ── 5. Row-level security ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION zet_current_user_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('zet.user_id', true), '')::uuid;
$$;

-- SECURITY DEFINER breaks the circularity of restaurant_user's own policy
-- querying restaurant_user for membership: this function runs as the
-- table owner, which bypasses RLS by default, so it sees the true
-- membership set rather than a filtered, possibly-empty view of itself.
CREATE OR REPLACE FUNCTION zet_visible_restaurants()
RETURNS SETOF text
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT restaurant_id FROM restaurant_user WHERE user_id = zet_current_user_id();
$$;

ALTER TABLE restaurant_user ENABLE ROW LEVEL SECURITY;
CREATE POLICY restaurant_user_scope ON restaurant_user FOR ALL
  USING (restaurant_id IN (SELECT zet_visible_restaurants()))
  WITH CHECK (restaurant_id IN (SELECT zet_visible_restaurants()));

ALTER TABLE zet_report ENABLE ROW LEVEL SECURITY;
CREATE POLICY zet_report_scope ON zet_report FOR ALL
  USING (restaurant_id IN (SELECT zet_visible_restaurants()))
  WITH CHECK (restaurant_id IN (SELECT zet_visible_restaurants()));

ALTER TABLE zet_report_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY zet_report_line_scope ON zet_report_line FOR ALL
  USING (report_id IN (SELECT id FROM zet_report))
  WITH CHECK (report_id IN (SELECT id FROM zet_report));

ALTER TABLE zet_report_slot ENABLE ROW LEVEL SECURITY;
CREATE POLICY zet_report_slot_scope ON zet_report_slot FOR ALL
  USING (report_line_id IN (SELECT id FROM zet_report_line))
  WITH CHECK (report_line_id IN (SELECT id FROM zet_report_line));

ALTER TABLE zet_expense_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY zet_expense_line_scope ON zet_expense_line FOR ALL
  USING (report_id IN (SELECT id FROM zet_report))
  WITH CHECK (report_id IN (SELECT id FROM zet_report));

ALTER TABLE zet_cheque ENABLE ROW LEVEL SECURITY;
CREATE POLICY zet_cheque_scope ON zet_cheque FOR ALL
  USING (report_id IN (SELECT id FROM zet_report))
  WITH CHECK (report_id IN (SELECT id FROM zet_report));

ALTER TABLE zet_pending_receipt ENABLE ROW LEVEL SECURITY;
CREATE POLICY zet_pending_receipt_scope ON zet_pending_receipt FOR ALL
  USING (report_id IN (SELECT id FROM zet_report))
  WITH CHECK (report_id IN (SELECT id FROM zet_report));

ALTER TABLE zet_shift ENABLE ROW LEVEL SECURITY;
CREATE POLICY zet_shift_scope ON zet_shift FOR ALL
  USING (report_id IN (SELECT id FROM zet_report))
  WITH CHECK (report_id IN (SELECT id FROM zet_report));

ALTER TABLE zet_shift_payment ENABLE ROW LEVEL SECURITY;
CREATE POLICY zet_shift_payment_scope ON zet_shift_payment FOR ALL
  USING (shift_id IN (SELECT id FROM zet_shift))
  WITH CHECK (shift_id IN (SELECT id FROM zet_shift));

ALTER TABLE zet_shift_invoice ENABLE ROW LEVEL SECURITY;
CREATE POLICY zet_shift_invoice_scope ON zet_shift_invoice FOR ALL
  USING (shift_id IN (SELECT id FROM zet_shift))
  WITH CHECK (shift_id IN (SELECT id FROM zet_shift));

ALTER TABLE zet_report_revision ENABLE ROW LEVEL SECURITY;
CREATE POLICY zet_report_revision_scope ON zet_report_revision FOR ALL
  USING (report_id IN (SELECT id FROM zet_report))
  WITH CHECK (report_id IN (SELECT id FROM zet_report));
