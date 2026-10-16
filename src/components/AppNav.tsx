import Link from 'next/link';
import styles from './AppNav.module.css';

/**
 * The two halves of the app: filing tonight's sheet, and looking at what
 * was filed. Present on both, so switching is always one tap rather than a
 * link someone has to find.
 *
 * Deliberately NOT on the sheet itself. That screen is someone standing
 * over a counted envelope at 1am, and a nav bar at the top of it is an
 * invitation to lose a half-typed sheet. It keeps its own back link, which
 * saves a draft on the way out.
 *
 * The accounts tab is shown to the admin only. Hiding it is cosmetic: the
 * page answers "not found" to anyone else, and the database refuses them.
 */
export default function AppNav({
  current,
  isAdmin = false,
}: {
  current: 'zet' | 'archive' | 'accounts';
  isAdmin?: boolean;
}) {
  return (
    <nav className={styles.nav} aria-label="Κύρια πλοήγηση">
      <Link
        href="/"
        className={current === 'zet' ? styles.tabActive : styles.tab}
        aria-current={current === 'zet' ? 'page' : undefined}
      >
        Κλείσιμο ημέρας
      </Link>
      <Link
        href="/archive"
        className={current === 'archive' ? styles.tabActive : styles.tab}
        aria-current={current === 'archive' ? 'page' : undefined}
      >
        Αρχείο
      </Link>
      {isAdmin && (
        <Link
          href="/accounts"
          className={current === 'accounts' ? styles.tabActive : styles.tab}
          aria-current={current === 'accounts' ? 'page' : undefined}
        >
          Λογαριασμοί
        </Link>
      )}
    </nav>
  );
}
