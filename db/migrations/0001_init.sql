-- Digital ZET — initial schema
--
-- Plain SQL: no migration runner is wired up yet (package.json has none).
-- Run directly with `psql -f` or adapt into whichever runner gets chosen
-- later; nothing here is runner-specific.
--
-- Source: docs/SPEC.md §6 (security/schema rules) and
-- docs/zet-daily-report-schema.md (storage sketch, §6). Where the schema
-- doc's validation table (§5) and SPEC.md §5 disagreed, SPEC.md won: this
-- migration does not encode the doc's amount ceilings, date-range checks,
-- or "complete cheque/receipt/expense line" requirements. Money is bigint
-- cents everywhere; no upper bound on any amount, per CLAUDE.md.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Restaurants & authorisation ─────────────────────────────────────────
-- id matches src/lib/forms.ts FormId ('anamma' | 'chop_engomi' |
-- 'chop_pindarou' | 'china_spice'). Four known restaurants tied to a static
-- TypeScript config, not a growing set — a surrogate UUID would just be an
-- extra join to the thing that already identifies them.

CREATE TABLE restaurant (
  id            text PRIMARY KEY,
  legal_name    text NOT NULL,
  display_name  text NOT NULL,
  layout        text NOT NULL CHECK (layout IN ('ledger', 'shifts')),
  form_ref      text,
  timezone      text NOT NULL DEFAULT 'Asia/Nicosia',
  active        boolean NOT NULL DEFAULT true
);

CREATE TABLE app_user (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE restaurant_role AS ENUM ('staff', 'manager', 'admin');

-- The authorisation table. CLAUDE.md rule 3: every request re-checks this,
-- not just at login — a row existing here is necessary but any given
-- request must still look it up, not cache "logged in as manager" once.
CREATE TABLE restaurant_user (
  restaurant_id  text NOT NULL REFERENCES restaurant(id),
  user_id        uuid NOT NULL REFERENCES app_user(id),
  role           restaurant_role NOT NULL,
  PRIMARY KEY (restaurant_id, user_id)
);

-- ── Report header ────────────────────────────────────────────────────────

CREATE TYPE report_status AS ENUM ('draft', 'submitted', 'approved', 'rejected');

CREATE TABLE zet_report (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id     text NOT NULL REFERENCES restaurant(id),
  business_date     date NOT NULL,  -- the trading day, not created_at's date
  status            report_status NOT NULL DEFAULT 'draft',
  revision_no       int NOT NULL DEFAULT 1,

  -- Denormalised totals. Always server-recomputed from the raw rows below
  -- via src/lib/compute.ts — never a value the client posted.
  -- actual_cents: ledger layout = cash counted into the envelope;
  --               shifts layout = cash + invoices accounted for out of the till.
  -- variance_cents = actual_cents - expected_cents; negative = a shortage,
  -- in both layouts (see "two decisions" note on the shifts sign flip).
  expected_cents    bigint NOT NULL DEFAULT 0,
  actual_cents      bigint NOT NULL DEFAULT 0,
  variance_cents    bigint NOT NULL DEFAULT 0,

  -- Required before submit per SPEC.md §5, but NOT NULL at the DB level
  -- would block saving an incomplete draft — that gate belongs at the
  -- Zod/server-action boundary, not here.
  closing_manager_name  text,
  signature_url         text,
  source_photo_url      text,

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid NOT NULL REFERENCES app_user(id),
  submitted_at   timestamptz,
  approved_at    timestamptz,
  approved_by    uuid REFERENCES app_user(id),

  -- Transient correction fields. Set together, in the same UPDATE, only
  -- when correcting an already-approved report; see the trigger below.
  -- Never persist past that one UPDATE.
  correction_reason  text,
  correction_by      uuid REFERENCES app_user(id),

  UNIQUE (restaurant_id, business_date)
);

CREATE INDEX zet_report_restaurant_date_idx
  ON zet_report (restaurant_id, business_date DESC);

-- ── Ledger layout (ΑΝΑΜΜΑ + both Chopsticks) ────────────────────────────
-- One row per input row in the restaurant's src/lib/forms.ts config
-- (gross, card1, card2, FOODY, B3, WOLT, BOLT, cheques, pending, the
-- Chopsticks hand-labelled row, …). row_key matches LedgerRow.key —
-- identified by that key, not by parsing the label, per CLAUDE.md rule 6.

CREATE TABLE zet_report_line (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id      uuid NOT NULL REFERENCES zet_report(id) ON DELETE CASCADE,
  row_key        text NOT NULL,
  label_override text,  -- Chopsticks' printed-but-blank row staff write "Kiosk" etc. into
  amount_cents   bigint NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  UNIQUE (report_id, row_key)
);

-- The α)…ε) / α)…ζ) order sub-slots (FOODY, B3, WOLT). Never required to
-- sum to the row total — SPEC.md §5 explicitly leaves that unenforced.
CREATE TABLE zet_report_slot (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_line_id  uuid NOT NULL REFERENCES zet_report_line(id) ON DELETE CASCADE,
  slot_index      smallint NOT NULL,
  amount_cents    bigint NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  UNIQUE (report_line_id, slot_index)
);

CREATE TABLE zet_expense_line (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id          uuid NOT NULL REFERENCES zet_report(id) ON DELETE CASCADE,
  line_no            smallint NOT NULL,
  description        text,  -- nullable: SPEC.md §5 does not require complete lines
  amount_cents       bigint NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  receipt_photo_url  text,  -- the join into the AI invoicing project
  supplier_id        uuid,
  category_id        uuid,
  UNIQUE (report_id, line_no)
);

CREATE TABLE zet_cheque (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id      uuid NOT NULL REFERENCES zet_report(id) ON DELETE CASCADE,
  amount_cents   bigint NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  customer_name  text,
  customer_phone text,
  cheque_number  text,
  bank           text,
  photo_url      text
);

CREATE TABLE zet_pending_receipt (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id          uuid NOT NULL REFERENCES zet_report(id) ON DELETE CASCADE,
  amount_cents       bigint NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  organisation_name  text,
  contact_person     text,
  contact_phone      text,
  receipt_number     text,
  photo_url          text,
  settled_at         timestamptz
);

-- ── Shifts layout (CHINA SPICE) ─────────────────────────────────────────

CREATE TABLE zet_shift (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id      uuid NOT NULL REFERENCES zet_report(id) ON DELETE CASCADE,
  shift_index    smallint NOT NULL CHECK (shift_index IN (0, 1, 2)),
  label          text NOT NULL,  -- 'ΜΕΣΗΜΕΡΙ' | 'ΒΡΑΔΥ' | 'ΒΡΑΔΥ'
  dine_in_cents  bigint NOT NULL DEFAULT 0 CHECK (dine_in_cents >= 0),
  ta_cents       bigint NOT NULL DEFAULT 0 CHECK (ta_cents >= 0),
  total_cents    bigint NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  UNIQUE (report_id, shift_index)
);

CREATE TABLE zet_shift_payment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id      uuid NOT NULL REFERENCES zet_shift(id) ON DELETE CASCADE,
  method_key    text NOT NULL,  -- matches ShiftsForm.methods[].key (CASH, JCC, GAP, ...)
  amount_cents  bigint NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  UNIQUE (shift_id, method_key)
);

CREATE TABLE zet_shift_invoice (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id           uuid NOT NULL REFERENCES zet_shift(id) ON DELETE CASCADE,
  line_no            smallint NOT NULL,
  supplier_name      text,
  invoice_number     text,
  amount_cents       bigint NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  receipt_photo_url  text,
  supplier_id        uuid,
  UNIQUE (shift_id, line_no)
);

-- ── Revisions ────────────────────────────────────────────────────────────
-- Approved reports are immutable; corrections are a new revision, never an
-- in-place edit (SPEC.md §6 rule 4). zet_report stays a single row per
-- (restaurant_id, business_date) rather than an append-only chain — see the
-- "two decisions" note — and a trigger enforces the archival instead of
-- trusting every caller to remember it.

CREATE TABLE zet_report_revision (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id          uuid NOT NULL REFERENCES zet_report(id) ON DELETE CASCADE,
  revision_no        int NOT NULL,
  status_at_revision report_status NOT NULL,
  snapshot           jsonb NOT NULL,  -- full report + every child row, as they were
  reason             text NOT NULL,
  changed_by         uuid NOT NULL REFERENCES app_user(id),
  changed_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (report_id, revision_no)
);

-- Aggregates a report and all of its child rows into one document. Called
-- from the archive trigger below, and safe to call directly for exports.
CREATE OR REPLACE FUNCTION zet_report_snapshot(p_report_id uuid)
RETURNS jsonb AS $$
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
$$ LANGUAGE sql STABLE;

-- Fires on every UPDATE to zet_report. When the row being changed was
-- 'approved', it refuses the update unless the caller bumped revision_no
-- and supplied correction_reason + correction_by, then archives the
-- pre-correction snapshot before letting the update through.
--
-- Contract this relies on: a correction transaction must UPDATE zet_report
-- (with the bump + correction fields) BEFORE it updates any child row
-- (zet_report_line, zet_expense_line, zet_shift, ...). The snapshot is
-- taken at that moment, so child-row edits made afterwards in the same
-- transaction are correctly excluded from the archived "before" state.
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

    NEW.correction_reason := NULL;
    NEW.correction_by := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER zet_report_before_update
  BEFORE UPDATE ON zet_report
  FOR EACH ROW
  EXECUTE FUNCTION zet_report_archive_before_correction();
