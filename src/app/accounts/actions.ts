'use server';

/**
 * Thin, like every other action file here: read the session, call the
 * decision in src/server/accounts.ts, turn the result into a message.
 * Who may do this is decided there and again in the database — nothing is
 * trusted from the page that rendered the form.
 */

import { revalidatePath } from 'next/cache';
import { getCurrentSession } from '../../server/currentSession';
import {
  MIN_PASSWORD_LENGTH,
  createRestaurantLogin,
  resetRestaurantPassword,
  type AccountError,
} from '../../server/accounts';

export type AccountFormState = {
  error: string | null;
  done: string | null;
  /**
   * What was typed, handed back on an error so the form can be refilled —
   * React resets a form after its action runs. Never the passwords.
   */
  typed?: { username: string; name: string };
};

const MESSAGES: Record<AccountError, string> = {
  not_admin: 'Μόνο ο διαχειριστής μπορεί να αλλάξει λογαριασμούς.',
  bad_restaurant: 'Άγνωστο εστιατόριο.',
  bad_username:
    'Το όνομα χρήστη θέλει 3–32 μικρά λατινικά γράμματα ή ψηφία (επιτρέπονται . _ -).',
  reserved_username: 'Αυτό το όνομα χρήστη είναι του διαχειριστή.',
  username_taken: 'Αυτό το όνομα χρήστη υπάρχει ήδη.',
  already_has_login: 'Αυτό το εστιατόριο έχει ήδη λογαριασμό.',
  name_required: 'Γράψτε ένα όνομα για τον λογαριασμό.',
  name_long: 'Το όνομα είναι πολύ μεγάλο.',
  password_short: `Ο κωδικός θέλει τουλάχιστον ${MIN_PASSWORD_LENGTH} χαρακτήρες.`,
  password_long: 'Ο κωδικός είναι πολύ μεγάλος.',
  password_mismatch: 'Οι δύο κωδικοί δεν ταιριάζουν.',
  bad_user: 'Ο λογαριασμός δεν βρέθηκε.',
  failed: 'Κάτι πήγε στραβά. Δοκιμάστε ξανά.',
};

function field(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === 'string' ? v : '';
}

export async function createLoginAction(
  _prev: AccountFormState,
  formData: FormData
): Promise<AccountFormState> {
  const result = await createRestaurantLogin(
    await getCurrentSession(),
    {
      restaurantId: field(formData, 'restaurantId'),
      username: field(formData, 'username'),
      name: field(formData, 'name'),
      password: field(formData, 'password'),
      confirm: field(formData, 'confirm'),
    },
    process.env.ADMIN_USERNAME ?? ''
  );
  if (!result.ok) {
    return {
      error: MESSAGES[result.error],
      done: null,
      typed: { username: field(formData, 'username'), name: field(formData, 'name') },
    };
  }
  revalidatePath('/accounts');
  return { error: null, done: 'Ο λογαριασμός δημιουργήθηκε.' };
}

export async function resetPasswordAction(
  _prev: AccountFormState,
  formData: FormData
): Promise<AccountFormState> {
  const result = await resetRestaurantPassword(await getCurrentSession(), {
    userId: field(formData, 'userId'),
    password: field(formData, 'password'),
    confirm: field(formData, 'confirm'),
  });
  if (!result.ok) return { error: MESSAGES[result.error], done: null };
  revalidatePath('/accounts');
  return {
    error: null,
    done: 'Ο κωδικός άλλαξε. Όποιος ήταν συνδεδεμένος με τον παλιό αποσυνδέθηκε.',
  };
}
