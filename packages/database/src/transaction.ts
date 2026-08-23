import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

import type {
  QueryExecutor,
  TransactionCallback,
  TransactionExecutor,
  TransactionIsolationLevel,
  TransactionOptions,
} from './types.js';

const isolationStatements: Readonly<Record<TransactionIsolationLevel, string>> = {
  'read-committed': 'READ COMMITTED',
  'repeatable-read': 'REPEATABLE READ',
  serializable: 'SERIALIZABLE',
};

interface TransactionExecutorState {
  active: boolean;
  outstandingQueries: number;
}

const transactionExecutorStates = new WeakMap<object, TransactionExecutorState>();

const transactionControlCommands = new Set([
  'ABORT',
  'BEGIN',
  'COMMIT',
  'END',
  'RELEASE',
  'ROLLBACK',
  'SAVEPOINT',
]);

type SqlTokenKind = 'parameter' | 'quoted-identifier' | 'string' | 'symbol' | 'word';

interface SqlToken {
  readonly kind: SqlTokenKind;
  readonly value: string;
}

interface QuotedToken {
  readonly nextIndex: number;
  readonly value: string;
}

const protectedTransactionSettings = new Set([
  'default_transaction_deferrable',
  'default_transaction_isolation',
  'default_transaction_read_only',
  'standard_conforming_strings',
  'transaction_deferrable',
  'transaction_isolation',
  'transaction_read_only',
]);

const isIdentifierStart = (character: string): boolean => /[A-Z_a-z\u0080-\uFFFF]/u.test(character);

const isIdentifierContinuation = (character: string): boolean =>
  /[$0-9A-Z_a-z\u0080-\uFFFF]/u.test(character);

const skipLineComment = (text: string, initialIndex: number): number => {
  let index = initialIndex + 2;
  while (index < text.length && text[index] !== '\n' && text[index] !== '\r') index += 1;
  if (text[index] === '\r' && text[index + 1] === '\n') return index + 2;
  return index < text.length ? index + 1 : index;
};

const skipBlockComment = (text: string, initialIndex: number): number => {
  let depth = 1;
  let index = initialIndex + 2;
  while (index < text.length && depth > 0) {
    if (text.startsWith('/*', index)) {
      depth += 1;
      index += 2;
    } else if (text.startsWith('*/', index)) {
      depth -= 1;
      index += 2;
    } else {
      index += 1;
    }
  }
  return index;
};

const readQuotedToken = (
  text: string,
  initialIndex: number,
  quote: "'" | '"',
  backslashEscapes: boolean,
): QuotedToken => {
  let index = initialIndex + 1;
  let value = '';

  while (index < text.length) {
    const character = text[index];
    if (character === quote) {
      if (text[index + 1] === quote) {
        value += quote;
        index += 2;
        continue;
      }
      return { nextIndex: index + 1, value };
    }
    if (backslashEscapes && character === '\\' && index + 1 < text.length) {
      const escapedCharacter = text[index + 1];
      if (escapedCharacter !== undefined) value += escapedCharacter;
      index += 2;
      continue;
    }
    if (character !== undefined) value += character;
    index += 1;
  }

  return { nextIndex: index, value };
};

const readDollarQuotedToken = (text: string, initialIndex: number): QuotedToken | undefined => {
  const delimiterMatch = /^\$(?:[A-Z_a-z\u0080-\uFFFF][0-9A-Z_a-z\u0080-\uFFFF]*)?\$/u.exec(
    text.slice(initialIndex),
  );
  if (delimiterMatch === null) return undefined;

  const delimiter = delimiterMatch[0];
  const valueStart = initialIndex + delimiter.length;
  const valueEnd = text.indexOf(delimiter, valueStart);
  if (valueEnd === -1) return { nextIndex: text.length, value: text.slice(valueStart) };
  return {
    nextIndex: valueEnd + delimiter.length,
    value: text.slice(valueStart, valueEnd),
  };
};

const readIdentifier = (text: string, initialIndex: number): QuotedToken => {
  let index = initialIndex + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === undefined || !isIdentifierContinuation(character)) break;
    index += 1;
  }
  return { nextIndex: index, value: text.slice(initialIndex, index) };
};

const scanSingleStatement = (text: string): readonly SqlToken[] => {
  const tokens: SqlToken[] = [];
  let index = 0;
  let statementEnd: number | undefined;

  const addToken = (token: SqlToken): void => {
    if (statementEnd !== undefined) {
      throw new Error('Transaction executors do not allow multi-statement SQL.');
    }
    tokens.push(token);
  };

  while (index < text.length) {
    const character = text[index];
    if (character !== undefined && /\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (text.startsWith('--', index)) {
      index = skipLineComment(text, index);
      continue;
    }
    if (text.startsWith('/*', index)) {
      index = skipBlockComment(text, index);
      continue;
    }
    if (character === ';') {
      if (tokens.length === 0 || statementEnd !== undefined) {
        throw new Error('Transaction executors do not allow multi-statement SQL.');
      }
      statementEnd = index;
      index += 1;
      continue;
    }
    if ((character === 'E' || character === 'e') && text[index + 1] === "'") {
      const quoted = readQuotedToken(text, index + 1, "'", true);
      addToken({ kind: 'string', value: quoted.value });
      index = quoted.nextIndex;
      continue;
    }
    if (character === "'") {
      const quoted = readQuotedToken(text, index, "'", false);
      addToken({ kind: 'string', value: quoted.value });
      index = quoted.nextIndex;
      continue;
    }
    if (character === '"') {
      const quoted = readQuotedToken(text, index, '"', false);
      addToken({ kind: 'quoted-identifier', value: quoted.value });
      index = quoted.nextIndex;
      continue;
    }
    if (character === '$') {
      const dollarQuoted = readDollarQuotedToken(text, index);
      if (dollarQuoted !== undefined) {
        addToken({ kind: 'string', value: dollarQuoted.value });
        index = dollarQuoted.nextIndex;
        continue;
      }
      const parameterMatch = /^\$([1-9][0-9]*)/u.exec(text.slice(index));
      const parameterNumber = parameterMatch?.[1];
      const parameterText = parameterMatch?.[0];
      if (parameterNumber !== undefined && parameterText !== undefined) {
        addToken({ kind: 'parameter', value: parameterNumber });
        index += parameterText.length;
        continue;
      }
    }
    if (character !== undefined && isIdentifierStart(character)) {
      const identifier = readIdentifier(text, index);
      addToken({ kind: 'word', value: identifier.value });
      index = identifier.nextIndex;
      continue;
    }
    if (character !== undefined) addToken({ kind: 'symbol', value: character });
    index += 1;
  }

  return tokens;
};

const isKeyword = (token: SqlToken | undefined, keyword: string): boolean =>
  token?.kind === 'word' && token.value.toUpperCase() === keyword;

const identifierValue = (token: SqlToken | undefined): string | undefined =>
  token?.kind === 'word' || token?.kind === 'quoted-identifier'
    ? token.value.toLowerCase()
    : undefined;

const protectedSettingFromToken = (
  token: SqlToken | undefined,
  values: readonly unknown[],
): string | undefined => {
  if (token?.kind === 'string') return token.value.toLowerCase();
  if (token?.kind !== 'parameter') return undefined;
  const value = values[Number(token.value) - 1];
  return typeof value === 'string' ? value.toLowerCase() : undefined;
};

const assertSetConfigCallsAllowed = (
  tokens: readonly SqlToken[],
  values: readonly unknown[],
): void => {
  for (const [index, token] of tokens.entries()) {
    if (identifierValue(token) !== 'set_config' || tokens[index + 1]?.value !== '(') continue;

    let argumentIndex = index + 2;
    if (
      identifierValue(tokens[argumentIndex]) === 'setting_name' &&
      tokens[argumentIndex + 1]?.value === '=' &&
      tokens[argumentIndex + 2]?.value === '>'
    ) {
      argumentIndex += 3;
    }
    const setting = protectedSettingFromToken(tokens[argumentIndex], values);
    const hasSingleStaticSettingArgument = tokens[argumentIndex + 1]?.value === ',';
    if (
      setting === undefined ||
      !hasSingleStaticSettingArgument ||
      protectedTransactionSettings.has(setting)
    ) {
      throw new Error('Transaction control is owned by the transaction helper.');
    }
  }
};

const assertTransactionSqlAllowed = (text: string, values: readonly unknown[]): void => {
  const tokens = scanSingleStatement(text);
  const [first, second] = tokens;
  if (
    (first?.kind === 'word' && transactionControlCommands.has(first.value.toUpperCase())) ||
    (isKeyword(first, 'START') && isKeyword(second, 'TRANSACTION')) ||
    (isKeyword(first, 'PREPARE') && isKeyword(second, 'TRANSACTION'))
  ) {
    throw new Error('Transaction control is owned by the transaction helper.');
  }

  if (isKeyword(first, 'SET')) {
    const hasScope = isKeyword(second, 'LOCAL') || isKeyword(second, 'SESSION');
    const settingIndex = hasScope ? 2 : 1;
    if (
      isKeyword(tokens[settingIndex], 'TRANSACTION') ||
      (isKeyword(tokens[settingIndex], 'CHARACTERISTICS') &&
        isKeyword(tokens[settingIndex + 1], 'AS') &&
        isKeyword(tokens[settingIndex + 2], 'TRANSACTION')) ||
      protectedTransactionSettings.has(identifierValue(tokens[settingIndex]) ?? '')
    ) {
      throw new Error('Transaction control is owned by the transaction helper.');
    }
  }

  if (
    isKeyword(first, 'RESET') &&
    (isKeyword(second, 'ALL') || protectedTransactionSettings.has(identifierValue(second) ?? ''))
  ) {
    throw new Error('Transaction control is owned by the transaction helper.');
  }

  assertSetConfigCallsAllowed(tokens, values);
};

const activeState = (executor: object): TransactionExecutorState => {
  const state = transactionExecutorStates.get(executor);
  if (state?.active !== true) {
    throw new Error('An active transaction executor is required.');
  }
  return state;
};

const deactivateExecutor = (executor: object): number => {
  const state = transactionExecutorStates.get(executor);
  if (state === undefined) return 0;
  state.active = false;
  return state.outstandingQueries;
};

const createExecutor = (client: PoolClient): TransactionExecutor => {
  const executor = {
    query: async <Row extends QueryResultRow = QueryResultRow>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<QueryResult<Row>> => {
      const state = activeState(executor);
      assertTransactionSqlAllowed(text, values);
      state.outstandingQueries += 1;
      try {
        return await client.query<Row>(text, [...values]);
      } finally {
        state.outstandingQueries -= 1;
      }
    },
  };
  transactionExecutorStates.set(executor, { active: true, outstandingQueries: 0 });
  return executor as TransactionExecutor;
};

export function assertTransactionExecutor(
  executor: QueryExecutor,
): asserts executor is TransactionExecutor {
  activeState(executor);
}

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
    const transaction = createExecutor(client);

    try {
      await client.query('SET LOCAL standard_conforming_strings = on');
      const result = await callback(transaction);
      const outstandingQueries = deactivateExecutor(transaction);
      if (outstandingQueries !== 0) {
        throw new Error('Transaction callback completed with outstanding queries.');
      }
      const commitResult = await client.query('COMMIT');
      if (commitResult.command !== 'COMMIT') {
        throw new Error('PostgreSQL rolled back the transaction instead of committing.');
      }
      return result;
    } catch (error) {
      deactivateExecutor(transaction);
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
