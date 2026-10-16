'use client';

import { useActionState } from 'react';
import {
  createLoginAction,
  resetPasswordAction,
  type AccountFormState,
} from './actions';
import styles from './accounts.module.css';

const initial: AccountFormState = { error: null, done: null };

/**
 * The forms are a convenience; the server re-validates every field and
 * re-checks that the caller is the admin. `required` and `minLength` here
 * only save a round trip.
 */

function Result({ state }: { state: AccountFormState }) {
  if (state.error) return <p role="alert" className={styles.error}>{state.error}</p>;
  if (state.done) return <p role="status" className={styles.done}>{state.done}</p>;
  return null;
}

function PasswordFields({ idPrefix, minLength }: { idPrefix: string; minLength: number }) {
  return (
    <>
      <label htmlFor={`${idPrefix}-password`}>Κωδικός</label>
      <input
        id={`${idPrefix}-password`}
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={minLength}
        required
      />
      <label htmlFor={`${idPrefix}-confirm`}>Ξανά ο κωδικός</label>
      <input
        id={`${idPrefix}-confirm`}
        name="confirm"
        type="password"
        autoComplete="new-password"
        minLength={minLength}
        required
      />
    </>
  );
}

export function CreateLoginForm({
  restaurantId,
  minLength,
}: {
  restaurantId: string;
  minLength: number;
}) {
  const [state, action, pending] = useActionState(createLoginAction, initial);
  const p = `new-${restaurantId}`;

  return (
    <form action={action} className={styles.form}>
      <input type="hidden" name="restaurantId" value={restaurantId} />
      <label htmlFor={`${p}-username`}>Όνομα χρήστη</label>
      <input
        id={`${p}-username`}
        name="username"
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        defaultValue={state.typed?.username}
        required
      />
      <label htmlFor={`${p}-name`}>Όνομα λογαριασμού</label>
      <input
        id={`${p}-name`}
        name="name"
        autoComplete="off"
        defaultValue={state.typed?.name}
        required
      />
      <PasswordFields idPrefix={p} minLength={minLength} />
      <Result state={state} />
      <button type="submit" disabled={pending}>
        {pending ? 'Δημιουργία…' : 'Δημιουργία λογαριασμού'}
      </button>
    </form>
  );
}

export function ResetPasswordForm({
  userId,
  username,
  minLength,
}: {
  userId: string;
  username: string;
  minLength: number;
}) {
  const [state, action, pending] = useActionState(resetPasswordAction, initial);
  const p = `reset-${username}`;

  return (
    <details className={styles.reset}>
      <summary>Νέος κωδικός</summary>
      <form action={action} className={styles.form}>
        <input type="hidden" name="userId" value={userId} />
        <PasswordFields idPrefix={p} minLength={minLength} />
        <Result state={state} />
        <button type="submit" disabled={pending}>
          {pending ? 'Αποθήκευση…' : 'Ορισμός κωδικού'}
        </button>
      </form>
    </details>
  );
}
