import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

import type {
  QueryExecutor,
  TransactionCallback,
  TransactionIsolationLevel,
  TransactionOptions,
} from './types.js';

const isolationStatements: Readonly<Record<TransactionIsolationLevel, string>> = {
  'read-committed': 'READ COMMITTED',
  'repeatable-read': 'REPEATABLE READ',
  serializable: 'SERIALIZABLE',
};

const createExecutor = (client: PoolClient): QueryExecutor => ({
  query: async <Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> => client.query<Row>(text, [...values]),
});

const createBeginStatement = ({
  isolationLevel = 'read-committed',
  readOnly = false,
}: TransactionOptions): string =>
  `BEGIN ISOLATION LEVEL ${isolationStatements[isolationLevel]} ${readOnly ? 'READ ONLY' : 'READ WRITE'}`;

export const withTransaction = async <Result>(
  pool: Pool,
  callback: TransactionCallback<Result>,
  options: TransactionOptions = {},
): Promise<Result> => {
  const client = await pool.connect();

  try {
    await client.query(createBeginStatement(options));

    try {
      const result = await callback(createExecutor(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Transaction and rollback both failed.', {
          cause: rollbackError,
        });
      }

      throw error;
    }
  } finally {
    client.release();
  }
};
