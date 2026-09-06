import { useCallback, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import type { WalletContract } from '@creatordrop/contracts';

import { useApiResource } from '../api/use-api-resource.js';
import { useApi } from '../api/use-api.js';
import { useSession } from '../auth/use-session.js';
import { ErrorState, LoadingState } from '../components/page-states.js';
import { formatMinorUnits } from '../formatting/money.js';

const TestCreditsPanel = () => {
  const api = useApi();
  const loadWallets = useCallback((signal: AbortSignal) => api.listWallets(signal), [api]);
  const wallets = useApiResource(loadWallets);
  const [grantState, setGrantState] = useState<
    | { readonly status: 'idle' }
    | { readonly status: 'pending' }
    | { readonly message: string; readonly status: 'error' | 'success' }
  >({ status: 'idle' });

  const grantTestCredits = (): void => {
    setGrantState({ status: 'pending' });
    const idempotencyKey = `wallet_test_credit_${globalThis.crypto.randomUUID()}`;
    void api
      .grantUsdTestCredits(idempotencyKey)
      .then(() => {
        setGrantState({ message: 'Added $1,000.00 in test credits.', status: 'success' });
        wallets.reload();
      })
      .catch((error: unknown) => {
        setGrantState({
          message: error instanceof Error ? error.message : 'Test credits could not be added.',
          status: 'error',
        });
      });
  };

  const usdWallet: WalletContract | undefined =
    wallets.state.status === 'success'
      ? wallets.state.data.wallets.find((wallet) => wallet.currency === 'USD')
      : undefined;

  return (
    <section className="dev-credit-panel" aria-labelledby="dev-credit-heading">
      <p className="eyebrow">DEV ONLY</p>
      <h2 id="dev-credit-heading">Local test credits</h2>
      {wallets.state.status === 'loading' ? (
        <p role="status">Loading USD wallet balance…</p>
      ) : wallets.state.status === 'error' ? (
        <p className="inline-error" role="alert">
          {wallets.state.error.message}{' '}
          <button type="button" onClick={wallets.reload}>
            Retry balance
          </button>
        </p>
      ) : (
        <p className="wallet-balance">
          USD wallet balance:{' '}
          <strong>
            {usdWallet === undefined
              ? 'No wallet yet'
              : formatMinorUnits(usdWallet.balanceMinor, 'USD')}
          </strong>
        </p>
      )}
      <button
        className="button secondary"
        disabled={grantState.status === 'pending'}
        type="button"
        onClick={grantTestCredits}
      >
        {grantState.status === 'pending'
          ? 'Adding test credits…'
          : 'DEV ONLY — Add $1,000 Test Credits'}
      </button>
      {grantState.status === 'error' ? (
        <p className="inline-error" role="alert">
          {grantState.message}
        </p>
      ) : grantState.status === 'success' ? (
        <p className="inline-notice" role="status">
          {grantState.message}
        </p>
      ) : null}
    </section>
  );
};

export const AccountPage = ({ testCreditsEnabled }: { readonly testCreditsEnabled: boolean }) => {
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
      {testCreditsEnabled ? <TestCreditsPanel /> : null}
    </div>
  );
};
