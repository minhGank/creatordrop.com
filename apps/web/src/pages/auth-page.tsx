import { useState, type SyntheticEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { useSession } from '../auth/use-session.js';

type AuthMode = 'sign-in' | 'sign-up';

export const AuthPage = () => {
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState<AuthMode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (session.state.status === 'authenticated') {
    return (
      <div className="page narrow-page">
        <section className="state-card">
          <p className="eyebrow">Signed in</p>
          <h1>Welcome back, {session.state.user.username}</h1>
          <Link className="button primary" to="/account">
            View account
          </Link>
        </section>
      </div>
    );
  }

  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setPending(true);
    const operation =
      mode === 'sign-in' ? session.signIn(email, password) : session.signUp(email, password);
    void operation
      .then((result) => {
        if (result === 'confirmation-required') {
          setNotice('Check your email to confirm your account, then return to sign in.');
          return;
        }
        const destination = isSafeReturnPath(location.state) ? location.state.from : '/account';
        void navigate(destination, { replace: true });
      })
      .catch((failure: unknown) => {
        setError(
          failure instanceof Error
            ? failure.message
            : 'Authentication could not be completed. Please try again.',
        );
      })
      .finally(() => setPending(false));
  };

  return (
    <div className="page auth-page">
      <section className="auth-intro">
        <p className="eyebrow">Your CreatorDrop session</p>
        <h1>Sign in without giving the catalog your secrets.</h1>
        <p>
          Supabase handles account credentials. CreatorDrop receives a short-lived bearer token and
          remains the authority for every protected action.
        </p>
      </section>
      <section className="auth-card" aria-labelledby="auth-heading">
        <div className="auth-tabs" role="group" aria-label="Authentication mode">
          <button
            type="button"
            aria-label="Show sign-in form"
            aria-pressed={mode === 'sign-in'}
            onClick={() => setMode('sign-in')}
          >
            Sign in
          </button>
          <button
            type="button"
            aria-label="Show account creation form"
            aria-pressed={mode === 'sign-up'}
            onClick={() => setMode('sign-up')}
          >
            Create account
          </button>
        </div>
        <h2 id="auth-heading">{mode === 'sign-in' ? 'Welcome back' : 'Create your account'}</h2>
        <form onSubmit={submit} aria-describedby={error === null ? undefined : 'auth-error'}>
          <label htmlFor="email">Email address</label>
          <input
            autoComplete="email"
            id="email"
            name="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
          <label htmlFor="password">Password</label>
          <input
            autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
            id="password"
            minLength={8}
            name="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
          {error === null ? null : (
            <p className="inline-error" id="auth-error" role="alert">
              {error}
            </p>
          )}
          {notice === null ? null : (
            <p className="inline-notice" role="status">
              {notice}
            </p>
          )}
          <button className="button primary full-width" type="submit" disabled={pending}>
            {pending ? 'Please wait…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}
          </button>
        </form>
      </section>
    </div>
  );
};

const isSafeReturnPath = (value: unknown): value is { readonly from: string } =>
  typeof value === 'object' &&
  value !== null &&
  'from' in value &&
  typeof value.from === 'string' &&
  value.from.startsWith('/') &&
  !value.from.startsWith('//');
