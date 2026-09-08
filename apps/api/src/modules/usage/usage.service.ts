import type { CreatorUsageQuery, CreatorUsageResponse } from '@creatordrop/contracts';
import type { Database } from '@creatordrop/database';
import type { CreatorScope } from '../creators/creator.js';
import { resolveUsageRange } from './usage.period.js';
import { readCreatorUsage, readUsageTimestamp } from './usage.repository.js';

export interface CreatorUsageService {
  read(scope: CreatorScope, query: CreatorUsageQuery): Promise<CreatorUsageResponse>;
}
export const createCreatorUsageService = ({
  database,
  now,
}: {
  readonly database: Database;
  readonly now?: () => Date;
}): CreatorUsageService => ({
  read: async (scope, query) => {
    const timestamp = now?.() ?? (await readUsageTimestamp(database));
    const asOf = timestamp.toISOString();
    const range = resolveUsageRange(query, timestamp);
    const data = await readCreatorUsage(database, {
      ...scope,
      start: range.start,
      end: range.end,
      asOf,
      after: query.after,
      limit: Number(query.limit),
    });
    return { usage: { ...data, asOf, range } };
  },
});
