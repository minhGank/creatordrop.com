import type { TransactionExecutor } from '@creatordrop/database';
import type { BoxId, BoxVersionId } from '../catalog/catalog.js';
import type { CreatorId } from '../creators/creator.js';
import type { OpeningId } from '../openings/opening.js';

/** Future allowances must be checked atomically here, using this transaction and no network calls.
 * Adding allowance locks requires an explicit global lock-order review. R4 has no commercial limit.
 */
export interface CreatorOpeningCapacity {
  check(
    transaction: TransactionExecutor,
    context: {
      readonly creatorId: CreatorId;
      readonly boxId: BoxId;
      readonly boxVersionId: BoxVersionId;
      readonly openingId: OpeningId;
      readonly occurredAt: string;
    },
  ): Promise<void>;
}
export const unrestrictedCreatorOpeningCapacity: CreatorOpeningCapacity = {
  check: () => Promise.resolve(),
};
