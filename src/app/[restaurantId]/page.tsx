import { notFound, redirect } from 'next/navigation';
import { FORM_ORDER, FORMS, type FormId } from '../../lib/forms';
import { MAX_CARD_BRACKETS, withCardBrackets } from '../../lib/cardMachines';
import { getCurrentSession } from '../../server/currentSession';
import {
  getReportDetail,
  getReportForEdit,
  getShiftsReportForEdit,
} from '../../server/reports';
import { formatCents } from '../../lib/money';
import { getRestaurantRole } from '../../lib/db';
import LedgerFormSheet from '../../components/LedgerForm';
import ShiftsFormSheet from '../../components/ShiftsForm';

// A Server Component: it does the restaurant lookup and hands a plain,
// serialisable config down to the "use client" form. Next.js 15+ makes
// dynamic route params a Promise even in a Server Component, hence await.
export default async function RestaurantPage({
  params,
  searchParams,
}: {
  params: Promise<{ restaurantId: string }>;
  searchParams: Promise<{ correct?: string; edit?: string }>;
}) {
  // Checked before the sheet is rendered at all: a form that looks usable
  // but cannot save is worse than a login page.
  const session = await getCurrentSession();
  if (!session) redirect('/login');

  const { restaurantId } = await params;

  if (!(FORM_ORDER as readonly string[]).includes(restaurantId)) {
    notFound();
  }

  const form = FORMS[restaurantId as FormId];

  // Another restaurant's sheet is "not found", not a form that looks usable
  // and then refuses to save. The save re-checks regardless.
  const role = await getRestaurantRole(session.userId, restaurantId);
  if (role === null || role === 'viewer') notFound();

  // key={form.id}: if a manager navigates client-side from one restaurant
  // straight to another, this forces a remount rather than keeping the
  // previous restaurant's typed-in state under a new letterhead.
  // Reopening a filed night. ?correct= is an APPROVED night, which only the
  // admin may correct; ?edit= is one not yet approved, which its restaurant
  // may keep fixing. Each is "not found" outside those rules — and the save
  // re-checks both, as does the database (migration 0009).
  const query = await searchParams;
  const mode: 'correct' | 'edit' | null = query.correct ? 'correct' : query.edit ? 'edit' : null;
  const correctDate = query.correct ?? query.edit;
  if (mode === 'correct' && role !== 'admin') notFound();
  const statusAllowed = (status: string) =>
    mode === 'correct' ? status === 'approved' : status !== 'approved';
  const nextRevisionFor = (revisionNo: number) => (mode === 'correct' ? revisionNo + 1 : null);

  if (form.layout === 'shifts') {
    if (!correctDate) return <ShiftsFormSheet key={form.id} form={form} />;

    const detail = await getReportDetail(session.userId, restaurantId, correctDate);
    const initial = await getShiftsReportForEdit(
      session.userId,
      restaurantId,
      correctDate,
      formatCents,
      // Every card bracket a night could hold, so the brackets it was
      // filed with come back and the sheet reopens with them.
      withCardBrackets(form, MAX_CARD_BRACKETS).methods.map((m) => m.key)
    );
    if (!detail || !initial || !statusAllowed(detail.status)) notFound();

    return (
      <ShiftsFormSheet
        key={`${form.id}-${mode}-${correctDate}`}
        form={form}
        correction={{
          businessDate: correctDate,
          initial,
          nextRevisionNo: nextRevisionFor(detail.revisionNo),
        }}
      />
    );
  }

  if (correctDate) {
    const [detail, initial] = await Promise.all([
      getReportDetail(session.userId, restaurantId, correctDate),
      getReportForEdit(session.userId, restaurantId, correctDate, formatCents),
    ]);

    // notFound() for a night that is not theirs, does not exist, or is in
    // the wrong state for the mode asked for.
    if (!detail || !initial || !statusAllowed(detail.status)) notFound();

    return (
      <LedgerFormSheet
        key={`${form.id}-${mode}-${correctDate}`}
        form={form}
        correction={{
          businessDate: correctDate,
          initial: { ...initial, signature: '' },
          nextRevisionNo: nextRevisionFor(detail.revisionNo),
        }}
      />
    );
  }

  // key={form.id}: if a manager navigates client-side from one ledger
  // restaurant straight to another, this forces LedgerFormSheet to remount
  // rather than keep the previous restaurant's typed-in state under a new
  // letterhead.
  return <LedgerFormSheet key={form.id} form={form} />;
}
