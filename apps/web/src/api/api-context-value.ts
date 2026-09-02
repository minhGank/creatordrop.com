import { createContext } from 'react';

import type { CreatorDropApiClient } from './client.js';

export const ApiContext = createContext<CreatorDropApiClient | null>(null);
