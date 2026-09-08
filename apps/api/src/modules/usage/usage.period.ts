import type { CreatorUsageQuery, CreatorUsageResponse } from '@creatordrop/contracts';

export const resolveUsageRange = (
  query: CreatorUsageQuery,
  now: Date,
): CreatorUsageResponse['usage']['range'] => {
  const end = now.toISOString();
  const monthStart = new Date(now);
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  switch (query.period) {
    case 'lifetime':
      return { period: query.period, start: null, end };
    case 'current_month':
      return { period: query.period, start: monthStart.toISOString(), end };
    case 'previous_month': {
      const previous = new Date(monthStart);
      previous.setUTCMonth(previous.getUTCMonth() - 1);
      return { period: query.period, start: previous.toISOString(), end: monthStart.toISOString() };
    }
    case 'last_30_days':
      return {
        period: query.period,
        start: new Date(now.getTime() - 30 * 86_400_000).toISOString(),
        end,
      };
    case 'custom': {
      if (query.start === undefined || query.end === undefined)
        throw new Error('Missing validated custom range.');
      return {
        period: query.period,
        start: new Date(query.start).toISOString(),
        end: new Date(query.end).toISOString(),
      };
    }
  }
};
