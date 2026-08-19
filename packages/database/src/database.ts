import { Pool, type QueryResult, type QueryResultRow } from 'pg';

import { withTransaction } from './transaction.js';
import type { Database, TransactionCallback, TransactionOptions } from './types.js';

export interface DatabasePoolOptions {
  readonly applicationName: string;
  readonly connectionString: string;
  readonly connectionTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly maxConnections: number;
  readonly onUnexpectedPoolError: (error: Error) => void;
}

export const createDatabasePool = (options: DatabasePoolOptions): Database => {
  const pool = new Pool({
    application_name: options.applicationName,
    connectionString: options.connectionString,
    connectionTimeoutMillis: options.connectionTimeoutMs,
    idleTimeoutMillis: options.idleTimeoutMs,
    max: options.maxConnections,
  });

  pool.on('error', options.onUnexpectedPoolError);

  return {
    close: async (): Promise<void> => pool.end(),
    query: async <Row extends QueryResultRow = QueryResultRow>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<QueryResult<Row>> => pool.query<Row>(text, [...values]),
    transaction: async <Result>(
      callback: TransactionCallback<Result>,
      transactionOptions?: TransactionOptions,
    ): Promise<Result> => withTransaction(pool, callback, transactionOptions),
  };
};
