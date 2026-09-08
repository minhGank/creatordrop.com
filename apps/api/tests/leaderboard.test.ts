import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import type { LeaderboardProjectionStore } from '@creatordrop/redis-projections';

import type { LeaderboardRepository } from '../src/modules/leaderboards/leaderboard.repository.js';
import { createLeaderboardService } from '../src/modules/leaderboards/leaderboard.service.js';
import { createNoopLogger, createTestApp } from './support/test-app.js';

const unhandledRepository = (): LeaderboardRepository => ({
  readAchievements: () => Promise.reject(new Error('Unhandled achievement read.')),
  readLeaderboard: () => Promise.reject(new Error('Unhandled leaderboard read.')),
  readSeason: () => Promise.reject(new Error('Unhandled season read.')),
});

const storeWithRead = (read: LeaderboardProjectionStore['read']): LeaderboardProjectionStore => ({
  abortRebuild: () => Promise.reject(new Error('Unhandled rebuild abort.')),
  apply: () => Promise.reject(new Error('Unhandled projection apply.')),
  beginRebuild: () => Promise.reject(new Error('Unhandled rebuild start.')),
  completeRebuild: () => Promise.reject(new Error('Unhandled rebuild completion.')),
  deleteGeneration: () => Promise.reject(new Error('Unhandled generation deletion.')),
  listProjectedScopes: () => Promise.reject(new Error('Unhandled scope read.')),
  markRebuildEvent: () => Promise.reject(new Error('Unhandled event marker.')),
  read,
  writeRebuildAggregate: () => Promise.reject(new Error('Unhandled rebuild write.')),
});

describe('public leaderboard reads', () => {
  it('retires public ranking and champion routes', async () => {
    for (const path of [
      '/v1/leaderboards/global',
      '/v1/leaderboards/creators/00000000-0000-4000-8000-000000000001',
      '/v1/users/alice/achievements',
    ]) {
      await request(createTestApp()).get(path).expect(404);
    }
  });

  it('falls back to authoritative PostgreSQL when Redis is unavailable', async () => {
    const repository = {
      ...unhandledRepository(),
      readLeaderboard: vi.fn().mockResolvedValue([
        {
          asOf: '2026-09-01T12:00:00.000Z',
          baseRewardWins: '1',
          points: '30',
          rank: 1,
          scoreReachedAt: '2026-09-01T11:00:00.000Z',
          totalOpenings: '3',
          username: 'alice',
        },
      ]),
    } satisfies LeaderboardRepository;
    const service = createLeaderboardService({
      logger: createNoopLogger(),
      repository,
      store: storeWithRead(() => Promise.reject(new Error('Redis unavailable.'))),
    });
    await expect(
      service.readLeaderboard({
        creatorId: null,
        periodType: 'all_time',
        scopeType: 'global',
        seasonId: null,
      }),
    ).resolves.toMatchObject({
      entries: [{ points: '30', user: { username: 'alice' } }],
      source: 'postgres',
    });
    expect(repository.readLeaderboard).toHaveBeenCalledOnce();
  });

  it('returns immutable public achievement history by authoritative username', async () => {
    const repository = {
      ...unhandledRepository(),
      readAchievements: vi.fn().mockResolvedValue({
        achievements: [
          {
            achievementType: 'global_season_champion',
            awardedAt: '2026-09-01T12:00:00.000Z',
            creatorId: null,
            seasonId: '018f0000-0000-7000-8000-0000000000c1',
            seasonName: 'Season One',
          },
        ],
        username: 'Alice',
      }),
    } satisfies LeaderboardRepository;
    const service = createLeaderboardService({ logger: createNoopLogger(), repository });
    await expect(service.readAchievements('alice')).resolves.toEqual({
      achievements: [
        {
          achievementType: 'global_season_champion',
          awardedAt: '2026-09-01T12:00:00.000Z',
          creatorId: null,
          season: { id: '018f0000-0000-7000-8000-0000000000c1', name: 'Season One' },
        },
      ],
      user: { username: 'Alice' },
    });
  });
});
