import type { LocalUser, TrustedIdentity } from '../users/user.js';

export interface AuthenticatedActor {
  readonly provider: string;
  readonly subject: string;
  readonly user: LocalUser & { readonly status: 'active' };
}

export type VerifyAccessToken = (accessToken: string) => Promise<TrustedIdentity>;
