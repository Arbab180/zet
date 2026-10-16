import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentSession } from '../../server/currentSession';
import { MIN_PASSWORD_LENGTH, isAdmin, listRestaurantLogins } from '../../server/accounts';
import { FORM_ORDER, FORMS } from '../../lib/forms';
import AppNav from '../../components/AppNav';
import { CreateLoginForm, ResetPasswordForm } from './AccountForms';
import styles from './accounts.module.css';

export const dynamic = 'force-dynamic';

/**
 * The admin's page: one login per restaurant, created and reset here.
 *
 * Anyone else gets "not found", the same answer as a page that does not
 * exist — a restaurant login has no reason to learn this page is here.
 * The forms' actions re-check, and so does the database.
 */
export default async function AccountsPage() {
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  if (!(await isAdmin(session))) notFound();

  const logins = await listRestaurantLogins(session.userId);

  return (
    <main className={styles.page}>
      <AppNav current="accounts" isAdmin />

      <h1 className={styles.heading}>Λογαριασμοί</h1>
      <p className={styles.sub}>
        Ένας λογαριασμός ανά εστιατόριο. Βλέπει και καταχωρεί μόνο τα δικά του κλεισίματα και
        μπορεί να τα διορθώνει μέχρι να εγκριθούν. Έγκριση, διόρθωση εγκεκριμένων και εξαγωγή
        κάνει μόνο ο διαχειριστής.
      </p>

      <ul className={styles.list}>
        {FORM_ORDER.map((id) => {
          const mine = logins.filter((l) => l.restaurantId === id);
          return (
            <li key={id} className={styles.card}>
              <h2 className={styles.cardName}>{FORMS[id].displayName}</h2>
              {mine.length === 0 ? (
                <>
                  <p className={styles.cardMeta}>Δεν έχει λογαριασμό ακόμα.</p>
                  <CreateLoginForm restaurantId={id} minLength={MIN_PASSWORD_LENGTH} />
                </>
              ) : (
                mine.map((l) => (
                  <div key={l.userId} className={styles.login}>
                    <p className={styles.cardMeta}>
                      Όνομα χρήστη: <strong className={styles.username}>{l.username}</strong>
                      {' · '}
                      {l.name}
                    </p>
                    <ResetPasswordForm
                      userId={l.userId}
                      username={l.username}
                      minLength={MIN_PASSWORD_LENGTH}
                    />
                  </div>
                ))
              )}
            </li>
          );
        })}
      </ul>

      <p className={styles.note}>
        <Link href="/status">Κατάσταση εφαρμογής →</Link>
      </p>
    </main>
  );
}
