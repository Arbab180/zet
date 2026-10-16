'use server';

import { revalidatePath } from 'next/cache';
import { getCurrentSession } from '../../server/currentSession';
import { approveReport } from '../../server/approve';

export type ApproveState = { error: string | null; ok: boolean };

/**
 * Thin, like every other action file here: read the session, call the
 * decision, return the result. approveReport re-checks authorisation and
 * the admin-only-when-flagged rule itself — nothing is trusted from the
 * page that rendered the button.
 */
export async function approveAction(
  _prev: ApproveState,
  formData: FormData
): Promise<ApproveState> {
  const restaurantId = String(formData.get('restaurantId') ?? '');
  const businessDate = String(formData.get('businessDate') ?? '');

  const result = await approveReport(await getCurrentSession(), restaurantId, businessDate);

  if (!result.ok) return { ok: false, error: result.message };

  revalidatePath(`/archive/${restaurantId}`);
  revalidatePath(`/archive/${restaurantId}/${businessDate}`);
  return { ok: true, error: null };
}
