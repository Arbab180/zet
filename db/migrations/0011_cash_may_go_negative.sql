-- Digital ZET — the envelope cash may go below zero.
--
-- Some nights the till pays out more than it took in, and the shortfall
-- is made up at the next close-out (Arbab, 30/10/2026). On the ledger
-- sheets the envelope cash is stored only as zet_report.actual_cents,
-- which has no sign check, so nothing changes there. On China Spice it is
-- the CASH payment row of each shift, in zet_shift_payment, whose
-- amount_cents was CHECK (amount_cents >= 0).
--
-- Only CASH may go negative. Every other payment (cards, platforms, named
-- lines) stays at zero or above: a negative card batch is a typing
-- mistake, not a real night.

BEGIN;

-- First statement on purpose: re-running this file fails here with
-- "already exists", which db-setup.sh / db-deploy.sh read as "applied".
ALTER TABLE zet_shift_payment
  ADD CONSTRAINT zet_shift_payment_amount_sign
  CHECK (amount_cents >= 0 OR method_key = 'CASH');

-- Drop the old non-negative check by what it says, not by its generated
-- name, so a database where Postgres named it differently is still fixed.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'zet_shift_payment'::regclass
       AND contype = 'c'
       AND conname <> 'zet_shift_payment_amount_sign'
       AND pg_get_constraintdef(oid) ILIKE '%amount_cents >= 0%'
  LOOP
    EXECUTE format('ALTER TABLE zet_shift_payment DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

COMMIT;
