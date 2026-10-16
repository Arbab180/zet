-- Digital ZET — card machines per restaurant.
--
-- A restaurant can take cards on more than one terminal, and the managers
-- want each terminal's batch on its own line (09/10/2026). The admin names
-- them per restaurant on the Accounts page; the nightly sheet then splits
-- the card row into one box per machine and adds them up.
--
-- What the sheet does with the list lives in src/lib/cardMachines.ts. This
-- file only stores it.
--
-- A machine is identified by its id, not its name: the night's figure is
-- stored under the row key CARD_<id>, so renaming a machine keeps every
-- night already filed under it. Removing one RETIRES it (retired_at) rather
-- than deleting the row, for the same reason the sheet configs retire rows
-- instead of deleting them: a night filed under it must still show it.
--
-- The app may read the list (the sheet needs it) but never write it. The
-- only writer is zet_admin_save_card_machines, which checks inside the
-- database that the caller is an admin — the same arrangement as the
-- logins in 0008.
--
--   ZET04  caller is not an admin
--   ZET05  bad input (unknown restaurant, a machine of another restaurant,
--          two machines with one name, too many machines)

BEGIN;

-- First statement on purpose: re-running this file fails here with
-- "already exists", which db-setup.sh / db-deploy.sh read as "applied".
CREATE TABLE card_machine (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  text NOT NULL REFERENCES restaurant(id),
  -- 24 matches MAX_CUSTOM_LABEL: it has to fit the label column of the
  -- sheet on a 320px phone.
  label          text NOT NULL
                 CHECK (label = btrim(label) AND char_length(label) BETWEEN 1 AND 24),
  position       int  NOT NULL DEFAULT 0,
  retired_at     timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES app_user(id)
);

CREATE INDEX card_machine_restaurant ON card_machine (restaurant_id, position);

-- Owner-only by default; db/app-role.sql grants SELECT and nothing more.
REVOKE ALL ON card_machine FROM PUBLIC;

-- Replaces the restaurant's ACTIVE list with exactly the one given, in
-- that order. p_ids[i] is the machine being kept or renamed, or NULL for a
-- new one. An active machine missing from the list is retired.
--
-- A new name that matches a retired machine of the same restaurant brings
-- that machine back rather than creating a second one, so taking a machine
-- off and putting it back does not split its nights over two keys.
CREATE FUNCTION zet_admin_save_card_machines(
  p_restaurant_id text,
  p_ids           bigint[],
  p_labels        text[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user  uuid := zet_current_user_id();
  v_n     int  := coalesce(array_length(p_labels, 1), 0);
  v_id    bigint;
  v_label text;
BEGIN
  IF NOT zet_caller_is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = 'ZET04', MESSAGE = 'only an admin can change card machines';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM restaurant WHERE id = p_restaurant_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZET05',
      MESSAGE = format('unknown restaurant %s', p_restaurant_id);
  END IF;
  IF coalesce(array_length(p_ids, 1), 0) <> v_n THEN
    RAISE EXCEPTION USING ERRCODE = 'ZET05', MESSAGE = 'ids and labels differ in length';
  END IF;
  IF v_n > 8 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZET05', MESSAGE = 'at most 8 card machines';
  END IF;
  IF (SELECT count(DISTINCT lower(l)) FROM unnest(p_labels) l) <> v_n THEN
    RAISE EXCEPTION USING ERRCODE = 'ZET05', MESSAGE = 'two card machines with one name';
  END IF;
  IF (SELECT count(DISTINCT i) FROM unnest(p_ids) i WHERE i IS NOT NULL)
     <> (SELECT count(*) FROM unnest(p_ids) i WHERE i IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZET05', MESSAGE = 'one card machine listed twice';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(p_ids) i
     WHERE i IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM card_machine m
                        WHERE m.id = i AND m.restaurant_id = p_restaurant_id)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZET05', MESSAGE = 'a card machine of another restaurant';
  END IF;

  -- Two admins saving the same restaurant at once would otherwise both
  -- read the old list and leave a mixture of the two.
  PERFORM pg_advisory_xact_lock(hashtext('zet_card_machine:' || p_restaurant_id));

  UPDATE card_machine
     SET retired_at = now(), updated_at = now(), updated_by = v_user
   WHERE restaurant_id = p_restaurant_id
     AND retired_at IS NULL
     AND id <> ALL (ARRAY(SELECT i FROM unnest(p_ids) i WHERE i IS NOT NULL));

  FOR k IN 1 .. v_n LOOP
    v_id := p_ids[k];
    v_label := p_labels[k];

    IF v_id IS NULL THEN
      SELECT id INTO v_id FROM card_machine
       WHERE restaurant_id = p_restaurant_id
         AND retired_at IS NOT NULL
         AND lower(label) = lower(v_label)
         AND id <> ALL (ARRAY(SELECT i FROM unnest(p_ids) i WHERE i IS NOT NULL))
       ORDER BY id DESC
       LIMIT 1;
    END IF;

    IF v_id IS NULL THEN
      INSERT INTO card_machine (restaurant_id, label, position, updated_by)
      VALUES (p_restaurant_id, v_label, k, v_user);
    ELSE
      UPDATE card_machine
         SET label = v_label, position = k, retired_at = NULL,
             updated_at = now(), updated_by = v_user
       WHERE id = v_id;
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION zet_admin_save_card_machines(text, bigint[], text[]) FROM PUBLIC;

COMMIT;
