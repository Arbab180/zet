import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentSession } from '../../../../server/currentSession';
import { getReportDetail, listRevisions, listShifts } from '../../../../server/reports';
import { roleFor } from '../../../../server/approve';
import { FORM_ORDER, FORMS, rowLabelFor, rowOrderFor, type FormId } from '../../../../lib/forms';
import { withAllCardBrackets } from '../../../../lib/cardMachines';
import { formatCents } from '../../../../lib/money';
import { describeFlag } from '../../../../lib/flags';
import ApproveButton from './ApproveButton';
import styles from '../../archive.module.css';
import { isCustomLineKey, labelFromCustomKey } from '../../../../lib/customLine';
import { storedItemsTotalCents, type ReceiptItem } from '../../../../lib/receiptItems';

export const dynamic = 'force-dynamic';

export default async function ReportDetailPage({
  params,
}: {
  params: Promise<{ restaurantId: string; date: string }>;
}) {
  const session = await getCurrentSession();
  if (!session) redirect('/login');

  const { restaurantId, date } = await params;
  if (!(FORM_ORDER as readonly string[]).includes(restaurantId)) notFound();
  // With the card brackets, so a stored CARD_2 reads "SIX CARDS — 2".
  const form = withAllCardBrackets(FORMS[restaurantId as FormId]);

  // null covers both "no such night" and "not yours" — deliberately
  // indistinguishable, so the difference cannot tell an outsider which
  // nights exist.
  const report = await getReportDetail(session.userId, restaurantId, date);
  if (!report) notFound();

  // One invoice list for the night, not one per shift — migration 0005.
  const night = form.layout === 'shifts'
    ? await listShifts(session.userId, restaurantId, date)
    : { shifts: [], invoices: [], invoiceCents: 0 };
  const shifts = night.shifts;

  const revisions = report.revisionCount > 0
    ? await listRevisions(session.userId, restaurantId, date)
    : [];

  const flagged = report.flags.length > 0;
  // What this person may do with the night, read fresh. Hiding a control
  // is a convenience: each action re-checks on the server, and approving
  // and correcting again in the database (migration 0009).
  const role = await roleFor(session, restaurantId);
  const isAdmin = role === 'admin';
  const mayApprove = report.status === 'submitted' && isAdmin;
  // Until it is approved, a night is its restaurant's to fix.
  const mayEdit = report.status !== 'approved' && role !== null && role !== 'viewer';

  return (
    <main className={styles.page}>
      <Link href={`/archive/${restaurantId}`} className={styles.backLink}>
        ← {form.displayName}
      </Link>

      <h1 className={styles.heading}>{report.businessDate}</h1>
      <p className={styles.sub}>
        {form.displayName} · {statusLabel(report.status)}
        {report.revisionNo > 1 && ` · αναθεώρηση ${report.revisionNo}`}
      </p>

      {/* A plain link, not a button with script: the route answers with
          the file and the browser saves it. Works on a phone too. */}
      {isAdmin && (
        <a
          href={`/api/archive/${restaurantId}/${date}/export`}
          className={styles.exportLink}
          download
        >
          Εξαγωγή για Sofia (.xlsx)
        </a>
      )}

      {flagged && (
        <div role="alert" className={styles.flagPanel}>
          <p className={styles.flagPanelTitle}>Χρειάζεται έλεγχο</p>
          <ul>
            {report.flags.map((f, i) => (
              <li key={i}>{describeFlag(f, formatCents)}</li>
            ))}
          </ul>
        </div>
      )}

      <dl className={styles.totals}>
        <div>
          <dt>Αναμενόμενα</dt>
          <dd>{formatCents(report.expectedCents)}</dd>
        </div>
        <div>
          <dt>Μετρήθηκαν</dt>
          <dd>{formatCents(report.actualCents)}</dd>
        </div>
        <div className={report.varianceCents === 0 ? '' : styles.varianceRow}>
          <dt>Διαφορά</dt>
          <dd>{formatCents(report.varianceCents)}</dd>
        </div>
      </dl>

      {/* A sheet always sends all three columns, so a night where only the
          evening was worked stores two empty ones. Showing them would be
          three headings and two blank lists. A column with no total and no
          money against any method was not used. */}
      {shifts
        .filter((s) => s.totalCents !== 0 || s.payments.some((p) => p.amountCents !== 0))
        .map((s) => (
        <section key={s.shiftIndex} className={styles.section}>
          <h2 className={styles.sectionHeading}>
            {s.label}
            {shifts.filter((x) => x.label === s.label).length > 1 && ` ${s.shiftIndex}`}
          </h2>
          <ul className={styles.lineList}>
            <li>
              <span>Total</span>
              <span className={styles.lineAmount}>{formatCents(s.totalCents)}</span>
            </li>
            {s.payments
              .filter((p) => p.amountCents !== 0)
              .map((p) => (
                <li key={p.methodKey}>
                  {/* A named row is stored under its own name behind a
                      reserved prefix; the accountant reads the name. */}
                  {/* Only a CUSTOM key carries a written name. For an
                      ordinary one labelFromCustomKey hands back the key
                      itself, which would win as if someone had written
                      it and print "GAP" where the sheet says SIX CARDS. */}
                  <span>
                    {rowLabelFor(
                      form,
                      p.methodKey,
                      isCustomLineKey(p.methodKey) ? labelFromCustomKey(p.methodKey) : null
                    )}
                  </span>
                  <span className={styles.lineAmount}>{formatCents(p.amountCents)}</span>
                </li>
              ))}
          </ul>
        </section>
        ))}

      {night.invoices.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionHeading}>ΤΙΜΟΛΟΓΙΑ</h2>
          <ul className={styles.lineList}>
            {night.invoices.map((inv) => (
              <li key={inv.lineNo}>
                <span>
                  {inv.supplierName}
                  {inv.invoiceNumber && ` · ${inv.invoiceNumber}`}
                  {inv.invoiceDate && ` · ${inv.invoiceDate}`}
                </span>
                <span className={styles.lineAmount}>{formatCents(inv.amountCents)}</span>
                <ReceiptItemList items={inv.items} lineCents={inv.amountCents} />
              </li>
            ))}
            <li>
              <span>Σύνολο τιμολογίων</span>
              <span className={styles.lineAmount}>{formatCents(night.invoiceCents)}</span>
            </li>
          </ul>
        </section>
      )}

      {report.lines.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionHeading}>Γραμμές</h2>
          <ul className={styles.lineList}>
            {[...report.lines]
              // In the order the sheet prints them, not the order the
              // query returned — which was alphabetical by row_key.
              .sort((a, b) => rowOrderFor(form, a.rowKey) - rowOrderFor(form, b.rowKey))
              .map((l) => (
              <li key={l.rowKey}>
                <span>{rowLabelFor(form, l.rowKey, l.labelOverride)}</span>
                <span className={styles.lineAmount}>{formatCents(l.amountCents)}</span>
                {l.slotCount > 0 && l.slotTotalCents !== l.amountCents && (
                  <span className={styles.lineNote}>
                    παραγγελίες: {formatCents(l.slotTotalCents)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {report.expenses.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionHeading}>Έξοδα</h2>
          <ul className={styles.lineList}>
            {report.expenses.map((e) => (
              <li key={e.lineNo}>
                <span>{e.description || '—'}</span>
                <span className={styles.lineAmount}>{formatCents(e.amountCents)}</span>
                <ReceiptItemList items={e.items} lineCents={e.amountCents} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>Υπεύθυνος</h2>
        <p className={styles.who}>{report.closingManagerName || '—'}</p>
        {report.status === 'approved' && (
          <p className={styles.who}>
            Εγκρίθηκε{report.approvedAt ? ` στις ${report.approvedAt.slice(0, 10)}` : ''}
            {report.createdBy && report.approvedBy === report.createdBy
              ? ' — από το ίδιο άτομο που το κατέθεσε'
              : ''}
          </p>
        )}
      </section>

      {mayEdit && (
        <p className={styles.correctLink}>
          <Link href={`/${restaurantId}?edit=${report.businessDate}`}>
            Επεξεργασία αυτού του κλεισίματος →
          </Link>
        </p>
      )}

      {report.status === 'approved' && isAdmin && (
        <p className={styles.correctLink}>
          <Link href={`/${restaurantId}?correct=${report.businessDate}`}>
            Διόρθωση αυτού του κλεισίματος →
          </Link>
        </p>
      )}

      {revisions.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionHeading}>Διορθώσεις</h2>
          <ol className={styles.revisionList}>
            {revisions.map((v) => (
              <li key={v.revisionNo}>
                <span className={styles.revisionWhen}>{v.changedAt.slice(0, 10)}</span>
                <span className={styles.revisionReason}>{v.reason}</span>
                <span className={styles.revisionBefore}>
                  πριν: αναμενόμενα {formatCents(v.expectedCents)}, μετρήθηκαν{' '}
                  {formatCents(v.actualCents)}
                </span>
              </li>
            ))}
          </ol>
          <p className={styles.revisionNote}>
            Κάθε διόρθωση κρατά το προηγούμενο κλείσιμο όπως ήταν. Τίποτα δεν σβήνεται.
          </p>
        </section>
      )}

      {mayApprove && (
        <ApproveButton
          restaurantId={restaurantId}
          businessDate={report.businessDate}
          flagged={flagged}
        />
      )}
      {report.status === 'submitted' && !mayApprove && (
        <p className={styles.note}>
          Το κλείσιμο περιμένει έγκριση από τον διαχειριστή. Μέχρι τότε μπορείτε να το διορθώσετε.
        </p>
      )}
    </main>
  );
}

/**
 * What a receipt lists, under its line. Read-only here: the archive shows
 * what was filed. A difference from the line's amount is stated, not
 * hidden and not corrected — the accountant is the reader who needs it.
 */
function ReceiptItemList({ items, lineCents }: { items: ReceiptItem[]; lineCents: number }) {
  if (items.length === 0) return null;
  const total = storedItemsTotalCents(items);
  const priced = items.some((i) => i.amountCents != null);
  return (
    <ul className={styles.itemList}>
      {items.map((it, i) => (
        <li key={i}>
          <span>
            {it.name || '—'}
            {it.qty && <span className={styles.itemQty}> · {it.qty}</span>}
          </span>
          <span className={styles.lineAmount}>
            {it.amountCents == null ? '—' : formatCents(it.amountCents)}
          </span>
        </li>
      ))}
      {priced && total !== lineCents && (
        <li className={styles.itemNote}>
          <span>
            τα είδη δίνουν {formatCents(total)} — διαφορά {formatCents(Math.abs(lineCents - total))}
          </span>
        </li>
      )}
    </ul>
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
