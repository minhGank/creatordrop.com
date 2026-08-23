import type { QueryResult, QueryResultRow } from 'pg';

export interface QueryExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

declare const transactionExecutorBrand: unique symbol;

export interface TransactionExecutor extends QueryExecutor {
  readonly [transactionExecutorBrand]: true;
}

export type TransactionIsolationLevel = 'read-committed' | 'repeatable-read' | 'serializable';

export interface TransactionOptions {
  readonly isolationLevel?: TransactionIsolationLevel;
  readonly readOnly?: boolean;
}

export type TransactionCallback<Result> = (transaction: TransactionExecutor) => Promise<Result>;

export interface Database extends QueryExecutor {
  close(): Promise<void>;
  transaction<Result>(
    callback: TransactionCallback<Result>,
    options?: TransactionOptions,
  ): Promise<Result>;
}
