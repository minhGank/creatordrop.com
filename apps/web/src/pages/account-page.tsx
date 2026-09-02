import { Navigate, useLocation } from 'react-router-dom';

import { useSession } from '../auth/use-session.js';
import { ErrorState, LoadingState } from '../components/page-states.js';

export const AccountPage = () => {
  const session = useSession();
  const location = useLocation();
  if (session.state.status === 'loading') return <LoadingState label="Restoring your session" />;
  if (session.state.status === 'error')
    return <ErrorState error={new Error(session.state.message)} />;
  if (session.state.status === 'anonymous') {
    return <Navigate to="/auth" replace state={{ from: location.pathname }} />;
  }
  return (
    <div className="page narrow-page">
      <section className="account-card">
        <p className="eyebrow">Authenticated account</p>
        <h1>{session.state.user.username}</h1>
        <p>
          Your session is active. Private product workflows remain backend-authorized and arrive in
          later phases.
        </p>
      </section>
    </div>
  );
};
