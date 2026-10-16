import { NextResponse } from 'next/server';
import { getCurrentSession } from '../../../../../../server/currentSession';
import { getReportDetail, listShifts } from '../../../../../../server/reports';
import { getRestaurantRole } from '../../../../../../lib/db';
import { FORM_ORDER, FORMS, type FormId } from '../../../../../../lib/forms';
import { withAllCardBrackets } from '../../../../../../lib/cardMachines';
import {
  journalBalances,
  ledgerJournal,
  shiftsJournal,
  sofiaReference,
  toSofiaRows,
} from '../../../../../../lib/sofiaExport';
import { sofiaWorkbook } from '../../../../../../server/sofiaXlsx';

export const dynamic = 'force-dynamic';

/**
 * One night of the archive as an .xlsx in the Sofia GL import layout.
 *
 * Test trial: the accountant opens it and keys the lines into Sofia by
 * hand. It reads the same stored figures the archive page shows, through
 * the same reads. Only an admin of the restaurant may export; for anyone
 * else, and for a night they may not open, it is a 404 exactly like one
 * that does not exist.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ restaurantId: string; date: string }> }
): Promise<NextResponse> {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'not_authorised' }, { status: 401 });

  const { restaurantId, date } = await params;
  if (!(FORM_ORDER as readonly string[]).includes(restaurantId) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  // With the card brackets, which are posted folded into the one card line.
  const form = withAllCardBrackets(FORMS[restaurantId as FormId]);

  // Exporting is the admin's (05/10/2026). Re-checked per restaurant on
  // every request. A 404, not a 403: to a restaurant login this route
  // simply does not exist, like another restaurant's night.
  if ((await getRestaurantRole(session.userId, restaurantId)) !== 'admin') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const report = await getReportDetail(session.userId, restaurantId, date);
  if (!report) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  let journal;
  if (form.layout === 'shifts') {
    const night = await listShifts(session.userId, restaurantId, date);
    journal = shiftsJournal(form, {
      shifts: night.shifts.map((s) => ({ totalCents: s.totalCents, payments: s.payments })),
      invoices: night.invoices,
    });
  } else {
    journal = ledgerJournal(form, {
      lines: report.lines,
      expenses: report.expenses,
      countedCents: report.actualCents,
    });
  }

  // Cannot happen — the difference line is built to close the gap — but
  // an unbalanced journal must never leave the building looking valid.
  if (!journalBalances(journal)) {
    return NextResponse.json({ error: 'unbalanced' }, { status: 500 });
  }

  const file = sofiaWorkbook(toSofiaRows(restaurantId, date, journal));
  const name = `${sofiaReference(restaurantId, date)}.xlsx`;

  return new NextResponse(new Uint8Array(file), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    },
  });
}
