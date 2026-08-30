import { parseRealtimePublishCommand, type RealtimePublishCommand } from '@creatordrop/contracts';

export interface ClaimedOutboxEvent {
  readonly aggregateId: string;
  readonly attemptCount: number;
  readonly audience: string;
  readonly claimToken: string;
  readonly eventType: string;
  readonly id: string;
  readonly occurredAt: string;
  readonly openingPublicId: string;
  readonly payload: unknown;
}

export interface OutboxLagSnapshot {
  readonly deadCount: bigint;
  readonly oldestReadyAgeMs: bigint;
  readonly pendingCount: bigint;
  readonly processingCount: bigint;
}

export class InvalidOutboxEventError extends Error {
  readonly failureCode: 'INVALID_EVENT' | 'UNSUPPORTED_EVENT';

  constructor(failureCode: 'INVALID_EVENT' | 'UNSUPPORTED_EVENT') {
    super('The committed outbox event cannot be published by this worker version.');
    this.name = 'InvalidOutboxEventError';
    this.failureCode = failureCode;
  }
}

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidOutboxEventError('INVALID_EVENT');
  }
  return value as Record<string, unknown>;
};

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): void => {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  if (
    actual.length !== canonicalExpected.length ||
    actual.some((key, index) => key !== canonicalExpected[index])
  ) {
    throw new InvalidOutboxEventError('INVALID_EVENT');
  }
};

export const buildRealtimePublishCommand = (event: ClaimedOutboxEvent): RealtimePublishCommand => {
  if (event.eventType === 'opening.completed.v1') {
    if (event.audience !== 'private') throw new InvalidOutboxEventError('INVALID_EVENT');
    const payload = record(event.payload);
    exactKeys(payload, [
      'boxId',
      'boxVersionId',
      'creatorId',
      'openingId',
      'rewardVersionId',
      'userId',
    ]);
    if (payload.openingId !== event.aggregateId) {
      throw new InvalidOutboxEventError('INVALID_EVENT');
    }
    try {
      return parseRealtimePublishCommand({
        event: {
          data: {
            boxId: payload.boxId,
            boxVersionId: payload.boxVersionId,
            creatorId: payload.creatorId,
            openingId: event.openingPublicId,
            rewardVersionId: payload.rewardVersionId,
          },
          eventId: event.id,
          occurredAt: event.occurredAt,
          type: event.eventType,
          version: 1,
        },
        target: { kind: 'user', userId: payload.userId },
      });
    } catch {
      throw new InvalidOutboxEventError('INVALID_EVENT');
    }
  }

  if (event.eventType === 'drop.created.v1') {
    if (event.audience !== 'public') throw new InvalidOutboxEventError('INVALID_EVENT');
    const payload = record(event.payload);
    exactKeys(payload, ['boxId', 'creatorId', 'openingId', 'reward']);
    if (payload.openingId !== event.openingPublicId) {
      throw new InvalidOutboxEventError('INVALID_EVENT');
    }
    const reward = record(payload.reward);
    exactKeys(reward, ['imageUrl', 'name', 'rewardId']);
    try {
      return parseRealtimePublishCommand({
        event: {
          data: {
            boxId: payload.boxId,
            creatorId: payload.creatorId,
            openingId: payload.openingId,
            reward: {
              imageUrl: reward.imageUrl,
              name: reward.name,
              rewardId: reward.rewardId,
            },
          },
          eventId: event.id,
          occurredAt: event.occurredAt,
          type: event.eventType,
          version: 1,
        },
        target: { creatorId: payload.creatorId, kind: 'drop' },
      });
    } catch {
      throw new InvalidOutboxEventError('INVALID_EVENT');
    }
  }

  throw new InvalidOutboxEventError('UNSUPPORTED_EVENT');
};
