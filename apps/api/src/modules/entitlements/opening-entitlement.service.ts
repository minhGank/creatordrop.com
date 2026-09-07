import type { Database } from '@creatordrop/database';

import type { BoxId } from '../catalog/catalog.js';
import type { UserId } from '../creators/creator.js';
import {
  grantOpeningEntitlement,
  readOpeningEntitlementState,
  type GrantOpeningEntitlementInput,
  type GrantOpeningEntitlementResult,
  type OpeningEntitlementState,
} from './opening-entitlement.repository.js';

export interface OpeningEntitlementOperatorService {
  grant(input: GrantOpeningEntitlementInput): Promise<GrantOpeningEntitlementResult>;
  getState(userId: UserId, boxId: BoxId): Promise<OpeningEntitlementState>;
}

export const createOpeningEntitlementOperatorService = (
  database: Database,
): OpeningEntitlementOperatorService => ({
  getState: (userId, boxId) => readOpeningEntitlementState(database, userId, boxId),
  grant: (input) => grantOpeningEntitlement(database, input),
});
