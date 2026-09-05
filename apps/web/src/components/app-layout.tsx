import { useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';

import creatorDropLogoUrl from '../assets/creator-drop-logo.svg';
import { useSession } from '../auth/use-session.js';

export const AppLayout = ({ children }: { readonly children: ReactNode }) => {
  const session = useSession();
  const [signOutError, setSignOutError] = useState<string | null>(null);

  const signOut = (): void => {
    setSignOutError(null);
    void session.signOut().catch(() => {
      setSignOutError('Sign out could not be completed. Please try again.');
    });
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="site-header">
        <Link className="brand" to="/" aria-label="CreatorDrop home">
          <img className="brand-logo" src={creatorDropLogoUrl} alt="" aria-hidden="true" />
        </Link>
        <nav aria-label="Primary navigation">
          <NavLink to="/creators">Creators</NavLink>
          {session.state.status === 'authenticated' ? (
            <>
              <NavLink to="/account">Account</NavLink>
              <button className="nav-button" type="button" onClick={signOut}>
                Sign out
              </button>
            </>
          ) : session.state.status === 'loading' ? (
            <span className="nav-session" aria-label="Restoring session">
              Checking session…
            </span>
          ) : (
            <NavLink to="/auth">Sign in</NavLink>
          )}
        </nav>
      </header>
      {signOutError === null ? null : (
        <p className="banner-error" role="alert">
          {signOutError}
        </p>
      )}
      <main id="main-content">{children}</main>
      <footer className="site-footer">
        <p>
          Published odds are immutable snapshots. Opening eligibility is always
          server-authoritative.
        </p>
      </footer>
    </div>
  );
};
