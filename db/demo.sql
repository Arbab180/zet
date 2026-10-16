-- Demo data, for looking at the screens with something in them.
--
-- SAFETY: every row it writes is inside 2026-08-01 .. 2026-08-31, and
-- db/demo-clear.sql removes exactly that range. Nothing you file yourself
-- in September is touched.
--
-- This writes rows DIRECTLY rather than going through
-- src/server/saveReport.ts, so treat it as something to look at, not as
-- evidence the save path works. That path is covered by its own tests.
--
-- What it makes, across the four restaurants:
--   - nights that balance exactly, approved
--   - nights that balance, filed but not yet approved
--   - nights where the counted cash is out by more than €0,50  -> flagged
--   - a night where FOODY's itemised orders do not sum to its total -> flagged
--   - one shifts sheet for CHINA SPICE, short the way the real one was

DO $$
DECLARE
  v_admin   uuid;
  v_report  uuid;
  v_line    uuid;
  d         date;
  v_gross   bigint;
  v_card1   bigint;
  v_card2   bigint;
  v_foody   bigint;
  v_wolt    bigint;
  v_expense bigint;
  v_expected bigint;
  v_counted bigint;
  v_status  report_status;
  r         record;
  i         int;
BEGIN
  SELECT id INTO v_admin FROM app_user WHERE email = 'admin@chinaspice.local';
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'No admin user — run scripts/db-setup.sh first.';
  END IF;

  -- ── Ledger restaurants ───────────────────────────────────────────────
  FOR r IN
    SELECT * FROM (VALUES
      -- restaurant,      date,          gross,  card1,  card2, foody, wolt, expenses, counted_offset, status
      ('anamma',        '2026-08-03'::date, 216500, 164033, 0,     8480,  3180, 0,      0,     'approved'),
      ('anamma',        '2026-08-04'::date, 198450, 141200, 0,     9260,  4110, 2350,   0,     'approved'),
      ('anamma',        '2026-08-05'::date, 231780, 172940, 0,    10340,  5280, 0,   -1240,    'submitted'),
      ('anamma',        '2026-08-06'::date, 187600, 130450, 0,     7720,  2990, 1580,   0,     'approved'),
      ('anamma',        '2026-08-07'::date, 245310, 181070, 0,    11450,  6120, 3200,   85,    'submitted'),
      ('anamma',        '2026-08-10'::date, 203900, 149800, 0,     8890,  3450, 0,      0,     'submitted'),
      ('chop_engomi',   '2026-08-03'::date,  74004,  18084, 21498, 13073, 0,    430,    0,     'approved'),
      ('chop_engomi',   '2026-08-04'::date,  81250,  22410, 19870, 14200, 0,    0,   -2075,    'submitted'),
      ('chop_engomi',   '2026-08-05'::date,  69800,  17250, 18900, 11450, 0,    890,    0,     'approved'),
      ('chop_pindarou', '2026-08-03'::date,  76336,  51770, 0,     12775, 0,    0,      0,     'approved'),
      ('chop_pindarou', '2026-08-04'::date,  82140,  55320, 0,     14080, 0,    1250,   0,     'submitted')
    ) AS t(restaurant, d, gross, card1, card2, foody, wolt, expenses, offset_c, status)
  LOOP
    v_gross := r.gross; v_card1 := r.card1; v_card2 := r.card2;
    v_foody := r.foody; v_wolt := r.wolt;   v_expense := r.expenses;
    v_expected := v_gross - v_card1 - v_card2 - v_foody - v_wolt - v_expense;
    v_counted  := v_expected + r.offset_c;
    d := r.d;

    -- Always inserted as 'draft' first: the child-row guard refuses writes
    -- to an approved report, so an approved one must be built and only then
    -- promoted. Exactly what the real save path does.
    INSERT INTO zet_report (restaurant_id, business_date, status, expected_cents,
                            actual_cents, closing_manager_name, created_by)
    VALUES (r.restaurant, d, 'draft', v_expected, v_counted,
            (ARRAY['Μανώλης','Ανδρέας','Γιώργος'])[1 + (extract(day from d)::int % 3)], v_admin)
    RETURNING id INTO v_report;

    INSERT INTO zet_report_line (report_id, row_key, amount_cents) VALUES
      (v_report, 'gross', v_gross),
      (v_report, 'card1', v_card1),
      (v_report, 'card2', v_card2),
      (v_report, 'B3', 0),
      (v_report, 'WOLT', v_wolt),
      (v_report, 'BOLT', 0),
      (v_report, 'cheques', 0),
      (v_report, 'pending', 0);

    INSERT INTO zet_report_line (report_id, row_key, amount_cents)
    VALUES (v_report, 'FOODY', v_foody) RETURNING id INTO v_line;

    -- Itemised FOODY orders. On 05/08 at ΑΝΑΜΜΑ they deliberately do NOT
    -- add up to the total — a cancelled order recorded as successful is
    -- exactly how that happens in real life.
    IF v_foody > 0 THEN
      IF r.restaurant = 'anamma' AND d = '2026-08-05'::date THEN
        INSERT INTO zet_report_slot (report_line_id, slot_index, amount_cents) VALUES
          (v_line, 0, 2140), (v_line, 1, 3180), (v_line, 2, 1890), (v_line, 3, 2820);
      ELSE
        INSERT INTO zet_report_slot (report_line_id, slot_index, amount_cents) VALUES
          (v_line, 0, (v_foody / 4)),
          (v_line, 1, (v_foody / 4)),
          (v_line, 2, (v_foody / 4)),
          (v_line, 3, v_foody - 3 * (v_foody / 4));
      END IF;
    END IF;

    IF v_expense > 0 THEN
      INSERT INTO zet_expense_line (report_id, line_no, description, amount_cents) VALUES
        (v_report, 1, 'ΣΚΛΑΒΕΝΙΤΗΣ', (v_expense / 2)),
        (v_report, 2, 'Καθαριστικά',  v_expense - (v_expense / 2));
    END IF;

    v_status := r.status::report_status;
    IF v_status = 'approved' THEN
      UPDATE zet_report
         SET status = 'approved', submitted_at = d + time '23:30',
             approved_at = d + time '23:45', approved_by = v_admin
       WHERE id = v_report;
    ELSE
      UPDATE zet_report
         SET status = 'submitted', submitted_at = d + time '23:30'
       WHERE id = v_report;
    END IF;
  END LOOP;

  -- ── CHINA SPICE, shifts ──────────────────────────────────────────────
  FOR i IN 0..2 LOOP
    d := '2026-08-03'::date + i;
    -- Evening column, modelled on the real 10/09 sheet: short by 105,02 on
    -- the first night, balanced on the others.
    v_expected := 64842;
    v_counted  := CASE WHEN i = 0 THEN 54340 ELSE 64842 END;

    INSERT INTO zet_report (restaurant_id, business_date, status, expected_cents,
                            actual_cents, closing_manager_name, created_by)
    VALUES ('china_spice', d, 'draft', v_expected, v_counted, 'Μανώλης', v_admin)
    RETURNING id INTO v_report;

    INSERT INTO zet_shift (report_id, shift_index, label, dine_in_cents, ta_cents, total_cents)
    VALUES (v_report, 1, 'ΒΡΑΔΥ', 0, 0, 259290)
    RETURNING id INTO v_line;

    INSERT INTO zet_shift_payment (shift_id, method_key, amount_cents) VALUES
      (v_line, 'CASH', CASE WHEN i = 0 THEN 40800 ELSE 51302 END),
      (v_line, 'JCC', 143758), (v_line, 'GAP', 0), (v_line, 'FOODY', 25180),
      (v_line, 'B3', 0), (v_line, 'STRIPE', 0), (v_line, 'WOLT', 25510),
      (v_line, 'BOLT', 0), (v_line, 'SKASH', 0), (v_line, 'OTHER', 0);

    -- Invoices belong to the night, not the shift (migration 0005), so
    -- these attach to the report and are inserted once per night rather
    -- than once per shift column.
    INSERT INTO zet_report_invoice (report_id, line_no, supplier_name, invoice_number, amount_cents) VALUES
      (v_report, 1, 'SKLAVENITIS', '01/601277', 540),
      (v_report, 2, 'A.SAVVIDES TYRES', 'ES266231', 13000)
    ON CONFLICT (report_id, line_no) DO NOTHING;

    UPDATE zet_report
       SET status = CASE WHEN i = 0 THEN 'submitted' ELSE 'approved' END::report_status,
           submitted_at = d + time '23:30',
           approved_at = CASE WHEN i > 0 THEN d + time '23:45' END,
           approved_by = CASE WHEN i > 0 THEN v_admin END
     WHERE id = v_report;
  END LOOP;

  RAISE NOTICE 'Demo data written for 2026-08-01..2026-08-31.';
END
$$;

SELECT restaurant_id,
       count(*) AS nights,
       count(*) FILTER (WHERE abs(variance_cents) >= 50) AS flagged,
       count(*) FILTER (WHERE status = 'approved')       AS approved
  FROM zet_report
 WHERE business_date BETWEEN '2026-08-01' AND '2026-08-31'
 GROUP BY restaurant_id
 ORDER BY restaurant_id;
