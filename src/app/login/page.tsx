'use client';

import { useActionState } from 'react';
import { loginAction, type LoginFormState } from './actions';
import styles from './page.module.css';

const initial: LoginFormState = { error: null };

export default function LoginPage() {
  const [state, action, pending] = useActionState(loginAction, initial);

  return (
    <main className={styles.page}>
      <h1 className={styles.heading}>Digital ZET</h1>
      <p className={styles.sub}>Σύνδεση</p>

      <form action={action} className={styles.form}>
        <label htmlFor="username">Όνομα χρήστη</label>
        <input
          id="username"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          required
        />

        <label htmlFor="password">Κωδικός</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />

        {state.error && (
          <p role="alert" className={styles.error}>
            {state.error}
          </p>
        )}

        <button type="submit" disabled={pending}>
          {pending ? 'Σύνδεση…' : 'Σύνδεση'}
        </button>
      </form>
    </main>
  );
}
