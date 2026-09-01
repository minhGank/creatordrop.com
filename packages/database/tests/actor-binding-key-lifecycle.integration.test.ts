import { createHash, createHmac, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseEnvironment, parseMigrationEnvironment } from '@creatordrop/config';

import { createDatabasePool, type Database, type QueryExecutor } from '../src/index.js';

const localApplicationUrl =
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres?options=-c%20role%3Dcreatordrop_app';
const localMigrationUrl = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const applicationEnvironment = parseDatabaseEnvironment({
  DATABASE_APPLICATION_NAME: 'creatordrop-actor-binding-key-lifecycle-test',
  DATABASE_CONNECTION_TIMEOUT_MS: '5000',
  DATABASE_IDLE_TIMEOUT_MS: '1000',
  DATABASE_POOL_MAX: '2',
  DATABASE_URL: process.env.DATABASE_URL ?? localApplicationUrl,
});
const migrationEnvironment = parseMigrationEnvironment({
  DATABASE_MIGRATION_URL: process.env.DATABASE_MIGRATION_URL ?? localMigrationUrl,
});

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

const createDeferred = <Value>(): Deferred<Value> => {
  let resolvePromise: (value: Value) => void = () => {
    throw new Error('Deferred promise was resolved before initialization.');
  };
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
};

const backendPid = async (executor: QueryExecutor): Promise<number> => {
  const result = await executor.query<{ readonly pid: number }>(
    `select pg_catalog.pg_backend_pid() as pid`,
  );
  const pid = result.rows[0]?.pid;
  if (pid === undefined) throw new Error('PostgreSQL did not return a backend PID.');
  return pid;
};

const observeBlocked = async (
  inspector: QueryExecutor,
  waiterPid: number,
  blockerPid: number,
  settlement: Promise<unknown>,
): Promise<void> => {
  let settled: { readonly observed: true } | undefined;
  void settlement.finally(() => {
    settled = { observed: true };
  });
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const result = await inspector.query<{ readonly blocked: boolean }>(
      `select $2::integer = any(pg_catalog.pg_blocking_pids($1::integer)) as blocked`,
      [waiterPid, blockerPid],
    );
    if (result.rows[0]?.blocked === true) return;
    if (settled !== undefined) throw new Error('The colliding provision settled without waiting.');
  }
  throw new Error('The colliding provision did not enter PostgreSQL lock wait state.');
};

interface BindingInput {
  readonly actionKey: string | null;
  readonly actorUserId: string;
  readonly commandFingerprint: Uint8Array | null;
  readonly commandName: string;
  readonly creatorId: string | null;
  readonly expectedRevision: number | null;
  readonly nonce: string;
  readonly operation: string;
  readonly quantity: bigint | null;
  readonly resourceId: string;
}

const bindingInput = (): BindingInput => ({
  actionKey: null,
  actorUserId: randomUUID(),
  commandFingerprint: null,
  commandName: 'self_service',
  creatorId: null,
  expectedRevision: null,
  nonce: randomUUID(),
  operation: 'fulfillment.read_user',
  quantity: null,
  resourceId: randomUUID(),
});

const signBinding = (
  keyByte: number,
  version: string,
  input: BindingInput,
  clock = Date.now(),
): {
  readonly expiresAtMs: string;
  readonly keyVersion: string;
  readonly signature: Uint8Array;
} => {
  const expiresAtMs = (clock + 30_000).toString();
  const message = [
    'creatordrop:fulfillment-actor-binding:v1',
    version,
    input.actorUserId.toLowerCase(),
    input.operation,
    input.creatorId?.toLowerCase() ?? '-',
    input.resourceId.toLowerCase(),
    input.nonce.toLowerCase(),
    input.expectedRevision?.toString() ?? '-',
    input.actionKey ?? '-',
    input.commandName,
    input.commandFingerprint === null ? '-' : Buffer.from(input.commandFingerprint).toString('hex'),
    input.quantity?.toString() ?? '-',
    expiresAtMs,
  ].join('|');
  return {
    expiresAtMs,
    keyVersion: version,
    signature: Uint8Array.from(
      createHmac('sha256', Buffer.alloc(32, keyByte)).update(message, 'utf8').digest(),
    ),
  };
};

class RollbackProbe extends Error {}

describe('Phase 12 actor-binding key lifecycle', { concurrent: false }, () => {
  let applicationDatabase: Database;
  let firstProvisioningDatabase: Database;
  let migrationDatabase: Database;
  let secondProvisioningDatabase: Database;

  beforeAll(() => {
    const migrationPool = (applicationName: string): Database =>
      createDatabasePool({
        ...applicationEnvironment,
        applicationName,
        connectionString: migrationEnvironment.connectionString,
        maxConnections: 1,
        onUnexpectedPoolError: (error) => {
          throw error;
        },
      });
    applicationDatabase = createDatabasePool({
      ...applicationEnvironment,
      onUnexpectedPoolError: (error) => {
        throw error;
      },
    });
    migrationDatabase = migrationPool('creatordrop-actor-binding-key-migration-test');
    firstProvisioningDatabase = migrationPool('creatordrop-actor-binding-key-provision-a');
    secondProvisioningDatabase = migrationPool('creatordrop-actor-binding-key-provision-b');
  });

  afterAll(async () => {
    await Promise.all([
      applicationDatabase.close(),
      firstProvisioningDatabase.close(),
      migrationDatabase.close(),
      secondProvisioningDatabase.close(),
    ]);
  });

  it.each([
    ['RNG', 0x00],
    ['address', 0x11],
    ['digital delivery', 0x22],
  ] as const)('rejects actor-binding material reused from the %s domain', async (_, byte) => {
    await expect(
      migrationDatabase.query(
        `select * from app_private.rotate_fulfillment_actor_binding_key(
           $1, $2, 'cross_domain_collision_test'
         )`,
        [`actor-collision-${String(byte)}`, Buffer.alloc(32, byte)],
      ),
    ).rejects.toMatchObject({ constraint: 'encryption_key_domain_material_reuse' });
    expect(
      (
        await applicationDatabase.query<{ readonly version: string }>(
          `select version from app.get_active_fulfillment_actor_binding_key()`,
        )
      ).rows,
    ).toEqual([{ version: 'local-fulfillment-actor-v1' }]);
  });

  it('serializes concurrent actor/RNG material provisioning through one identity registry', async () => {
    const actorVersion = `concurrent-actor-${randomUUID().replaceAll('-', '')}`;
    const rngVersion = `concurrent-rng-${randomUUID().replaceAll('-', '')}`;
    const rawKey = createHash('sha256').update(actorVersion, 'utf8').digest();
    const identity = createHash('sha256').update(rawKey).digest();
    const actorInserted = createDeferred<number>();
    const allowActorCommit = createDeferred<true>();

    const actorOperation = firstProvisioningDatabase.transaction(async (transaction) => {
      const pid = await backendPid(transaction);
      await transaction.query(
        `insert into app_private.fulfillment_actor_binding_keys (
           version, key_material, status, activated_at, retired_at
         ) values ($1, $2, 'retired', statement_timestamp(), statement_timestamp())`,
        [actorVersion, rawKey],
      );
      actorInserted.resolve(pid);
      await allowActorCommit.promise;
    });
    const blockerPid = await actorInserted.promise;
    const rngStarted = createDeferred<number>();
    const rngOperation = secondProvisioningDatabase.transaction(async (transaction) => {
      rngStarted.resolve(await backendPid(transaction));
      await transaction.query(
        `insert into app.rng_encryption_key_versions (version, key_identity)
         values ($1, $2)`,
        [rngVersion, identity],
      );
    });
    const rngSettlement = rngOperation.then(
      () => ({ status: 'fulfilled' as const }),
      (reason: unknown) => ({ reason, status: 'rejected' as const }),
    );

    try {
      await observeBlocked(
        applicationDatabase,
        await rngStarted.promise,
        blockerPid,
        rngSettlement,
      );
    } finally {
      allowActorCommit.resolve(true);
    }
    await expect(actorOperation).resolves.toBeUndefined();
    const result = await rngSettlement;
    expect(result).toMatchObject({
      reason: { constraint: 'encryption_key_domain_material_reuse' },
      status: 'rejected',
    });
    expect(
      (
        await migrationDatabase.query<{ readonly domain: string }>(
          `select encryption_domain as domain
             from app_private.encryption_key_domain_identities
            where key_identity = $1`,
          [identity],
        )
      ).rows,
    ).toEqual([{ domain: 'actor_binding' }]);
    rawKey.fill(0);
    identity.fill(0);
  });

  it('retires the old verifier immediately and audits an active replacement', async () => {
    const newVersion = `rotated-actor-${randomUUID().replaceAll('-', '')}`;
    const newKeyHex = '77'.repeat(32);
    const input = bindingInput();
    const oldBinding = signBinding(0x33, 'local-fulfillment-actor-v1', input);
    const newBinding = signBinding(0x77, newVersion, input);

    await expect(
      migrationDatabase.transaction(async (transaction) => {
        await transaction.query(
          `select * from app_private.rotate_fulfillment_actor_binding_key(
             $1, decode($2, 'hex'), 'scheduled_rotation'
           )`,
          [newVersion, newKeyHex],
        );
        await transaction.query(`set local role creatordrop_app`);
        await transaction.query(
          `select * from app.read_fulfillment_delivery_data_bound(
             $1,$2,null,$3,'self_service',$4,$5,$6
           )`,
          [
            input.resourceId,
            input.actorUserId,
            input.nonce,
            oldBinding.keyVersion,
            oldBinding.expiresAtMs,
            oldBinding.signature,
          ],
        );
      }),
    ).rejects.toMatchObject({ constraint: 'fulfillment_actor_binding_invalid' });

    await expect(
      migrationDatabase.transaction(async (transaction) => {
        const rotation = await transaction.query<{
          readonly activeKeyVersion: string;
          readonly previousKeyVersion: string;
        }>(
          `select previous_key_version as "previousKeyVersion",
                  active_key_version as "activeKeyVersion"
             from app_private.rotate_fulfillment_actor_binding_key(
               $1, decode($2, 'hex'), 'scheduled_rotation'
             )`,
          [newVersion, newKeyHex],
        );
        expect(rotation.rows).toEqual([
          {
            activeKeyVersion: newVersion,
            previousKeyVersion: 'local-fulfillment-actor-v1',
          },
        ]);
        expect(
          (
            await transaction.query<{ readonly count: string }>(
              `select count(*)::text as count
                 from app_private.fulfillment_actor_binding_key_rotations
                where new_version = $1 and reason = 'scheduled_rotation'`,
              [newVersion],
            )
          ).rows,
        ).toEqual([{ count: '1' }]);
        await transaction.query(`set local role creatordrop_app`);
        expect(
          (
            await transaction.query(
              `select * from app.read_fulfillment_delivery_data_bound(
                 $1,$2,null,$3,'self_service',$4,$5,$6
               )`,
              [
                input.resourceId,
                input.actorUserId,
                input.nonce,
                newBinding.keyVersion,
                newBinding.expiresAtMs,
                newBinding.signature,
              ],
            )
          ).rows,
        ).toEqual([]);
        throw new RollbackProbe('Rollback the successful rotation probe.');
      }),
    ).rejects.toBeInstanceOf(RollbackProbe);
  });

  it('keeps forged, expired, and cross-resource capability protections intact', async () => {
    const input = bindingInput();
    const binding = signBinding(0x33, 'local-fulfillment-actor-v1', input);
    const invoke = (resourceId: string, expiresAtMs: string, signature: Uint8Array) =>
      applicationDatabase.query(
        `select * from app.read_fulfillment_delivery_data_bound(
           $1,$2,null,$3,'self_service',$4,$5,$6
         )`,
        [resourceId, input.actorUserId, input.nonce, binding.keyVersion, expiresAtMs, signature],
      );

    await expect(invoke(input.resourceId, binding.expiresAtMs, binding.signature)).resolves.toEqual(
      expect.objectContaining({ rows: [] }),
    );
    await expect(
      invoke(randomUUID(), binding.expiresAtMs, binding.signature),
    ).rejects.toMatchObject({ constraint: 'fulfillment_actor_binding_invalid' });
    await expect(
      invoke(input.resourceId, binding.expiresAtMs, Buffer.alloc(32, 0xaa)),
    ).rejects.toMatchObject({ constraint: 'fulfillment_actor_binding_invalid' });

    const expired = signBinding(0x33, 'local-fulfillment-actor-v1', input, Date.now() - 120_000);
    await expect(
      invoke(input.resourceId, expired.expiresAtMs, expired.signature),
    ).rejects.toMatchObject({ constraint: 'fulfillment_actor_binding_invalid' });
  });
});
