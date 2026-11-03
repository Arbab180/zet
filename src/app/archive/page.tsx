import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentSession } from '../../server/currentSession';
import { listRestaurantSummaries } from '../../server/reports';
import { isAdmin } from '../../server/accounts';
import AppNav from '../../components/AppNav';
import { getT } from '../../server/lang';
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
  const t = await getT();

  return (
    <main className={styles.page}>
      <AppNav current="archive" isAdmin={admin} />

      <h1 className={styles.heading}>{t('Αρχείο')}</h1>
      <p className={styles.sub}>
        {totalFlagged === 0
          ? t('Κανένα κλείσιμο δεν χρειάζεται έλεγχο.')
          : totalFlagged === 1
            ? t('1 κλείσιμο χρειάζεται έλεγχο.')
            : t('{n} κλεισίματα χρειάζονται έλεγχο.', { n: totalFlagged })}
      </p>

      <ul className={styles.list}>
        {restaurants.map((r) => (
          <li key={r.restaurantId}>
            <Link href={`/archive/${r.restaurantId}`} className={styles.card}>
              <span className={styles.cardName}>{r.displayName}</span>
              <span className={styles.cardMeta}>
                {r.reportCount === 0
                  ? t('κανένα κλείσιμο ακόμα')
                  : r.reportCount === 1
                    ? t('1 κλείσιμο · τελευταίο {date}', { date: r.latestBusinessDate ?? '' })
                    : t('{n} κλεισίματα · τελευταίο {date}', {
                        n: r.reportCount,
                        date: r.latestBusinessDate ?? '',
                      })}
              </span>
              {r.flaggedCount > 0 && (
                <span className={styles.badge}>{t('{n} για έλεγχο', { n: r.flaggedCount })}</span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
