import { creatorUsageDataSchema } from '@creatordrop/contracts';
import type { QueryExecutor } from '@creatordrop/database';
import { UsageAccountNotActiveError } from './usage.errors.js';
import { CreatorNotFoundError, CreatorPermissionDeniedError } from '../creators/creator.errors.js';
import type { CreatorScope } from '../creators/creator.js';

export const readCreatorUsage = async (
  database: QueryExecutor,
  input: CreatorScope & {
    readonly start: string | null;
    readonly end: string;
    readonly asOf: string;
    readonly after: string | undefined;
    readonly limit: number;
  },
) => {
  try {
    const result = await database.query<{ usage: unknown }>(
      `select app.read_creator_hosted_usage($1::uuid,$2::uuid,$3::timestamptz,$4::timestamptz,$5::timestamptz,$6::uuid,$7::integer) as usage`,
      [
        input.actorUserId,
        input.creatorId,
        input.start,
        input.end,
        input.asOf,
        input.after ?? null,
        input.limit,
      ],
    );
    return creatorUsageDataSchema.parse(result.rows[0]?.usage);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      if (error.code === 'P4103') throw new UsageAccountNotActiveError();
      if (error.code === 'P4104') throw new CreatorNotFoundError();
      if (error.code === 'P4105') throw new CreatorPermissionDeniedError();
    }
    throw error;
  }
};

/** Keep analytics cutoffs on PostgreSQL's clock, like the immutable opening timestamps. */
export const readUsageTimestamp = async (database: QueryExecutor): Promise<Date> => {
  const result = await database.query<{ value: unknown }>('select statement_timestamp() as value');
  const value = result.rows[0]?.value;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new Error('Invalid database usage timestamp.');
  return value;
};
