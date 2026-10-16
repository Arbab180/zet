-- Development seed: the six restaurants, one admin, and that admin's
-- membership of all six. Restaurant logins are NOT seeded: the admin
-- creates them on the /accounts page, so no password is ever in the repo.
--
-- Restaurant ids are the FormId values in src/lib/forms.ts. They are the
-- primary key (migration 0001 chose a natural key over a surrogate uuid
-- precisely because these ids are fixed TypeScript config, not a
-- growing set), so these rows MUST match that file or every save fails
-- with unknown_restaurant.
--
-- Idempotent: safe to re-run. It never overwrites an existing admin's id,
-- so re-seeding does not invalidate the ADMIN_USER_ID already in
-- .env.local.

INSERT INTO restaurant (id, legal_name, display_name, layout, form_ref) VALUES
  ('anamma',        'C.A. China Spice Restaurants LTD', 'ΤΟ ΑΝΑΜΜΑ · Λήδρας 87',       'ledger', 'ΕΝΤΥΠΟ Τ ΑΝΑΜΜΑ-01_ΧΑ/γμ'),
  ('chop_engomi',   'C.A. China Spice Restaurants LTD', 'CHOPSTICKS · Mall of Engomi', 'ledger', 'ΕΝΤΥΠΟ Τ-ΒΜΒ-01_ΧΑ/γμ'),
  ('chop_pindarou', 'C.A. China Spice Restaurants LTD', 'CHOPSTICKS · Πινδάρου 26',    'ledger', 'ΕΝΤΥΠΟ Τ-ΒΜΒ-01_ΧΑ/γμ'),
  ('chop_cyprus',   'C.A. China Spice Restaurants LTD', 'CHOPSTICKS · Mall of Cyprus', 'ledger', 'ΕΝΤΥΠΟ Τ-ΒΜΒ-01_ΧΑ/γμ'),
  ('chop_lakatamia','C.A. China Spice Restaurants LTD', 'CHOPSTICKS · Lakatamia',      'ledger', 'ΕΝΤΥΠΟ Τ-ΒΜΒ-01_ΧΑ/γμ'),
  ('china_spice',   'C.A. China Spice Restaurants LTD', 'CHINASPICE@MONTPARNASSE',     'shifts', NULL)
ON CONFLICT (id) DO UPDATE
  SET legal_name = EXCLUDED.legal_name,
      display_name = EXCLUDED.display_name,
      layout = EXCLUDED.layout,
      form_ref = EXCLUDED.form_ref;

-- The admin. Its uuid is generated on FIRST seed only and then reused, so
-- the ADMIN_USER_ID in .env.local keeps working across re-runs.
INSERT INTO app_user (email, name)
VALUES ('admin@chinaspice.local', 'Admin')
ON CONFLICT (email) DO NOTHING;

-- Only the admin may create restaurant logins (migration 0008). Set here as
-- well as in that migration so a fresh database gets it either way.
UPDATE app_user SET is_admin = true WHERE email = 'admin@chinaspice.local';

INSERT INTO restaurant_user (restaurant_id, user_id, role)
SELECT r.id, u.id, 'admin'
  FROM restaurant r
  CROSS JOIN app_user u
 WHERE u.email = 'admin@chinaspice.local'
ON CONFLICT (restaurant_id, user_id) DO UPDATE SET role = 'admin';

-- Printed by db-setup.sh straight into .env.local.
SELECT id AS admin_user_id FROM app_user WHERE email = 'admin@chinaspice.local';
