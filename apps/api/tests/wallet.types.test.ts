import { describe, expectTypeOf, it } from 'vitest';

import type { Database, TransactionExecutor } from '@creatordrop/database';

import type {
  creditWallet,
  debitWallet,
  reverseLedgerTransaction,
} from '../src/modules/wallet/wallet.service.js';

describe('wallet transaction ownership', () => {
  it('requires the branded caller-owned transaction executor for all financial mutations', () => {
    expectTypeOf<Database>().not.toExtend<TransactionExecutor>();
    expectTypeOf<Parameters<typeof creditWallet>[0]>().toEqualTypeOf<TransactionExecutor>();
    expectTypeOf<Parameters<typeof debitWallet>[0]>().toEqualTypeOf<TransactionExecutor>();
    expectTypeOf<
      Parameters<typeof reverseLedgerTransaction>[0]
    >().toEqualTypeOf<TransactionExecutor>();
  });
});
