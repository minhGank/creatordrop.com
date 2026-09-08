import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { creatorUsageQuerySchema, creatorUsageResponseSchema } from '@creatordrop/contracts';
import { resolveUsageRange } from '../src/modules/usage/usage.period.js';
import { accountNotActive, authenticationRequired } from '../src/http/errors.js';
import {
  CreatorNotFoundError,
  CreatorPermissionDeniedError,
} from '../src/modules/creators/creator.errors.js';
import { createTestApp } from './support/test-app.js';

const creatorId = '019c0000-0000-7000-8000-000000000002';
const now = new Date('2028-03-01T00:00:00.000Z');
const zero = { hostedOpenings: '0', creatorEntitlementOpenings: '0', universalEntryOpenings: '0' };
const response = {
  usage: {
    asOf: now.toISOString(),
    range: { period: 'current_month' as const, start: now.toISOString(), end: now.toISOString() },
    totals: {
      lifetime: zero,
      currentMonth: zero,
      previousMonth: zero,
      last30Days: zero,
      selected: zero,
    },
    drops: [],
    nextCursor: null,
  },
};
describe('R4 UTC ranges and contract', () => {
  it.each([
    ['lifetime', null, now.toISOString()],
    ['current_month', now.toISOString(), now.toISOString()],
    ['previous_month', '2028-02-01T00:00:00.000Z', now.toISOString()],
    ['last_30_days', '2028-01-31T00:00:00.000Z', now.toISOString()],
  ])('resolves %s at a leap-year month boundary', (period, start, end) => {
    expect(resolveUsageRange(creatorUsageQuerySchema.parse({ period }), now)).toEqual({
      period,
      start,
      end,
    });
  });
  it('handles the year boundary and explicit timezone offsets', () => {
    expect(
      resolveUsageRange(
        creatorUsageQuerySchema.parse({ period: 'previous_month' }),
        new Date('2027-01-15T12:00:00Z'),
      ),
    ).toEqual({
      period: 'previous_month',
      start: '2026-12-01T00:00:00.000Z',
      end: '2027-01-01T00:00:00.000Z',
    });
    expect(
      resolveUsageRange(
        creatorUsageQuerySchema.parse({
          period: 'custom',
          start: '2026-09-01T02:00:00+02:00',
          end: '2026-10-01T02:00:00+02:00',
        }),
        now,
      ),
    ).toEqual({
      period: 'custom',
      start: '2026-09-01T00:00:00.000Z',
      end: '2026-10-01T00:00:00.000Z',
    });
  });
  it('rejects leaked fields and inconsistent source counts', () => {
    expect(creatorUsageResponseSchema.safeParse(response).success).toBe(true);
    expect(
      creatorUsageResponseSchema.safeParse({
        usage: {
          ...response.usage,
          totals: { ...response.usage.totals, selected: { ...zero, hostedOpenings: 'invalid' } },
        },
      }).success,
    ).toBe(false);

    expect(
      creatorUsageResponseSchema.safeParse({ usage: { ...response.usage, userId: creatorId } })
        .success,
    ).toBe(false);
    expect(
      creatorUsageResponseSchema.safeParse({
        usage: {
          ...response.usage,
          totals: { ...response.usage.totals, selected: { ...zero, hostedOpenings: '1' } },
        },
      }).success,
    ).toBe(false);
  });
});
describe('R4 usage HTTP boundary', () => {
  it('uses the authenticated actor and sends a private uncached response', async () => {
    const read = vi.fn(() => Promise.resolve(response));
    const result = await request(createTestApp({ usageService: { read } }))
      .get(`/v1/creators/${creatorId}/usage`)
      .expect(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.body).toEqual(response);
    expect(read).toHaveBeenCalledWith(
      { creatorId, actorUserId: '019c0000-0000-7000-8000-000000000001' },
      { period: 'current_month', limit: '25' },
    );
  });
  it.each([
    '?userId=arbitrary',
    '?period=billing',
    '?period=custom&start=2026-01-01T00:00:00.0005Z&end=2026-03-04T00:00:00Z',
    '?period=custom&start=0000-01-01T00:00:00Z&end=2026-03-04T00:00:00Z',
    '?period=custom',
    '?start=2026-01-01T00:00:00Z',
    '?period=custom&start=2026-01-02T00:00:00Z&end=2026-01-01T00:00:00Z',
    '?period=custom&start=2026-02-30T00:00:00Z&end=2026-03-04T00:00:00Z',
    '?period=custom&start=2026-01-01&end=2026-02-01',
    '?after=garbage',
    '?limit=0',
    '?limit=101',
    '?limit=01',
    '?period=lifetime&period=current_month',
  ])('rejects invalid input %s before querying', async (query) => {
    const read = vi.fn(() => Promise.resolve(response));
    await request(createTestApp({ usageService: { read } }))
      .get(`/v1/creators/${creatorId}/usage${query}`)
      .expect(400);
    expect(read).not.toHaveBeenCalled();
  });
  it.each([
    [authenticationRequired(), 401],
    [accountNotActive(), 403],
  ] as const)('preserves authentication policy %s', async (error, status) => {
    const read = vi.fn(() => Promise.resolve(response));
    await request(
      createTestApp({ authenticate: (_r, _s, next) => next(error), usageService: { read } }),
    )
      .get(`/v1/creators/${creatorId}/usage`)
      .expect(status);
    expect(read).not.toHaveBeenCalled();
  });
  it.each([
    [new CreatorNotFoundError(), 404],
    [new CreatorPermissionDeniedError(), 403],
  ] as const)('maps scoped denial %s', async (error, status) => {
    await request(createTestApp({ usageService: { read: () => Promise.reject(error) } }))
      .get(`/v1/creators/${creatorId}/usage`)
      .expect(status);
  });
  it('has no client usage mutation route', async () => {
    await request(createTestApp({ usageService: { read: () => Promise.resolve(response) } }))
      .post(`/v1/creators/${creatorId}/usage`)
      .send({ increment: 1 })
      .expect(404);
  });
});
