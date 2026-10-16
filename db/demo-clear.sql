-- Removes the demo data written by db/demo.sql, and nothing else.
--
-- Scoped hard to 2026-08-01..2026-08-31. Anything you filed yourself in
-- another month is untouched.
--
-- Why this needs to disable triggers, and why that is not a loophole:
--
-- An approved report is meant to be permanent. The child-row guard
-- (migration 0002/0003) refuses writes to its lines, a cascade delete
-- fires that same guard, and correcting one archives a revision that the
-- foreign key then refuses to let you delete. That is the audit trail
-- doing its job — you should not be able to make a night's takings
-- disappear.
--
-- Demo data is the one case where that is inconvenient rather than
-- correct, so this runs as the table owner and turns the guards off for
-- the length of one transaction. It is a development convenience and has
-- no path into the application: the app connects as zet_app, which owns
-- nothing and cannot ALTER TABLE.
--
-- If this ever seems like the way to fix a real mistake — it is not. A
-- wrong figure on an approved night is corrected with a new revision,
-- which is the entire point of the revisions table.

BEGIN;

ALTER TABLE zet_report_line      DISABLE TRIGGER USER;
ALTER TABLE zet_report_slot      DISABLE TRIGGER USER;
ALTER TABLE zet_expense_line     DISABLE TRIGGER USER;
ALTER TABLE zet_cheque           DISABLE TRIGGER USER;
ALTER TABLE zet_pending_receipt  DISABLE TRIGGER USER;
ALTER TABLE zet_shift            DISABLE TRIGGER USER;
ALTER TABLE zet_shift_payment    DISABLE TRIGGER USER;
ALTER TABLE zet_report_invoice   DISABLE TRIGGER USER;
ALTER TABLE zet_report           DISABLE TRIGGER USER;

DELETE FROM zet_report_revision
 WHERE report_id IN (
   SELECT id FROM zet_report
    WHERE business_date BETWEEN '2026-08-01' AND '2026-08-31'
 );

DELETE FROM zet_report
 WHERE business_date BETWEEN '2026-08-01' AND '2026-08-31';

ALTER TABLE zet_report           ENABLE TRIGGER USER;
ALTER TABLE zet_report_invoice   ENABLE TRIGGER USER;
ALTER TABLE zet_shift_payment    ENABLE TRIGGER USER;
ALTER TABLE zet_shift            ENABLE TRIGGER USER;
ALTER TABLE zet_pending_receipt  ENABLE TRIGGER USER;
ALTER TABLE zet_cheque           ENABLE TRIGGER USER;
ALTER TABLE zet_expense_line     ENABLE TRIGGER USER;
ALTER TABLE zet_report_slot      ENABLE TRIGGER USER;
ALTER TABLE zet_report_line      ENABLE TRIGGER USER;

COMMIT;

SELECT 'remaining demo rows: ' || count(*)
  FROM zet_report
 WHERE business_date BETWEEN '2026-08-01' AND '2026-08-31';
