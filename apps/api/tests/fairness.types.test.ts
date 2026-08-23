import { describe, expectTypeOf, it } from 'vitest';

import type { Database, TransactionExecutor } from '@creatordrop/database';

import { allocateNextNonce } from '../src/modules/fairness/fairness.service.js';
import type { UserId } from '../src/modules/creators/creator.js';

describe('fairness transaction types', () => {
  it('does not allow a pool-backed database where a transaction executor is required', () => {
    expectTypeOf<Database>().not.toExtend<TransactionExecutor>();
    expectTypeOf<Parameters<typeof allocateNextNonce>[0]>().toEqualTypeOf<TransactionExecutor>();
  });
});

const compileTimeMisuseMustFail = (database: Database, userId: UserId): void => {
  // @ts-expect-error The nonce allocator intentionally rejects autocommit database executors.
  void allocateNextNonce(database, { userId });
};

void compileTimeMisuseMustFail;
