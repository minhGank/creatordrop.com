import type { ReactNode } from 'react';

import type { CreatorDropApiClient } from './client.js';
import { ApiContext } from './api-context-value.js';

export const ApiProvider = ({
  children,
  client,
}: {
  readonly children: ReactNode;
  readonly client: CreatorDropApiClient;
}) => <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
