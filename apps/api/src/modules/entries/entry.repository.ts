import type { QueryExecutor } from '@creatordrop/database';
import type { EntryActorBinding } from './entry.actor-binding.js';
import { EntryError, type entryErrorStatuses } from './entry.errors.js';

const functions = {
  method: 'select app.entry_method_command($1,$2,$3,$4,$5,$6) as result',
  claim: 'select app.entry_claim_command($1,$2,$3,$4,$5,$6) as result',
  evidence: 'select app.entry_evidence_command($1,$2,$3,$4,$5,$6) as result',
} as const;
const databaseErrors: Readonly<Record<string, keyof typeof entryErrorStatuses>> = {
  P2001: 'ENTRY_NOT_FOUND',
  P2002: 'ENTRY_FORBIDDEN',
  P2003: 'ENTRY_CONFLICT',
  P2004: 'ENTRY_CLAIM_LIMIT_REACHED',
  P2005: 'ENTRY_INVALID_INPUT',
  P2006: 'ENTRY_REVISION_CONFLICT',
  P2007: 'ENTRY_UNAVAILABLE',
  '23505': 'ENTRY_CONFLICT',
};
export const executeEntryCommand = async (
  executor: QueryExecutor,
  family: keyof typeof functions,
  binding: EntryActorBinding,
): Promise<unknown> => {
  try {
    const response = await executor.query<{ readonly result: unknown }>(functions[family], [
      binding.actorId,
      binding.operation,
      binding.payload,
      binding.keyVersion,
      binding.expiresMs,
      Buffer.from(binding.signature),
    ]);
    return response.rows[0]?.result;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
    ) {
      const code = databaseErrors[error.code];
      if (code !== undefined) throw new EntryError(code);
    }
    throw error;
  }
};
export const readPublishedEntryPolicies = async (
  executor: QueryExecutor,
  boxId: string,
): Promise<unknown> => {
  const response = await executor.query<{ readonly result: unknown }>(
    'select app.entry_public_policies($1) as result',
    [boxId],
  );
  return response.rows[0]?.result;
};
