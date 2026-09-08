import { createClient, type Session } from '@supabase/supabase-js';

export interface BrowserAuthSession {
  readonly accessToken: string;
}

export interface AuthOperationResult {
  readonly confirmationRequired: boolean;
  readonly session: BrowserAuthSession | null;
}

export interface BrowserAuthClient {
  getAccessToken(): Promise<string | null>;
  getSession(): Promise<BrowserAuthSession | null>;
  onSessionChange(listener: (session: BrowserAuthSession | null) => void): () => void;
  signIn(email: string, password: string): Promise<AuthOperationResult>;
  signOut(): Promise<void>;
  signUp(email: string, password: string): Promise<AuthOperationResult>;
}

export class AuthenticationProviderError extends Error {
  constructor() {
    super('Authentication could not be completed. Check your details and try again.');
    this.name = 'AuthenticationProviderError';
  }
}

const publicSession = (session: Session | null): BrowserAuthSession | null =>
  session === null ? null : { accessToken: session.access_token };

const requireSuccess = (error: Error | null): void => {
  if (error !== null) throw new AuthenticationProviderError();
};

export const createSupabaseBrowserAuthClient = ({
  publishableKey,
  storage,
  url,
}: {
  readonly publishableKey: string;
  readonly storage: Storage;
  readonly url: string;
}): BrowserAuthClient => {
  const client = createClient(url, publishableKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: false,
      persistSession: true,
      storage,
    },
  });

  const getSession = async (): Promise<BrowserAuthSession | null> => {
    const result = await client.auth.getSession();
    requireSuccess(result.error);
    return publicSession(result.data.session);
  };

  return {
    getAccessToken: async () => (await getSession())?.accessToken ?? null,
    getSession,
    onSessionChange: (listener) => {
      let active = true;
      let generation = 0;
      const subscription = client.auth.onAuthStateChange(() => {
        const currentGeneration = ++generation;
        // Auth broadcasts also reach tabs with different sessionStorage sessions.
        // Resolve this tab's session, just as authenticated API requests do. Do not
        // await the read inside the SDK notification/refresh callback.
        queueMicrotask(() => {
          if (!active || currentGeneration !== generation) return;
          void getSession().then(
            (session) => {
              if (active && currentGeneration === generation) listener(session);
            },
            () => {
              if (active && currentGeneration === generation) listener(null);
            },
          );
        });
      });
      return () => {
        active = false;
        generation += 1;
        subscription.data.subscription.unsubscribe();
      };
    },
    signIn: async (email, password) => {
      const result = await client.auth.signInWithPassword({ email, password });
      requireSuccess(result.error);
      return { confirmationRequired: false, session: publicSession(result.data.session) };
    },
    signOut: async () => {
      const result = await client.auth.signOut({ scope: 'local' });
      requireSuccess(result.error);
    },
    signUp: async (email, password) => {
      const result = await client.auth.signUp({ email, password });
      requireSuccess(result.error);
      const session = publicSession(result.data.session);
      return { confirmationRequired: session === null, session };
    },
  };
};
