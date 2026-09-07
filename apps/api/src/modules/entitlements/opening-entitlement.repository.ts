import type { QueryExecutor } from '@creatordrop/database';

import type { BoxId } from '../catalog/catalog.js';
import type { UserId } from '../creators/creator.js';

export interface OpeningEntitlementState {
  readonly boxId: BoxId;
  readonly consumed: string;
  readonly granted: string;
  readonly remaining: string;
}

export interface GrantOpeningEntitlementInput {
  readonly boxId: string;
  readonly creatorId: string;
  readonly grantedByUserId: string | null;
  readonly grantId: string;
  readonly quantity: bigint;
  readonly reason: string;
  readonly sourceIdentity: string;
  readonly sourceType: string;
  readonly userId: string;
}

export interface GrantOpeningEntitlementResult {
  readonly id: string;
  readonly replayed: boolean;
}

const canonicalNonnegativeDecimal = /^(?:0|[1-9][0-9]*)$/u;

const decimal = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !canonicalNonnegativeDecimal.test(value)) {
    throw new Error(`Database returned invalid entitlement ${field}.`);
  }
  return value;
};

export const grantOpeningEntitlement = async (
  executor: QueryExecutor,
  input: GrantOpeningEntitlementInput,
): Promise<GrantOpeningEntitlementResult> => {
  const result = await executor.query<{ readonly id: unknown; readonly replayed: unknown }>(
    `select id::text, replayed
       from app_private.grant_opening_entitlement($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      input.grantId,
      input.userId,
      input.creatorId,
      input.boxId,
      input.quantity.toString(),
      input.sourceType,
      input.sourceIdentity,
      input.grantedByUserId,
      input.reason,
    ],
  );
  const row = result.rows[0];
  if (row === undefined || typeof row.id !== 'string' || typeof row.replayed !== 'boolean') {
    throw new Error('Database returned an invalid opening entitlement grant result.');
  }
  return { id: row.id, replayed: row.replayed };
};

export const readOpeningEntitlementState = async (
  executor: QueryExecutor,
  userId: UserId,
  boxId: BoxId,
): Promise<OpeningEntitlementState> => {
  const result = await executor.query<{
    readonly boxId: unknown;
    readonly consumed: unknown;
    readonly granted: unknown;
    readonly remaining: unknown;
  }>(
    `select box_id::text as "boxId", granted::text, consumed::text, remaining::text
       from app_private.read_opening_entitlement_state($1, $2)`,
    [userId, boxId],
  );
  const row = result.rows[0];
  if (row === undefined || typeof row.boxId !== 'string' || row.boxId !== boxId) {
    throw new Error('Database returned invalid entitlement scope.');
  }
  return {
    boxId,
    consumed: decimal(row.consumed, 'consumed quantity'),
    granted: decimal(row.granted, 'granted quantity'),
    remaining: decimal(row.remaining, 'remaining quantity'),
  };
};
