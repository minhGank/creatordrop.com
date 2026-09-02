import { createContext } from 'react';

import type { AuthSessionResponse } from '@creatordrop/contracts';

export type SessionState =
  | { readonly status: 'anonymous' }
  | { readonly message: string; readonly status: 'error' }
  | { readonly status: 'loading' }
  | { readonly status: 'authenticated'; readonly user: AuthSessionResponse['user'] };

export interface SessionContextValue {
  readonly state: SessionState;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  signUp(email: string, password: string): Promise<'authenticated' | 'confirmation-required'>;
}

export const SessionContext = createContext<SessionContextValue | null>(null);
