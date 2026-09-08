import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { createDatabasePool } from '@creatordrop/database';
import type { Logger } from '@creatordrop/observability';

import { createCatalogService } from '../src/modules/catalog/catalog.service.js';
import {
  parseBoxDraftInput,
  parseRewardDraftInput,
} from '../src/modules/catalog/catalog.schema.js';
import type { BoxId, ProbabilityWeight } from '../src/modules/catalog/catalog.js';
import type { CreatorId, UserId } from '../src/modules/creators/creator.js';
import { createFairnessService } from '../src/modules/fairness/fairness.service.js';
import { createEnvironmentSeedEncryptionKeyProvider } from '../src/modules/fairness/fairness.key-provider.js';
import type { ClientSeed } from '../src/modules/fairness/fairness.js';
import { createOpeningService } from '../src/modules/openings/opening.service.js';

const localUrl = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const pool = (connectionString: string) =>
  createDatabasePool({
    applicationName: 'r3-linkage-integration',
    connectionString,
    connectionTimeoutMs: 5000,
    idleTimeoutMs: 1000,
    maxConnections: 2,
    onUnexpectedPoolError: (error) => {
      throw error;
    },
  });
const database = pool(
  process.env.DATABASE_URL ?? `${localUrl}?options=-c%20role%3Dcreatordrop_app`,
);
const admin = pool(process.env.DATABASE_MIGRATION_URL ?? localUrl);
const logger: Logger = { info: () => undefined, error: () => undefined };
const catalog = createCatalogService({ database, logger });
const fairness = createFairnessService({
  database,
  logger,
  keyProvider: createEnvironmentSeedEncryptionKeyProvider({
    historicalKeys: {},
    keyHex: '0'.repeat(64),
    version: 'local-dev-v1',
  }),
  policy: { maxAgeMs: 86_400_000, maxOpenings: 1000n },
});
const openings = createOpeningService({ database, fairnessService: fairness, logger });

const fixture = async () => {
  const userId = randomUUID() as UserId;
  const owner = randomUUID() as UserId;
  const creatorId = randomUUID() as CreatorId;
  for (const id of [userId, owner])
    await database.query(
      `insert into app.users(id,auth_provider,auth_subject,username)
     values($1,'synthetic-r3-linkage',$1::uuid::text,$2)`,
      [id, `r3_linkage_${id.replaceAll('-', '')}`],
    );
  await database.transaction(async (transaction) => {
    await transaction.query(
      `insert into app.creators(id,handle,custom_slug,display_name)
      values($1,$2,$3,'Synthetic R3 linkage creator')`,
      [creatorId, `linkage_${creatorId.slice(0, 8)}`, `linkage-${creatorId.slice(0, 8)}`],
    );
    await transaction.query(
      `insert into app.creator_memberships(creator_id,user_id,role)
      values($1,$2,'owner')`,
      [creatorId, owner],
    );
  });
  const createBox = async (xp: boolean) => {
    const scope = { creatorId, actorUserId: owner, requestId: randomUUID() };
    const reward = await catalog.createReward({
      ...scope,
      ...parseRewardDraftInput({
        name: 'Synthetic linkage reward',
        description: '',
        rewardType: xp ? 'xp' : 'digital',
        inventoryMode: 'unlimited',
        ...(xp ? { xpAmount: '250' } : {}),
      }),
    });
    if (reward.draft === null) throw new Error('Missing reward draft.');
    const box = await catalog.createBox({
      ...scope,
      ...parseBoxDraftInput({
        name: 'Synthetic linkage Drop',
        description: '',
        openingCompatibilityVersion: 'opening-v2',
        maxOpeningsPerUser: '10',
      }),
    });
    await catalog.replaceDraftConfiguration({
      ...scope,
      boxId: box.id,
      entries: [{ rewardVersionId: reward.draft.id, weight: 1n as ProbabilityWeight }],
      expectedRevision: 1,
      openingCompatibilityVersion: 'opening-v2',
    });
    return {
      ...(await catalog.publishBox({ ...scope, boxId: box.id, expectedRevision: 2 })),
      boxId: box.id,
    };
  };
  const first = await createBox(true);
  const second = await createBox(false);
  const grant = async (boxId: BoxId) => {
    const grantId = randomUUID();
    await admin.query(
      `select app_private.grant_opening_entitlement(
      $1,$2,$3,$4,1,'r3_linkage_integration',$5,null,'Synthetic R3 linkage fixture')`,
      [grantId, userId, creatorId, boxId, randomUUID()],
    );
    return grantId;
  };
  await grant(first.boxId);
  const initial = await fairness.initialize({ userId, requestId: randomUUID() });
  const clientSeed = 'ab'.repeat(32) as ClientSeed;
  await fairness.updateClientSeed({
    userId,
    requestId: randomUUID(),
    clientSeed,
    expectedRevision: initial.fairness.revision,
    expectedSeedSetId: initial.fairness.activeSeedSet.id,
    expectedServerSeedCommitment: initial.fairness.activeSeedSet.commitment,
  });
  const open = (box: typeof first) =>
    openings.openBox({
      userId,
      boxId: box.boxId,
      clientSeed,
      expectedSeedSetId: initial.fairness.activeSeedSet.id,
      expectedServerSeedCommitment: initial.fairness.activeSeedSet.commitment,
      expectedBoxVersionId: box.version.id,
      expectedConfigurationHash: box.configurationHash,
      idempotencyKey: `r3_linkage_${randomUUID()}`,
      requestId: randomUUID(),
    });
  const firstReceipt = await open(first);
  const firstId = (
    await admin.query<{ id: string }>('select id from app.box_opens where public_id=$1', [
      firstReceipt.body.opening.id,
    ])
  ).rows[0]?.id;
  if (firstId === undefined) throw new Error('Missing opening.');
  return { userId, creatorId, first, second, firstId, open, grant };
};

describe('R3 consumption linkage', { concurrent: false }, () => {
  afterAll(async () => {
    await Promise.all([database.close(), admin.close()]);
  });

  it('rejects restricted-runtime consumption against any already committed opening', async () => {
    const state = await fixture();
    for (const box of [state.first, state.second]) {
      await expect(
        database.transaction(async (transaction) => {
          await transaction.query(
            `select * from app.consume_opening_v2_entitlement($1,$2,$3,$4,$5,$6,decode($7,'hex'))`,
            [
              randomUUID(),
              state.firstId,
              state.userId,
              state.creatorId,
              box.boxId,
              box.version.id,
              box.configurationHash,
            ],
          );
        }),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'opening_entitlement_requires_new_opening',
      });
    }
    expect(
      (await openings.getProgression(state.userId)).progression.universalEntriesAvailable,
    ).toBe('1');
    expect(
      (
        await admin.query<{ count: string }>(
          'select count(*)::text as count from app.box_opens where user_id=$1',
          [state.userId],
        )
      ).rows,
    ).toEqual([{ count: '1' }]);
    const receipt = await state.open(state.second);
    expect(receipt.body.opening).toMatchObject({
      entitlement: { source: 'universal', universalEntriesRemaining: '0' },
    });
  });

  it('independently rejects adding a second source in either insertion order', async () => {
    const state = await fixture();
    await expect(
      admin.transaction(async (transaction) => {
        await transaction.query(
          `insert into app_private.universal_entry_consumptions
        (opening_id,grant_id,user_id,creator_id,box_id,box_version_id,configuration_hash)
        select $1,g.id,g.user_id,$3,$4,$5,decode($6,'hex')
        from app_private.universal_entry_grants g where g.user_id=$2`,
          [
            state.firstId,
            state.userId,
            state.creatorId,
            state.first.boxId,
            state.first.version.id,
            state.first.configurationHash,
          ],
        );
        await transaction.query('set constraints all immediate');
      }),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'opening_entitlement_consumption_link_invalid',
    });
    const receipt = await state.open(state.second);
    const grantId = await state.grant(state.second.boxId);
    await expect(
      admin.transaction(async (transaction) => {
        await transaction.query(
          `insert into app.opening_entitlement_consumptions
        (id,opening_id,grant_id,user_id,creator_id,box_id)
        select $1,o.id,$2,o.user_id,o.creator_id,o.box_id from app.box_opens o where o.public_id=$3`,
          [randomUUID(), grantId, receipt.body.opening.id],
        );
        await transaction.query('set constraints all immediate');
      }),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'opening_entitlement_consumption_link_invalid',
    });
    expect(
      (await openings.getProgression(state.userId)).progression.universalEntriesAvailable,
    ).toBe('0');
  });

  it.each(['creator_id', 'box_id', 'box_version_id', 'configuration_hash'] as const)(
    'independently rejects Universal consumption with mismatched %s',
    async (column) => {
      const state = await fixture();
      await state.open(state.second);
      await expect(
        admin.transaction(async (transaction) => {
          // Replace only this test fixture's already-valid consumption inside a rollback transaction.
          // Replica mode constructs the counterexample; the inserted row runs production guards.
          await transaction.query(
            `create temporary table saved_consumption on commit drop as
          select * from app_private.universal_entry_consumptions where user_id=$1`,
            [state.userId],
          );
          await transaction.query('set local session_replication_role=replica');
          await transaction.query(
            'delete from app_private.universal_entry_consumptions where user_id=$1',
            [state.userId],
          );
          await transaction.query('set local session_replication_role=origin');
          const replacement =
            column === 'configuration_hash' ? "decode(repeat('ff',32),'hex')" : 'gen_random_uuid()';
          // Column comes exclusively from the fixed infrastructure allowlist above.
          await transaction.query(`update saved_consumption set ${column}=${replacement}`);
          await transaction.query(
            'insert into app_private.universal_entry_consumptions select * from saved_consumption',
          );
          await transaction.query('set constraints all immediate');
        }),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'opening_entitlement_consumption_link_invalid',
      });
      expect(
        (await openings.getProgression(state.userId)).progression.universalEntriesAvailable,
      ).toBe('0');
    },
  );
});
