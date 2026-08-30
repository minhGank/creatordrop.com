import type { Logger } from '@creatordrop/observability';

import type { RealtimePublisher } from '../adapters/realtime.publisher.js';
import { buildRealtimePublishCommand, InvalidOutboxEventError } from './outbox.js';
import { retryDelayMs } from './outbox.policy.js';
import type { OutboxRepository } from './outbox.repository.js';

export interface OutboxProcessorOptions {
  readonly batchSize: number;
  readonly leaseMs: number;
  readonly logger: Logger;
  readonly maxAttempts: number;
  readonly now?: () => Date;
  readonly publisher: RealtimePublisher;
  readonly repository: OutboxRepository;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly workerId: string;
}

export interface OutboxBatchResult {
  readonly claimed: number;
  readonly dead: number;
  readonly delivered: number;
  readonly retried: number;
}

const failureCode = (error: unknown): string =>
  error instanceof InvalidOutboxEventError ? error.failureCode : 'REALTIME_UNAVAILABLE';

export const createOutboxProcessor = ({
  batchSize,
  leaseMs,
  logger,
  maxAttempts,
  now = () => new Date(),
  publisher,
  repository,
  retryBaseMs,
  retryMaxMs,
  workerId,
}: OutboxProcessorOptions): { processBatch(): Promise<OutboxBatchResult> } => ({
  processBatch: async () => {
    const events = await repository.claim({ batchSize, leaseMs, maxAttempts, workerId });
    if (events.length > 0) logger.info('outbox.batch.claimed', { count: events.length });
    const results = await Promise.all(
      events.map(async (event): Promise<'dead' | 'delivered' | 'retried'> => {
        const startedAt = now();
        try {
          await publisher.publish(buildRealtimePublishCommand(event));
          await repository.complete(event.id, event.claimToken);
          logger.info('outbox.event.delivered', {
            attemptCount: event.attemptCount,
            eventId: event.id,
            eventType: event.eventType,
            processingDurationMs: Math.max(0, now().getTime() - startedAt.getTime()),
          });
          return 'delivered';
        } catch (error) {
          const code = failureCode(error);
          const terminal =
            error instanceof InvalidOutboxEventError || event.attemptCount >= maxAttempts;
          const retryAt = new Date(
            now().getTime() + retryDelayMs(event.attemptCount, retryBaseMs, retryMaxMs),
          );
          await repository.fail({
            claimToken: event.claimToken,
            eventId: event.id,
            failureCode: code,
            retryAt,
            terminal,
          });
          const attributes = {
            attemptCount: event.attemptCount,
            errorCode: code,
            eventId: event.id,
            eventType: event.eventType,
          };
          if (terminal) logger.error('outbox.event.dead', attributes);
          else logger.info('outbox.event.retry_scheduled', attributes);
          return terminal ? 'dead' : 'retried';
        }
      }),
    );
    const lag = await repository.readLag();
    logger.info('outbox.lag.observed', {
      deadCount: lag.deadCount.toString(),
      oldestReadyAgeMs: lag.oldestReadyAgeMs.toString(),
      pendingCount: lag.pendingCount.toString(),
      processingCount: lag.processingCount.toString(),
    });
    return {
      claimed: events.length,
      dead: results.filter((result) => result === 'dead').length,
      delivered: results.filter((result) => result === 'delivered').length,
      retried: results.filter((result) => result === 'retried').length,
    };
  },
});
