import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentSession } from '../../../server/currentSession';
import { listReports } from '../../../server/reports';
import { isAdmin } from '../../../server/accounts';
import { getRestaurantRole } from '../../../lib/db';
import { FORM_ORDER, FORMS, type FormId } from '../../../lib/forms';
import { formatCents } from '../../../lib/money';
import { describeFlag } from '../../../lib/flags';
import AppNav from '../../../components/AppNav';
import { getT } from '../../../server/lang';
import styles from '../archive.module.css';

export const dynamic = 'force-dynamic';

export default async function RestaurantArchivePage({
  params,
  searchParams,
}: {
  params: Promise<{ restaurantId: string }>;
  searchParams: Promise<{ flagged?: string }>;
}) {
  const session = await getCurrentSession();
  if (!session) redirect('/login');

  const { restaurantId } = await params;
  if (!(FORM_ORDER as readonly string[]).includes(restaurantId)) notFound();
  const form = FORMS[restaurantId as FormId];
  // Not a member: the same "not found" as a restaurant that does not exist.
  // Row-level security would already return no nights; this stops the page
  // rendering another restaurant's name over an empty list.
  if ((await getRestaurantRole(session.userId, restaurantId)) === null) notFound();

  const onlyFlagged = (await searchParams).flagged === '1';
  const [reports, admin] = await Promise.all([
    listReports(session.userId, restaurantId, { onlyFlagged }),
    isAdmin(session),
  ]);
  const t = await getT();

  return (
    <main className={styles.page}>
      <AppNav current="archive" isAdmin={admin} />
      <Link href="/archive" className={styles.backLink}>← {t('Αρχείο')}</Link>
      <h1 className={styles.heading}>{form.displayName}</h1>

      <div className={styles.filters}>
        <Link
          href={`/archive/${restaurantId}`}
          className={onlyFlagged ? styles.filter : styles.filterActive}
        >
          {t('Όλα')}
        </Link>
        <Link
          href={`/archive/${restaurantId}?flagged=1`}
          className={onlyFlagged ? styles.filterActive : styles.filter}
        >
          {t('Μόνο για έλεγχο')}
        </Link>
      </div>

      {reports.length === 0 ? (
        <p className={styles.empty}>
          {onlyFlagged ? t('Κανένα κλείσιμο για έλεγχο.') : t('Κανένα κλείσιμο ακόμα.')}
        </p>
      ) : (
        <ul className={styles.list}>
          {reports.map((r) => (
            <li key={r.id}>
              <Link
                href={`/archive/${restaurantId}/${r.businessDate}`}
                className={r.flags.length > 0 ? styles.rowFlagged : styles.row}
              >
                <span className={styles.rowDate}>{r.businessDate}</span>
                <span className={styles.rowStatus}>{t(statusLabel(r.status))}</span>
                <span className={styles.rowAmount}>{formatCents(r.actualCents)}</span>
                {r.flags.length > 0 && (
                  <span className={styles.rowFlags}>
                    {r.flags.map((f) => t(describeFlag(f, formatCents))).join(' · ')}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case 'draft': return 'πρόχειρο';
    case 'submitted': return 'κατατέθηκε';
    case 'approved': return 'εγκρίθηκε';
    case 'rejected': return 'απορρίφθηκε';
    default: return status;
  }
}
