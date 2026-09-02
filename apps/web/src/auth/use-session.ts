import { useContext } from 'react';

import { SessionContext, type SessionContextValue } from './session-context-value.js';

export const useSession = (): SessionContextValue => {
  const context = useContext(SessionContext);
  if (context === null) throw new Error('useSession must be used inside SessionProvider.');
  return context;
};
