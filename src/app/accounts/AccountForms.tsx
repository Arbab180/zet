'use client';

import { useActionState } from 'react';
import {
  createLoginAction,
  resetPasswordAction,
  type AccountFormState,
} from './actions';
import { useT } from '../../components/LangProvider';
import styles from './accounts.module.css';

const initial: AccountFormState = { error: null, done: null };

/**
 * The forms are a convenience; the server re-validates every field and
 * re-checks that the caller is the admin. `required` and `minLength` here
 * only save a round trip.
 */

function Result({ state }: { state: AccountFormState }) {
  const t = useT();
  if (state.error) return <p role="alert" className={styles.error}>{t(state.error)}</p>;
  if (state.done) return <p role="status" className={styles.done}>{t(state.done)}</p>;
  return null;
}

function PasswordFields({ idPrefix, minLength }: { idPrefix: string; minLength: number }) {
  const t = useT();
  return (
    <>
      <label htmlFor={`${idPrefix}-password`}>{t('Κωδικός')}</label>
      <input
        id={`${idPrefix}-password`}
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={minLength}
        required
      />
      <label htmlFor={`${idPrefix}-confirm`}>{t('Ξανά ο κωδικός')}</label>
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
  const t = useT();
  const p = `new-${restaurantId}`;

  return (
    <form action={action} className={styles.form}>
      <input type="hidden" name="restaurantId" value={restaurantId} />
      <label htmlFor={`${p}-username`}>{t('Όνομα χρήστη')}</label>
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
      <label htmlFor={`${p}-name`}>{t('Όνομα λογαριασμού')}</label>
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
        {pending ? t('Δημιουργία…') : t('Δημιουργία λογαριασμού')}
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
  const t = useT();
  const p = `reset-${username}`;

  return (
    <details className={styles.reset}>
      <summary>{t('Νέος κωδικός')}</summary>
      <form action={action} className={styles.form}>
        <input type="hidden" name="userId" value={userId} />
        <PasswordFields idPrefix={p} minLength={minLength} />
        <Result state={state} />
        <button type="submit" disabled={pending}>
          {pending ? t('Αποθήκευση…') : t('Ορισμός κωδικού')}
        </button>
      </form>
    </details>
  );
}
