-- Digital ZET — the Dine in and T/A boxes may hold words.
--
-- On the paper these two boxes are a note as often as a figure: a manager
-- writes what the split was, or who took it, not always a number. The
-- schema allowed only cents, and the form stripped every letter as it was
-- typed (sanitizeAmountInput), so there was no way to write one — and a
-- payload carrying words was refused outright with «Μόνο αριθμοί».
--
-- ── Why this is safe for the reconciliation ───────────────────────────
--
-- Dine in and T/A feed NOTHING in the cash arithmetic. ΤΑΜΕΙΟ Total is
-- the figure the night reconciles against; these two only drive the
-- "Dine in + T/A do not add up to Total" hint. So a box holding a note
-- costs the hint for that column and nothing else, and the hint is
-- suppressed rather than computed against a 0 that was never a figure.
--
-- ── One box, one meaning ──────────────────────────────────────────────
--
-- A box is a figure or a note, never both pulled apart. "ΝΙΜΑ 52,20" is
-- stored whole in the note column with cents left at 0, rather than
-- having 52,20 guessed out of it. Picking a number out of free text is
-- wrong silently, and there is no arithmetic here that would benefit.
--
-- Existing rows are untouched: every stored night so far held figures,
-- which keep their cents and get an empty note.

ALTER TABLE zet_shift
  ADD COLUMN dine_in_note text NOT NULL DEFAULT '',
  ADD COLUMN ta_note      text NOT NULL DEFAULT '';

-- Cents and note are alternatives, not a pair. Allowing both at once
-- would let a later change start storing a parsed figure beside the text
-- it came from, and then two places would disagree about the same box.
ALTER TABLE zet_shift
  ADD CONSTRAINT zet_shift_dine_in_one_or_other
    CHECK (dine_in_note = '' OR dine_in_cents = 0),
  ADD CONSTRAINT zet_shift_ta_one_or_other
    CHECK (ta_note = '' OR ta_cents = 0);
