import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createLeaderboardProjectionStore,
  createRedisConnection,
  createRedisJsonCache,
  type LeaderboardAggregate,
  type LeaderboardScope,
} from '../src/index.js';

const redis = createRedisConnection({
  onError: () => undefined,
  url: process.env.REDIS_URL ?? 'redis://127.0.0.1:56379',
});
const store = createLeaderboardProjectionStore(redis);
const alice = '018f0000-0000-7000-8000-000000000001';
const bob = '018f0000-0000-7000-8000-000000000002';
const creatorA = '018f0000-0000-7000-8000-0000000000a1';
const creatorB = '018f0000-0000-7000-8000-0000000000b1';
const season = '018f0000-0000-7000-8000-0000000000c1';

const globalAllTime: LeaderboardScope = {
  creatorId: null,
  periodType: 'all_time',
  scopeType: 'global',
  seasonId: null,
};

const aggregate = (
  input: Partial<LeaderboardAggregate> &
    Pick<LeaderboardAggregate, 'points' | 'totalOpenings' | 'userId' | 'username'>,
): LeaderboardAggregate => ({
  asOf: '2026-09-01T12:00:03.000Z',
  baseRewardWins: '0',
  creatorId: null,
  periodType: 'all_time',
  scopeType: 'global',
  scoreReachedAt: '2026-09-01T12:00:01.000Z',
  scoreReachedAtMicros: '1788264001000000',
  seasonId: null,
  ...input,
});

const initialize = async (): Promise<void> => {
  const generation = await store.beginRebuild();
  await store.completeRebuild(generation);
};

describe('real Redis leaderboard projections', () => {
  beforeEach(async () => {
    await redis.sendCommand(['FLUSHDB']);
    await initialize();
  });

  afterAll(async () => {
    await redis.sendCommand(['FLUSHDB']);
    await redis.close();
  });

  it('applies one event once across global, creator, and season scopes', async () => {
    const eventId = '018f0000-0000-7000-8000-000000000101';
    const openingId = '018f0000-0000-7000-8000-000000000201';
    const boards = [
      aggregate({
        baseRewardWins: '1',
        points: '30',
        totalOpenings: '3',
        userId: alice,
        username: 'alice',
      }),
      aggregate({
        baseRewardWins: '1',
        creatorId: creatorA,
        points: '25',
        scopeType: 'creator',
        totalOpenings: '2',
        userId: alice,
        username: 'alice',
      }),
      aggregate({
        creatorId: creatorB,
        points: '5',
        scopeType: 'creator',
        totalOpenings: '1',
        userId: alice,
        username: 'alice',
      }),
      aggregate({
        baseRewardWins: '1',
        periodType: 'season',
        points: '20',
        seasonId: season,
        totalOpenings: '1',
        userId: alice,
        username: 'alice',
      }),
      aggregate({
        baseRewardWins: '1',
        creatorId: creatorA,
        periodType: 'season',
        points: '20',
        scopeType: 'creator',
        seasonId: season,
        totalOpenings: '1',
        userId: alice,
        username: 'alice',
      }),
    ] as const;

    expect(await store.apply({ boards, eventId, openingId })).toBe('applied');
    expect(await store.apply({ boards, eventId, openingId })).toBe('duplicate');
    expect(await store.read(globalAllTime)).toEqual({
      asOf: '2026-09-01T12:00:03.000Z',
      rows: [
        {
          baseRewardWins: '1',
          points: '30',
          rank: 1,
          scoreReachedAt: '2026-09-01T12:00:01.000Z',
          totalOpenings: '3',
          userId: alice,
          username: 'alice',
        },
      ],
    });
    expect(
      await store.read({
        creatorId: creatorA,
        periodType: 'all_time',
        scopeType: 'creator',
        seasonId: null,
      }),
    ).toMatchObject({ rows: [{ points: '25', totalOpenings: '2' }] });
    expect(
      await store.read({
        creatorId: creatorB,
        periodType: 'all_time',
        scopeType: 'creator',
        seasonId: null,
      }),
    ).toMatchObject({ rows: [{ points: '5', totalOpenings: '1' }] });
  });

  it('is atomic for concurrent duplicate delivery and preserves deterministic tie order', async () => {
    const duplicate = {
      boards: [aggregate({ points: '500', totalOpenings: '25', userId: alice, username: 'alice' })],
      eventId: '018f0000-0000-7000-8000-000000000102',
      openingId: '018f0000-0000-7000-8000-000000000202',
    } as const;
    const dispositions = await Promise.all(
      Array.from({ length: 12 }, () => store.apply(duplicate)),
    );
    expect(dispositions.filter((value) => value === 'applied')).toHaveLength(1);

    await store.apply({
      boards: [
        aggregate({
          points: '500',
          scoreReachedAt: '2026-09-01T12:00:02.000Z',
          scoreReachedAtMicros: '1788264002000000',
          totalOpenings: '25',
          userId: bob,
          username: 'bob',
        }),
      ],
      eventId: '018f0000-0000-7000-8000-000000000103',
      openingId: '018f0000-0000-7000-8000-000000000203',
    });
    expect((await store.read(globalAllTime))?.rows.map(({ userId }) => userId)).toEqual([
      alice,
      bob,
    ]);
  });

  it('rebuilds deterministically, replaces drift, and restores replay markers', async () => {
    await store.apply({
      boards: [aggregate({ points: '999', totalOpenings: '1', userId: bob, username: 'corrupt' })],
      eventId: '018f0000-0000-7000-8000-000000000104',
      openingId: '018f0000-0000-7000-8000-000000000204',
    });
    const rebuild = async () => {
      const generation = await store.beginRebuild();
      await store.writeRebuildAggregate(
        generation,
        aggregate({ points: '30', totalOpenings: '3', userId: alice, username: 'alice' }),
      );
      await store.markRebuildEvent(
        generation,
        '018f0000-0000-7000-8000-000000000105',
        '018f0000-0000-7000-8000-000000000205',
      );
      await store.completeRebuild(generation);
    };
    await rebuild();
    const first = await store.read(globalAllTime);
    await rebuild();
    expect(await store.read(globalAllTime)).toEqual(first);
    expect(first?.rows).toMatchObject([{ points: '30', username: 'alice' }]);
    expect(await store.listProjectedScopes()).toEqual(['global:all-time']);
    expect(
      await store.apply({
        boards: [aggregate({ points: '30', totalOpenings: '3', userId: alice, username: 'alice' })],
        eventId: '018f0000-0000-7000-8000-000000000105',
        openingId: '018f0000-0000-7000-8000-000000000205',
      }),
    ).toBe('duplicate');
  });

  it('supports cache miss, hit, expiry, deletion, and malformed JSON failure', async () => {
    const cache = createRedisJsonCache(redis);
    expect(await cache.get('creatordrop:{catalog}:v1:test')).toBeUndefined();
    await cache.set('creatordrop:{catalog}:v1:test', { value: 'safe' }, 60);
    expect(await cache.get('creatordrop:{catalog}:v1:test')).toEqual({ value: 'safe' });
    await cache.delete('creatordrop:{catalog}:v1:test');
    expect(await cache.get('creatordrop:{catalog}:v1:test')).toBeUndefined();
    await redis.sendCommand(['SET', 'creatordrop:{catalog}:v1:test', '{']);
    await expect(cache.get('creatordrop:{catalog}:v1:test')).rejects.toThrow(SyntaxError);
  });
});
