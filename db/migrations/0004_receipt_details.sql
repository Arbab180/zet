-- Digital ZET — carry the supplier, invoice number and date off the receipt.
--
-- Scanning a receipt photo now reads four useful things: the amount, the
-- supplier, the invoice number and the date. Only the amount had anywhere
-- to go on a ledger form, and the date had nowhere to go on either form,
-- so three quarters of what the scanner reads was being discarded at the
-- point of saving.
--
-- Those three together are also the join into the AI invoicing project.
-- An amount alone cannot be matched to a supplier's invoice; supplier plus
-- invoice number plus date can.
--
-- zet_shift_invoice already had supplier_name and invoice_number, because
-- the China Spice paper sheet has columns for them. zet_expense_line had
-- neither: the paper ledger has one free-text description line, which is
-- why `description` exists and stays — what was bought is not the same
-- fact as who sold it, and people do write both.
--
-- Everything here is nullable. A receipt line may be a scribbled amount
-- with no paperwork at all, which is normal at 1am and must keep saving.

ALTER TABLE zet_expense_line
  ADD COLUMN supplier_name   text,
  ADD COLUMN invoice_number  text,
  ADD COLUMN invoice_date    date;

ALTER TABLE zet_shift_invoice
  ADD COLUMN invoice_date    date;

-- A loose sanity range, not a business rule.
--
-- The date is frequently machine-read from a photograph, and the failure
-- worth catching is a gross misread — a year of 1970 or 2126 from a
-- smudged digit — not a supplier invoice that is legitimately a few months
-- old. Anything tighter (say, "near the business date") belongs in the
-- flagging policy where a human can overrule it, not in a constraint that
-- refuses the save outright.
ALTER TABLE zet_expense_line
  ADD CONSTRAINT zet_expense_line_invoice_date_sane
  CHECK (invoice_date IS NULL OR invoice_date BETWEEN DATE '2000-01-01' AND DATE '2100-01-01');

ALTER TABLE zet_shift_invoice
  ADD CONSTRAINT zet_shift_invoice_invoice_date_sane
  CHECK (invoice_date IS NULL OR invoice_date BETWEEN DATE '2000-01-01' AND DATE '2100-01-01');

-- Partial indexes: the invoicing project will look receipts up BY invoice
-- number, and most lines never have one, so indexing only the rows that do
-- keeps these small.
CREATE INDEX zet_expense_line_invoice_number_idx
  ON zet_expense_line (invoice_number)
  WHERE invoice_number IS NOT NULL AND invoice_number <> '';

CREATE INDEX zet_shift_invoice_invoice_number_idx
  ON zet_shift_invoice (invoice_number)
  WHERE invoice_number IS NOT NULL AND invoice_number <> '';

-- No change is needed to zet_report_snapshot(): it captures child rows with
-- to_jsonb(e.*), so new columns enter the audit trail automatically. Worth
-- stating because the opposite — a snapshot listing columns by name — would
-- have silently kept recording the old shape, and a revision that omits a
-- corrected field is an audit trail that lies.
