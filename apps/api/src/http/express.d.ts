import type { AuthenticatedActor } from '../modules/auth/authentication.js';

declare global {
  namespace Express {
    interface Request {
      actor?: AuthenticatedActor;
      requestId: string;
    }
  }
}

export {};
