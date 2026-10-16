'use client';

import { useActionState } from 'react';
import { approveAction, type ApproveState } from '../../actions';
import styles from '../../archive.module.css';

const initial: ApproveState = { error: null, ok: false };

/**
 * Rendered only when the server already decided this person may approve.
 * That decision is a convenience: approveReport re-checks authorisation
 * and the admin-only-when-flagged rule on the request itself, so hiding
 * or showing this button changes nothing about what is permitted.
 */
export default function ApproveButton({
  restaurantId,
  businessDate,
  flagged,
}: {
  restaurantId: string;
  businessDate: string;
  flagged: boolean;
}) {
  const [state, action, pending] = useActionState(approveAction, initial);

  return (
    <form action={action} className={styles.approveForm}>
      <input type="hidden" name="restaurantId" value={restaurantId} />
      <input type="hidden" name="businessDate" value={businessDate} />
      {state.error && (
        <p role="alert" className={styles.error}>{state.error}</p>
      )}
      <button type="submit" disabled={pending}>
        {pending ? 'Έγκριση…' : flagged ? 'Έγκριση παρά τη διαφορά' : 'Έγκριση'}
      </button>
    </form>
  );
}
