import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentSession } from '../../server/currentSession';
import { withUserTransaction } from '../../lib/db';
import styles from '../archive/archive.module.css';

export const dynamic = 'force-dynamic';

/**
 * What the running app actually received — for checking a deploy.
 *
 * Firebase App Hosting has an open bug (firebase-tools #10391) where a
 * secret declared in apphosting.yaml is silently left off the running app.
 * The symptom is a feature that quietly says "not set up". This page turns
 * that into a list you can read in five seconds.
 *
 * It shows ONLY whether each setting is present — never a value, never a
 * prefix of one. The admin only: even "which features are configured" is
 * nobody else's business, and a restaurant login has nothing to compare
 * against ADMIN_USER_ID. The login settings are not listed because if
 * any were missing you could not have signed in to see this.
 */
export default async function StatusPage() {
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  // The environment admin, decided WITHOUT the database: this page is for
  // the day the database or ADMIN_USER_ID is what is broken.
  if (session.userId !== process.env.ADMIN_USER_ID) notFound();

  const present = (name: string) => (process.env[name] ?? '') !== '';

  const settings: Array<[string, boolean, string]> = [
    ['DATABASE_URL', present('DATABASE_URL'), 'saving and reading nights'],
    ['R2_ACCOUNT_ID', present('R2_ACCOUNT_ID'), 'receipt photos'],
    ['R2_ACCESS_KEY_ID', present('R2_ACCESS_KEY_ID'), 'receipt photos'],
    ['R2_SECRET_ACCESS_KEY', present('R2_SECRET_ACCESS_KEY'), 'receipt photos'],
    ['R2_BUCKET', present('R2_BUCKET'), 'receipt photos'],
    ['ANTHROPIC_API_KEY', present('ANTHROPIC_API_KEY'), 'reading amounts off receipts'],
  ];

  // The real test of the database: connect as the app does, through the
  // same scoped transaction, and count the restaurants this login may see.
  // db.ts refuses to run at all if the login could bypass row-level security.
  let db:
    | { ok: true; restaurants: number; admin: boolean; ms: number }
    | { ok: false; error: string };
  const started = Date.now();
  try {
    // This user's own memberships, not every row it can see: since
    // restaurant logins exist, the admin can see theirs too.
    const { restaurants, admin } = await withUserTransaction(session.userId, async (client) => {
      const { rows } = await client.query(
        `SELECT count(DISTINCT restaurant_id)::int AS n, zet_caller_is_admin() AS admin
           FROM restaurant_user WHERE user_id = $1`,
        [session.userId]
      );
      return { restaurants: rows[0].n as number, admin: rows[0].admin === true };
    });
    db = { ok: true, restaurants, admin, ms: Date.now() - started };
  } catch (e) {
    // The error class name and message, not the stack. A connection string
    // never appears in a pg error message.
    db = { ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }

  return (
    <main className={styles.page}>
      <Link href="/" className={styles.backLink}>← Αρχική</Link>
      <h1 className={styles.heading}>Κατάσταση</h1>
      <p className={styles.sub}>Τι έλαβε η εφαρμογή που τρέχει τώρα.</p>

      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>Βάση δεδομένων</h2>
        <ul className={styles.lineList}>
          {db.ok ? (
            <>
              <li>
                <span>✓ Σύνδεση</span>
                <span className={styles.lineAmount}>{db.ms} ms</span>
              </li>
              {/* Zero is not "fine". It means the database answered but this
                  login belongs to no restaurant there — every save and every
                  photo is then refused as not_authorised. On 02/10/2026 a tick
                  here hid exactly that: ADMIN_USER_ID held the laptop's id. */}
              <li>
                <span>
                  {db.restaurants > 0 ? '✓' : '✗'} {db.restaurants} εστιατόρια για αυτόν τον
                  λογαριασμό
                  {db.restaurants === 0 && ' — το ADMIN_USER_ID δεν υπάρχει σε αυτή τη βάση'}
                </span>
              </li>
              {/* Without the flag, /accounts is "not found" and no restaurant
                  login can be created (migration 0008 sets it by the seeded
                  admin's email). */}
              <li>
                <span>
                  {db.admin ? '✓ Διαχειριστής' : '✗ Ο λογαριασμός δεν είναι διαχειριστής σε αυτή τη βάση — τρέξτε ξανά το db-deploy.sh'}
                </span>
              </li>
              {/* The first 8 characters only: enough to compare with what
                  db-deploy.sh printed, and an id opens nothing by itself. */}
              <li>
                <span>Σύνδεση ως: {session.userId.slice(0, 8)}…</span>
                <span className={styles.lineAmount}>
                  ADMIN_USER_ID: {(process.env.ADMIN_USER_ID ?? '').slice(0, 8) || '—'}…
                  {(process.env.ADMIN_USER_ID ?? '') !== session.userId &&
                    ' (διαφέρει — αποσυνδεθείτε και συνδεθείτε ξανά)'}
                </span>
              </li>
            </>
          ) : (
            <li>
              <span>✗ {db.error}</span>
            </li>
          )}
        </ul>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>Ρυθμίσεις</h2>
        <ul className={styles.lineList}>
          {settings.map(([name, ok, what]) => (
            <li key={name}>
              <span>{ok ? '✓' : '✗ λείπει —'} {name}</span>
              <span className={styles.lineAmount}>{what}</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
