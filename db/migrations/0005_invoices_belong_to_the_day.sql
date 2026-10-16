-- Digital ZET — invoices belong to the night, not to a shift.
--
-- The China Spice paper sheet has ONE Invoices block for the whole day.
-- The three receipts on 06/08/26 are written across the shift columns and
-- braced together to a single €52,72; nothing on the sheet says which
-- till paid which one, and the owner confirms it is a day figure.
--
-- The schema said otherwise: zet_shift_invoice hung off zet_shift, which
-- forced the form to ask a question the paper never asks, and made a
-- shift's TOTAL its cash plus "its" invoices.
--
-- ── Why this does not move the reconciled numbers ──────────────────────
--
-- The verified fixture is CHINA SPICE 10/09/26: expected 648,42,
-- accounted 543,40, short 105,02 — the figure circled by hand on that
-- sheet. Only ΒΡΑΔΥ carried figures that night, so shift-level and
-- day-level totals coincide, and the REPORT's stored actual_cents and
-- variance_cents are unchanged by this migration. What changes is a
-- shift's own displayed TOTAL, which now excludes invoices, because the
-- day is where they are settled.
--
-- Existing rows are carried across rather than dropped, renumbered per
-- report so line_no stays dense and unique.

CREATE TABLE zet_report_invoice (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id          uuid NOT NULL REFERENCES zet_report(id) ON DELETE CASCADE,
  line_no            smallint NOT NULL,
  supplier_name      text,
  invoice_number     text,
  amount_cents       bigint NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  receipt_photo_url  text,  -- the join into the AI invoicing project
  invoice_date       date,
  supplier_id        uuid,
  UNIQUE (report_id, line_no),
  CONSTRAINT zet_report_invoice_invoice_date_sane
    CHECK (invoice_date IS NULL OR invoice_date BETWEEN DATE '2000-01-01' AND DATE '2100-01-01')
);

-- Carry the existing rows over, ordered by shift then line so the day's
-- list reads in the order it was entered.
INSERT INTO zet_report_invoice
  (report_id, line_no, supplier_name, invoice_number, amount_cents,
   receipt_photo_url, invoice_date, supplier_id)
SELECT
  sh.report_id,
  (row_number() OVER (PARTITION BY sh.report_id
                      ORDER BY sh.shift_index, si.line_no))::smallint,
  si.supplier_name, si.invoice_number, si.amount_cents,
  si.receipt_photo_url, si.invoice_date, si.supplier_id
FROM zet_shift_invoice si
JOIN zet_shift sh ON sh.id = si.shift_id;

-- Same guard as every other report-keyed child: no writes to an approved
-- report outside the correction protocol.
CREATE TRIGGER zet_report_invoice_guard
  BEFORE INSERT OR UPDATE OR DELETE ON zet_report_invoice
  FOR EACH ROW EXECUTE FUNCTION zet_guard_report_id_child();

ALTER TABLE zet_report_invoice ENABLE ROW LEVEL SECURITY;
CREATE POLICY zet_report_invoice_scope ON zet_report_invoice FOR ALL
  USING (report_id IN (SELECT id FROM zet_report))
  WITH CHECK (report_id IN (SELECT id FROM zet_report));

CREATE INDEX zet_report_invoice_invoice_number_idx
  ON zet_report_invoice (invoice_number)
  WHERE invoice_number IS NOT NULL AND invoice_number <> '';

-- No GRANTs here on purpose: zet_app is created by scripts/db-setup.sh
-- AFTER the migrations run, so granting to it from a migration fails on a
-- fresh database. The grant list there is updated alongside this file.

-- The audit snapshot must see the new table, or a correction would record
-- a night's invoices as absent and the trail would lie about what was
-- changed. Rebuilt whole rather than patched, because this function is
-- ground truth for every revision.
CREATE OR REPLACE FUNCTION zet_report_snapshot(p_report_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
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
    'report_invoices', COALESCE((
      SELECT jsonb_agg(to_jsonb(ri.*)) FROM zet_report_invoice ri
      WHERE ri.report_id = r.id), '[]'::jsonb)
  )
  FROM zet_report r WHERE r.id = p_report_id;
$$;

-- Dropped only after the rows are copied and the snapshot no longer reads
-- it. Revisions already written keep their own 'shift_invoices' key — that
-- is stored JSON describing what the sheet looked like then, and it stays
-- true of that moment.
DROP TABLE zet_shift_invoice;
