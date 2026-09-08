import { createHmac } from 'node:crypto';
import { entryId, entryText } from './entry.schema.js';

export interface EntryActorBinding {
  readonly actorId: string;
  readonly operation: string;
  readonly payload: string;
  readonly keyVersion: string;
  readonly expiresMs: string;
  readonly signature: Uint8Array;
}
export interface EntryActorSigner {
  bind(
    actorId: string,
    operation: string,
    payload: Readonly<Record<string, unknown>>,
  ): EntryActorBinding;
}

/** Reuses the actor-signing key lifecycle, with a distinct message domain from fulfillment. */
export const createEntryActorSigner = (options: {
  readonly keyHex: string;
  readonly keyVersion: string;
  readonly clock?: () => Date;
}): EntryActorSigner => {
  if (
    !/^[0-9a-f]{64}$/u.test(options.keyHex) ||
    !/^[A-Za-z0-9._-]{1,64}$/u.test(options.keyVersion)
  ) {
    throw new Error('Invalid entry actor-signing configuration.');
  }
  const key = Buffer.from(options.keyHex, 'hex');
  const clock = options.clock ?? (() => new Date());
  return {
    bind: (actor, operation, input) => {
      const actorId = entryId(actor);
      entryText(operation, 64);
      const payload = JSON.stringify(input);
      const expiresMs = (BigInt(clock().getTime()) + 30_000n).toString();
      const message = `creatordrop:entry-command:v1|${options.keyVersion}|${actorId}|${operation}|${payload}|${expiresMs}`;
      return {
        actorId,
        operation,
        payload,
        expiresMs,
        keyVersion: options.keyVersion,
        signature: Uint8Array.from(createHmac('sha256', key).update(message, 'utf8').digest()),
      };
    },
  };
};
