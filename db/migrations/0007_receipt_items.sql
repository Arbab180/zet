-- Digital ZET — the items on a receipt.
--
-- The scan now reads what was bought as well as what it cost in total:
-- each line's name, quantity and line amount. The manager can correct
-- them. They are stored with the receipt's own row so the archive shows
-- them and the invoicing project can use them later.
--
-- ── Why a jsonb column and not a table ──────────────────────────────────
--
-- The items are a breakdown OF one receipt line. They are written and
-- replaced together with it, never queried across reports by this app,
-- and never enter the night's arithmetic — that reconciles against the
-- line's amount_cents, which a person confirms. As a column they inherit
-- everything the row already has, with nothing new to get wrong:
--
--   - row-level security: the row's own policy
--   - the approved-report guard: the row's own trigger
--   - the audit trail: zet_report_snapshot() captures child rows with
--     to_jsonb(e.*) and to_jsonb(ri.*), so the column enters every
--     revision automatically (see the note at the end of 0004)
--   - grants: table-level, already given to zet_app
--
-- A separate table would have needed all four again, and the invoicing
-- project can still read items with jsonb_array_elements().
--
-- Shape, enforced by the server (src/lib/receiptItems.ts):
--   [{"name": text, "qty": text, "amount_cents": integer >= 0}, …]
-- NULL means "no items", which is every row before this migration and
-- every receipt nobody scanned.

ALTER TABLE zet_expense_line
  ADD COLUMN receipt_items jsonb,
  ADD CONSTRAINT zet_expense_line_receipt_items_is_list
    CHECK (receipt_items IS NULL OR jsonb_typeof(receipt_items) = 'array');

ALTER TABLE zet_report_invoice
  ADD COLUMN receipt_items jsonb,
  ADD CONSTRAINT zet_report_invoice_receipt_items_is_list
    CHECK (receipt_items IS NULL OR jsonb_typeof(receipt_items) = 'array');
