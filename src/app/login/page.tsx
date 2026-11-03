'use client';

import { useActionState } from 'react';
import { loginAction, type LoginFormState } from './actions';
import { useT } from '../../components/LangProvider';
import styles from './page.module.css';

const initial: LoginFormState = { error: null };

export default function LoginPage() {
  const [state, action, pending] = useActionState(loginAction, initial);
  const t = useT();

  return (
    <main className={styles.page}>
      <h1 className={styles.heading}>Digital ZET</h1>
      <p className={styles.sub}>{t('Σύνδεση')}</p>

      <form action={action} className={styles.form}>
        <label htmlFor="username">{t('Όνομα χρήστη')}</label>
        <input
          id="username"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          required
        />

        <label htmlFor="password">{t('Κωδικός')}</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />

        {state.error && (
          <p role="alert" className={styles.error}>
            {t(state.error)}
          </p>
        )}

        <button type="submit" disabled={pending}>
          {pending ? t('Σύνδεση…') : t('Σύνδεση')}
        </button>
      </form>
    </main>
  );
}
