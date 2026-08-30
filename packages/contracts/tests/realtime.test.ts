import { describe, expect, it } from 'vitest';

import {
  parseRealtimeDropSubscription,
  parseRealtimePublishCommand,
  RealtimeContractError,
} from '../src/index.js';

const eventId = '019d0000-0000-7000-8000-000000000001';
const creatorId = '019d0000-0000-7000-8000-000000000002';

describe('realtime contracts', () => {
  it('accepts an exact sanitized drop event and creator subscription', () => {
    expect(
      parseRealtimePublishCommand({
        event: {
          data: {
            boxId: '019d0000-0000-7000-8000-000000000003',
            creatorId,
            openingId: '019d0000-0000-7000-8000-000000000004',
            reward: {
              imageUrl: 'https://images.example.test/reward.png',
              name: 'Synthetic Reward',
              rewardId: '019d0000-0000-7000-8000-000000000005',
            },
          },
          eventId,
          occurredAt: '2026-08-29T12:00:00.000Z',
          type: 'drop.created.v1',
          version: 1,
        },
        target: { creatorId, kind: 'drop' },
      }),
    ).toMatchObject({ event: { eventId, version: 1 } });
    expect(parseRealtimeDropSubscription({ creatorId, scope: 'creator' })).toEqual({
      creatorId,
      scope: 'creator',
    });
  });

  it.each([
    { reason: 'unknown event field', value: { event: {}, target: {}, token: 'secret' } },
    {
      reason: 'target mismatch',
      value: {
        event: {
          data: {
            boxId: '019d0000-0000-7000-8000-000000000003',
            creatorId,
            openingId: '019d0000-0000-7000-8000-000000000004',
            reward: {
              imageUrl: null,
              name: 'Synthetic Reward',
              rewardId: '019d0000-0000-7000-8000-000000000005',
            },
          },
          eventId,
          occurredAt: '2026-08-29T12:00:00.000Z',
          type: 'drop.created.v1',
          version: 1,
        },
        target: {
          creatorId: '019d0000-0000-7000-8000-000000000099',
          kind: 'drop',
        },
      },
    },
    {
      reason: 'secret payload field',
      value: {
        event: {
          data: {
            boxId: '019d0000-0000-7000-8000-000000000003',
            creatorId,
            openingId: '019d0000-0000-7000-8000-000000000004',
            reward: {
              imageUrl: null,
              name: 'Synthetic Reward',
              rewardId: '019d0000-0000-7000-8000-000000000005',
            },
            serverSeed: 'not-allowed',
          },
          eventId,
          occurredAt: '2026-08-29T12:00:00.000Z',
          type: 'drop.created.v1',
          version: 1,
        },
        target: { creatorId, kind: 'drop' },
      },
    },
  ])('rejects $reason', ({ value }) => {
    expect(() => parseRealtimePublishCommand(value)).toThrow(RealtimeContractError);
  });
});
