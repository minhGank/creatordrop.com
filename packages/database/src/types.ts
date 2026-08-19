import type { QueryResult, QueryResultRow } from 'pg';

export interface QueryExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

export type TransactionIsolationLevel = 'read-committed' | 'repeatable-read' | 'serializable';

export interface TransactionOptions {
  readonly isolationLevel?: TransactionIsolationLevel;
  readonly readOnly?: boolean;
}

export type TransactionCallback<Result> = (transaction: QueryExecutor) => Promise<Result>;

export interface Database extends QueryExecutor {
  close(): Promise<void>;
  transaction<Result>(
    callback: TransactionCallback<Result>,
    options?: TransactionOptions,
  ): Promise<Result>;
}
