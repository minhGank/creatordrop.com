import { useContext } from 'react';

import { ApiContext } from './api-context-value.js';
import type { CreatorDropApiClient } from './client.js';

export const useApi = (): CreatorDropApiClient => {
  const client = useContext(ApiContext);
  if (client === null) throw new Error('useApi must be used inside ApiProvider.');
  return client;
};
