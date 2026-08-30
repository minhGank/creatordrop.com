import type { Database } from '@creatordrop/database';

import type { ClaimedOutboxEvent, OutboxLagSnapshot } from './outbox.js';

interface ClaimedOutboxRow {
  readonly aggregateId: string;
  readonly attemptCount: number;
  readonly audience: string;
  readonly claimToken: string;
  readonly eventType: string;
  readonly id: string;
  readonly occurredAt: Date;
  readonly openingPublicId: string;
  readonly payload: unknown;
}

interface OutboxLagRow {
  readonly deadCount: string;
  readonly oldestReadyAgeMs: string;
  readonly pendingCount: string;
  readonly processingCount: string;
}

export interface OutboxRepository {
  claim(input: {
    readonly batchSize: number;
    readonly leaseMs: number;
    readonly maxAttempts: number;
    readonly workerId: string;
  }): Promise<readonly ClaimedOutboxEvent[]>;
  complete(eventId: string, claimToken: string): Promise<void>;
  fail(input: {
    readonly claimToken: string;
    readonly eventId: string;
    readonly failureCode: string;
    readonly retryAt: Date;
    readonly terminal: boolean;
  }): Promise<void>;
  readLag(): Promise<OutboxLagSnapshot>;
}

export const createOutboxRepository = (database: Database): OutboxRepository => ({
  claim: async ({ batchSize, leaseMs, maxAttempts, workerId }) => {
    const result = await database.query<ClaimedOutboxRow>(
      `select
         id,
         aggregate_id as "aggregateId",
         event_type as "eventType",
         audience,
         payload,
         occurred_at as "occurredAt",
         attempt_count as "attemptCount",
         claim_token as "claimToken",
         opening_public_id as "openingPublicId"
       from app.claim_outbox_events($1, $2, $3, $4)`,
      [workerId, batchSize, leaseMs, maxAttempts],
    );
    return result.rows.map((row) => ({
      ...row,
      occurredAt: row.occurredAt.toISOString(),
    }));
  },
  complete: async (eventId, claimToken) => {
    await database.query('select app.complete_outbox_event($1, $2)', [eventId, claimToken]);
  },
  fail: async ({ claimToken, eventId, failureCode, retryAt, terminal }) => {
    await database.query('select app.fail_outbox_event($1, $2, $3, $4, $5)', [
      eventId,
      claimToken,
      failureCode,
      retryAt,
      terminal,
    ]);
  },
  readLag: async () => {
    const result = await database.query<OutboxLagRow>(
      `select
         pending_count::text as "pendingCount",
         processing_count::text as "processingCount",
         dead_count::text as "deadCount",
         oldest_ready_age_ms::text as "oldestReadyAgeMs"
       from app.read_outbox_lag()`,
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('The outbox lag query returned no row.');
    return {
      deadCount: BigInt(row.deadCount),
      oldestReadyAgeMs: BigInt(row.oldestReadyAgeMs),
      pendingCount: BigInt(row.pendingCount),
      processingCount: BigInt(row.processingCount),
    };
  },
});
