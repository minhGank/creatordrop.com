import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '@creatordrop/observability';

import type { RealtimePublisher } from '../src/adapters/realtime.publisher.js';
import { createOutboxProcessor } from '../src/outbox/outbox.processor.js';
import { retryDelayMs } from '../src/outbox/outbox.policy.js';
import type { OutboxRepository } from '../src/outbox/outbox.repository.js';
import type { ClaimedOutboxEvent } from '../src/outbox/outbox.js';

const claimedEvent = (attemptCount = 1): ClaimedOutboxEvent => ({
  aggregateId: '019d0000-0000-7000-8000-000000000001',
  attemptCount,
  audience: 'private',
  claimToken: '019d0000-0000-7000-8000-000000000002',
  eventType: 'opening.completed.v1',
  id: '019d0000-0000-7000-8000-000000000003',
  occurredAt: '2026-08-29T12:00:00.000Z',
  openingPublicId: '019d0000-0000-7000-8000-000000000004',
  payload: {
    boxId: '019d0000-0000-7000-8000-000000000005',
    boxVersionId: '019d0000-0000-7000-8000-000000000006',
    creatorId: '019d0000-0000-7000-8000-000000000007',
    openingId: '019d0000-0000-7000-8000-000000000001',
    rewardVersionId: '019d0000-0000-7000-8000-000000000008',
    userId: '019d0000-0000-7000-8000-000000000009',
  },
});

const logger: Logger = { error: vi.fn(), info: vi.fn() };

const repositoryWith = (event: ClaimedOutboxEvent) => {
  const claim = vi.fn<OutboxRepository['claim']>(() => Promise.resolve([event]));
  const complete = vi.fn<OutboxRepository['complete']>(() => Promise.resolve());
  const fail = vi.fn<OutboxRepository['fail']>(() => Promise.resolve());
  const readLag = vi.fn<OutboxRepository['readLag']>(() =>
    Promise.resolve({
      deadCount: 0n,
      oldestReadyAgeMs: 0n,
      pendingCount: 0n,
      processingCount: 0n,
    }),
  );
  return {
    complete,
    fail,
    repository: { claim, complete, fail, readLag } satisfies OutboxRepository,
  };
};

const processorWith = (repository: OutboxRepository, publisher: RealtimePublisher) =>
  createOutboxProcessor({
    batchSize: 10,
    leaseMs: 30_000,
    logger,
    maxAttempts: 3,
    now: () => new Date('2026-08-29T12:00:00.000Z'),
    publisher,
    repository,
    retryBaseMs: 1000,
    retryMaxMs: 10_000,
    workerId: 'worker:synthetic',
  });

describe('outbox processor', () => {
  it('publishes an allowlisted event and completes only after acknowledgement', async () => {
    const fixture = repositoryWith(claimedEvent());
    const publish = vi.fn<RealtimePublisher['publish']>(() => Promise.resolve());
    await expect(
      processorWith(fixture.repository, { close: () => undefined, publish }).processBatch(),
    ).resolves.toEqual({ claimed: 1, dead: 0, delivered: 1, retried: 0 });
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]?.[0]).toMatchObject({ event: { version: 1 } });
    expect(fixture.complete).toHaveBeenCalledOnce();
    expect(fixture.fail).not.toHaveBeenCalled();
  });

  it('schedules deterministic backoff and dead-letters the final failed attempt', async () => {
    const publisher: RealtimePublisher = {
      close: () => undefined,
      publish: () => Promise.reject(new Error('synthetic gateway outage')),
    };
    const retryFixture = repositoryWith(claimedEvent(2));
    await expect(
      processorWith(retryFixture.repository, publisher).processBatch(),
    ).resolves.toMatchObject({ retried: 1 });
    expect(retryFixture.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        failureCode: 'REALTIME_UNAVAILABLE',
        retryAt: new Date('2026-08-29T12:00:02.000Z'),
        terminal: false,
      }),
    );

    const terminalFixture = repositoryWith(claimedEvent(3));
    await expect(
      processorWith(terminalFixture.repository, publisher).processBatch(),
    ).resolves.toMatchObject({ dead: 1 });
    expect(terminalFixture.fail).toHaveBeenCalledWith(expect.objectContaining({ terminal: true }));
  });

  it('dead-letters malformed or unsupported committed events without publishing payload data', async () => {
    const fixture = repositoryWith({ ...claimedEvent(), eventType: 'unknown.v1' });
    const publish = vi.fn<RealtimePublisher['publish']>(() => Promise.resolve());
    await expect(
      processorWith(fixture.repository, { close: () => undefined, publish }).processBatch(),
    ).resolves.toMatchObject({ dead: 1 });
    expect(publish).not.toHaveBeenCalled();
    expect(fixture.fail).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: 'UNSUPPORTED_EVENT', terminal: true }),
    );
  });
});

describe('outbox retry policy', () => {
  it('uses bounded deterministic exponential delays', () => {
    expect([1, 2, 3, 10].map((attempt) => retryDelayMs(attempt, 1000, 5000))).toEqual([
      1000, 2000, 4000, 5000,
    ]);
  });
});
