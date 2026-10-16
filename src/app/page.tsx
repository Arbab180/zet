import Link from 'next/link';
import { redirect } from 'next/navigation';
import { FORMS } from '../lib/forms';
import { getCurrentSession } from '../server/currentSession';
import { listFlagged } from '../server/reports';
import { isAdmin, listWritableRestaurants } from '../server/accounts';
import { formatCents } from '../lib/money';
import { describeFlag } from '../lib/flags';
import AppNav from '../components/AppNav';
import { logoutAction } from './login/actions';
import styles from './page.module.css';

export const dynamic = 'force-dynamic';

/**
 * The dashboard. Two jobs, in the order they matter at the moment someone
 * opens it:
 *
 *   1. Is anything wrong? Flagged nights first, across every restaurant
 *      this person may see, each one a link straight to that night. A
 *      count alone would mean hunting for which night it meant.
 *   2. File tonight's sheet.
 *
 * A Server Component: the session check and both queries happen on the
 * server before any markup exists.
 */
export default async function DashboardPage() {
  const session = await getCurrentSession();
  if (!session) redirect('/login');

  const [flagged, restaurants, admin] = await Promise.all([
    listFlagged(session.userId),
    // Only the restaurants this login belongs to. A restaurant login sees
    // its own sheet here and nothing else.
    listWritableRestaurants(session.userId),
    isAdmin(session),
  ]);
  const shown = flagged.slice(0, 5);

  return (
    <main className={styles.page}>
      <AppNav current="zet" isAdmin={admin} />

      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>Χρειάζονται έλεγχο</h2>

        {flagged.length === 0 ? (
          <p className={styles.allClear}>Όλα τα κλεισίματα συμφωνούν.</p>
        ) : (
          <>
            <ul className={styles.flagList}>
              {shown.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/archive/${r.restaurantId}/${r.businessDate}`}
                    className={styles.flagRow}
                  >
                    <span className={styles.flagDate}>{r.businessDate}</span>
                    <span className={styles.flagWhere}>
                      {FORMS[r.restaurantId as keyof typeof FORMS]?.displayName ?? r.restaurantId}
                    </span>
                    <span className={styles.flagWhat}>
                      {r.flags.map((f) => describeFlag(f, formatCents)).join(' · ')}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {flagged.length > shown.length && (
              <Link href="/archive" className={styles.moreLink}>
                και άλλα {flagged.length - shown.length} →
              </Link>
            )}
          </>
        )}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>Νέο κλείσιμο</h2>
        <ul className={styles.list}>
          {restaurants.map((id) => (
            <li key={id}>
              <Link href={`/${id}`} className={styles.link}>
                {FORMS[id].displayName}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <form action={logoutAction} className={styles.logout}>
        <button type="submit">Αποσύνδεση</button>
      </form>
    </main>
  );
}
