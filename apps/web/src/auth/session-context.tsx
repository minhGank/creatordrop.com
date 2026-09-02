import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { CreatorDropApiError, type CreatorDropApiClient } from '../api/client.js';
import type { BrowserAuthClient, BrowserAuthSession } from './auth-client.js';
import {
  SessionContext,
  type SessionContextValue,
  type SessionState,
} from './session-context-value.js';

export const SessionProvider = ({
  apiClient,
  authClient,
  children,
}: {
  readonly apiClient: CreatorDropApiClient;
  readonly authClient: BrowserAuthClient;
  readonly children: ReactNode;
}) => {
  const [state, setState] = useState<SessionState>({ status: 'loading' });
  const generation = useRef(0);

  const resolveSession = useCallback(
    async (session: BrowserAuthSession | null): Promise<void> => {
      const currentGeneration = ++generation.current;
      if (session === null) {
        setState({ status: 'anonymous' });
        return;
      }
      setState({ status: 'loading' });
      try {
        const response = await apiClient.exchangeSession(session.accessToken);
        if (currentGeneration === generation.current) {
          setState({ status: 'authenticated', user: response.user });
        }
      } catch (error) {
        if (currentGeneration !== generation.current) return;
        if (error instanceof CreatorDropApiError && error.status === 401) {
          await authClient.signOut().catch(() => undefined);
          setState({ status: 'anonymous' });
          return;
        }
        setState({
          message:
            error instanceof Error
              ? error.message
              : 'The current session could not be restored. Please try again.',
          status: 'error',
        });
      }
    },
    [apiClient, authClient],
  );

  useEffect(() => {
    let active = true;
    void authClient
      .getSession()
      .then((session) => (active ? resolveSession(session) : undefined))
      .catch((error: unknown) => {
        if (!active) return;
        setState({
          message:
            error instanceof Error
              ? error.message
              : 'The current session could not be restored. Please try again.',
          status: 'error',
        });
      });
    const unsubscribe = authClient.onSessionChange((session) => {
      if (active) void resolveSession(session);
    });
    return () => {
      active = false;
      generation.current += 1;
      unsubscribe();
    };
  }, [authClient, resolveSession]);

  const value = useMemo<SessionContextValue>(
    () => ({
      signIn: async (email, password) => {
        const result = await authClient.signIn(email, password);
        await resolveSession(result.session);
      },
      signOut: async () => {
        generation.current += 1;
        await authClient.signOut();
        setState({ status: 'anonymous' });
      },
      signUp: async (email, password) => {
        const result = await authClient.signUp(email, password);
        if (result.confirmationRequired) {
          setState({ status: 'anonymous' });
          return 'confirmation-required';
        }
        await resolveSession(result.session);
        return 'authenticated';
      },
      state,
    }),
    [authClient, resolveSession, state],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
};
