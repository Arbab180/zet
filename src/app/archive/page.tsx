import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentSession } from '../../server/currentSession';
import { listRestaurantSummaries } from '../../server/reports';
import { isAdmin } from '../../server/accounts';
import AppNav from '../../components/AppNav';
import styles from './archive.module.css';

export const dynamic = 'force-dynamic';

export default async function ArchivePage() {
  const session = await getCurrentSession();
  if (!session) redirect('/login');

  // Row-level security scopes this to the restaurants this user belongs to,
  // so "all restaurants" already means "all theirs".
  const [restaurants, admin] = await Promise.all([
    listRestaurantSummaries(session.userId),
    isAdmin(session),
  ]);
  const totalFlagged = restaurants.reduce((a, r) => a + r.flaggedCount, 0);

  return (
    <main className={styles.page}>
      <AppNav current="archive" isAdmin={admin} />

      <h1 className={styles.heading}>Αρχείο</h1>
      <p className={styles.sub}>
        {totalFlagged === 0
          ? 'Κανένα κλείσιμο δεν χρειάζεται έλεγχο.'
          : `${totalFlagged} ${totalFlagged === 1 ? 'κλείσιμο χρειάζεται' : 'κλεισίματα χρειάζονται'} έλεγχο.`}
      </p>

      <ul className={styles.list}>
        {restaurants.map((r) => (
          <li key={r.restaurantId}>
            <Link href={`/archive/${r.restaurantId}`} className={styles.card}>
              <span className={styles.cardName}>{r.displayName}</span>
              <span className={styles.cardMeta}>
                {r.reportCount === 0
                  ? 'κανένα κλείσιμο ακόμα'
                  : `${r.reportCount} ${r.reportCount === 1 ? 'κλείσιμο' : 'κλεισίματα'} · τελευταίο ${r.latestBusinessDate}`}
              </span>
              {r.flaggedCount > 0 && (
                <span className={styles.badge}>{r.flaggedCount} για έλεγχο</span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
