import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabasePool, type Database } from '@creatordrop/database';
import type { EntryPolicyDefinition, EntryPolicySnapshot } from '@creatordrop/contracts';
import { createEntryService, type EntryService } from '../src/modules/entries/entry.service.js';
import { createEntryActorSigner } from '../src/modules/entries/entry.actor-binding.js';
import { createSupabaseEntryStorage } from '../src/modules/entries/entry.storage.js';
import {
  entryRecord,
  entryId,
  parseEntryMethod,
  parseEntryClaim,
  parseEntryState,
} from '../src/modules/entries/entry.schema.js';
import { createCreatorService } from '../src/modules/creators/creator.service.js';
import { createCatalogService } from '../src/modules/catalog/catalog.service.js';
import {
  parseBoxDraftInput,
  parseRewardDraftInput,
} from '../src/modules/catalog/catalog.schema.js';
import type { BoxId, BoxVersionId, ProbabilityWeight } from '../src/modules/catalog/catalog.js';
import type { CreatorId, UserId } from '../src/modules/creators/creator.js';
import { createUserBootstrapService } from '../src/modules/users/bootstrap-user.service.js';
import { createAuthenticationMiddleware } from '../src/modules/auth/authentication.middleware.js';
import { createJwtVerifier } from '../src/modules/auth/jwt-verifier.js';
import { createFairnessService } from '../src/modules/fairness/fairness.service.js';
import { createEnvironmentSeedEncryptionKeyProvider } from '../src/modules/fairness/fairness.key-provider.js';
import { createOpeningService } from '../src/modules/openings/opening.service.js';
import type { ClientSeed } from '../src/modules/fairness/fairness.js';
import { createNoopLogger, createTestApp } from './support/test-app.js';

const definition: EntryPolicyDefinition = {
  policyVersion: 'entry-policy-v1',
  platform: 'custom',
  action: 'manual_requirement',
  verificationStrategy: 'manual_evidence',
  title: 'Synthetic manual task',
  instructions: 'Submit synthetic evidence for human review.',
  targetReference: null,
  openingsGranted: '1',
  perUserClaimLimit: '1',
  evidenceRequirements: {
    platform_username: 'not_applicable',
    profile_url: 'not_applicable',
    order_reference: 'not_applicable',
    screenshot: 'not_applicable',
    note: 'required',
  },
};
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvN8AAAAASUVORK5CYII=',
  'base64',
);
const logger = createNoopLogger();
const signal = () => {
  let resolve: () => void = () => {
    throw new Error('Signal is not initialized.');
  };
  let reject: (error: unknown) => void = () => {
    throw new Error('Signal is not initialized.');
  };
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const pool = (admin = false, maxConnections = 8) =>
  createDatabasePool({
    applicationName: 'creatordrop-r2a-integration',
    connectionString: admin
      ? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
      : 'postgresql://postgres:postgres@127.0.0.1:54322/postgres?options=-c%20role%3Dcreatordrop_app',
    connectionTimeoutMs: 5000,
    idleTimeoutMs: 1000,
    maxConnections,
    onUnexpectedPoolError: (error) => {
      throw error;
    },
  });
interface Actor {
  readonly id: UserId;
  readonly token: string;
}
describe('R2A authoritative entry claims and private evidence', { concurrent: false }, () => {
  let database: Database;
  let admin: Database;
  let entries: EntryService;
  let owner: Actor;
  let fan: Actor;
  let other: Actor;
  let manager: Actor;
  let editor: Actor;
  let creatorId: CreatorId;
  let otherCreatorId: CreatorId;
  let boxId: BoxId;
  let boxVersionId: BoxVersionId;
  let originalHash: string;
  let api: ReturnType<typeof createTestApp>;
  const baseUrl = process.env.LOCAL_SUPABASE_API_URL ?? 'http://127.0.0.1:54321';
  const publicKey = process.env.LOCAL_SUPABASE_PUBLISHABLE_KEY ?? '';
  const signer = createEntryActorSigner({
    keyHex: '33'.repeat(32),
    keyVersion: 'local-fulfillment-actor-v1',
  });
  const newActor = async (): Promise<Actor> => {
    const response = await fetch(`${baseUrl}/auth/v1/signup`, {
      method: 'POST',
      headers: { apikey: publicKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `r2a-${randomUUID()}@example.test`,
        password: 'Synthetic-R2A-password-123!',
      }),
    });
    const value: unknown = await response.json();
    if (
      typeof value !== 'object' ||
      value === null ||
      !('access_token' in value) ||
      typeof value.access_token !== 'string' ||
      !('user' in value) ||
      typeof value.user !== 'object' ||
      value.user === null ||
      !('id' in value.user) ||
      typeof value.user.id !== 'string'
    )
      throw new Error('Synthetic R2A signup failed.');
    const user = await createUserBootstrapService({ database }).bootstrap({
      provider: 'supabase',
      subject: value.user.id,
    });
    return { id: user.id as UserId, token: value.access_token };
  };
  const publish = async (
    rules: EntryPolicyDefinition = definition,
  ): Promise<EntryPolicySnapshot> => {
    const scope = { actorId: owner.id, creatorId, boxId };
    const draft = await entries.createMethod({ ...scope, definition: rules });
    const result = await entries.publishMethod({
      ...scope,
      methodId: draft.id,
      expectedRevision: draft.revision,
      boxVersionId,
    });
    if (result.published === null) throw new Error('Entry policy was not published.');
    return result.published;
  };
  const submit = async (
    policy: EntryPolicySnapshot,
    actor = fan,
    evidence: unknown = { note: 'Synthetic submitted proof.' },
    service = entries,
  ) =>
    service.submitClaim({
      actorId: actor.id,
      boxId,
      policyId: policy.id,
      evidence,
      idempotencyKey: `claim_${randomUUID()}`,
    });
  const approve = (
    id: string,
    actor = owner,
    decision: 'approved' | 'rejected' = 'approved',
    service = entries,
  ) =>
    service.reviewClaim({
      actorId: actor.id,
      creatorId,
      claimId: id,
      decision,
      note: 'Synthetic reviewer decision.',
    });
  const grants = async (id: string) =>
    (
      await admin.query<{ readonly quantity: string; readonly count: string }>(
        `select count(*)::text as count, coalesce(sum(quantity_granted),0)::text as quantity from app.opening_entitlement_grants where source_type='entry_claim' and source_identity=$1`,
        [`entry_claim:${id}`],
      )
    ).rows;

  beforeAll(async () => {
    database = pool();
    admin = pool(true);
    entries = createEntryService({
      database,
      signer,
      storage: createSupabaseEntryStorage({
        url: `${baseUrl}/storage/v1`,
        publishableKey: publicKey,
      }),
    });
    owner = await newActor();
    fan = await newActor();
    other = await newActor();
    manager = await newActor();
    editor = await newActor();
    const creators = createCreatorService({ database, logger });
    const newCreator = async (actor: Actor) =>
      creators.createCreator({
        actorUserId: actor.id,
        customSlug: `r2a-${randomUUID()}`,
        handle: `r2a_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
        displayName: 'Synthetic R2A Creator',
        requestId: randomUUID(),
      });
    creatorId = (await newCreator(owner)).id;
    otherCreatorId = (await newCreator(other)).id;
    for (const [actor, role] of [
      [manager, 'manager'],
      [editor, 'editor'],
    ] as const)
      await creators.addMember({
        actorUserId: owner.id,
        creatorId,
        targetUserId: actor.id,
        role,
        requestId: randomUUID(),
      });
    const catalog = createCatalogService({ database, logger });
    const reward = await catalog.createReward({
      actorUserId: owner.id,
      creatorId,
      ...parseRewardDraftInput({
        name: 'Synthetic R2A reward',
        description: '',
        inventoryMode: 'unlimited',
        inventoryQuantity: null,
        inventoryStockoutPolicy: null,
        rewardType: 'digital',
      }),
      requestId: randomUUID(),
    });
    if (reward.draft === null) throw new Error('Missing reward draft.');
    const box = await catalog.createBox({
      actorUserId: owner.id,
      creatorId,
      ...parseBoxDraftInput({
        name: 'Synthetic R2A Drop',
        description: '',
        openingCompatibilityVersion: 'opening-v2',
        maxOpeningsPerUser: '10',
      }),
      requestId: randomUUID(),
    });
    boxId = box.id;
    await catalog.replaceDraftConfiguration({
      actorUserId: owner.id,
      creatorId,
      boxId,
      entries: [{ rewardVersionId: reward.draft.id, weight: 1n as ProbabilityWeight }],
      expectedRevision: 1,
      openingCompatibilityVersion: 'opening-v2',
      requestId: randomUUID(),
    });
    const publication = await catalog.publishBox({
      actorUserId: owner.id,
      creatorId,
      boxId,
      expectedRevision: 2,
      requestId: randomUUID(),
    });
    boxVersionId = publication.version.id;
    originalHash = publication.configurationHash;
    api = createTestApp({
      entryService: entries,
      authenticate: createAuthenticationMiddleware({
        bootstrapUsers: createUserBootstrapService({ database }),
        verifyAccessToken: createJwtVerifier({
          issuer: `${baseUrl}/auth/v1`,
          jwksUrl: `${baseUrl}/auth/v1/.well-known/jwks.json`,
          audience: 'authenticated',
          provider: 'supabase',
        }),
      }),
    });
  }, 60000);
  afterAll(async () => {
    await database.close();
    await admin.close();
  });

  const ownState = async (actor = fan, targetBox = boxId) => {
    const response = await request(api)
      .get(`/v1/boxes/${targetBox}/me/entry-state`)
      .set('Authorization', `Bearer ${actor.token}`);
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    return parseEntryState(response.body as unknown);
  };
  const methodState = async (policy: EntryPolicySnapshot, actor = fan) => {
    const state = (await ownState(actor)).methods.find(
      (m) => m.policy.methodId === policy.methodId,
    );
    if (state === undefined) throw new Error('Missing own method state.');
    return state;
  };

  it('discovers own pending, approved and rejected claims with authoritative slot counts', async () => {
    const policy = await publish({ ...definition, openingsGranted: '5' });
    expect(await methodState(policy)).toMatchObject({
      policy,
      claimLimit: '1',
      reservedSlots: '0',
      consumedSlots: '0',
      remainingSlots: '1',
      canSubmit: true,
      claimCount: '0',
      claims: [],
    });
    const rejected = await submit(policy);
    expect(await methodState(policy)).toMatchObject({
      reservedSlots: '1',
      consumedSlots: '0',
      remainingSlots: '0',
      canSubmit: false,
      claimCount: '1',
      claims: [{ id: rejected.id, status: 'pending', openingsGranted: '0' }],
    });
    await approve(rejected.id, owner, 'rejected');
    expect(await methodState(policy)).toMatchObject({
      reservedSlots: '0',
      consumedSlots: '0',
      remainingSlots: '1',
      canSubmit: true,
      claims: [{ id: rejected.id, status: 'rejected', openingsGranted: '0' }],
    });
    const approved = await submit(policy);
    await approve(approved.id);
    const state = await methodState(policy);
    expect(state).toMatchObject({
      reservedSlots: '0',
      consumedSlots: '1',
      remainingSlots: '0',
      canSubmit: false,
      claimCount: '2',
      claims: [
        { id: approved.id, policyId: policy.id, status: 'approved', openingsGranted: '5' },
        { id: rejected.id, status: 'rejected' },
      ],
    });
    expect(Object.keys(state.claims[0] ?? {}).sort()).toEqual([
      'createdAt',
      'id',
      'openingsGranted',
      'policyId',
      'reviewedAt',
      'status',
    ]);
    // Discovery never requires a locally saved claim ID; details remain in the existing own read.
    expect(await entries.getOwnClaim(fan.id, approved.id)).toMatchObject({
      id: state.claims[0]?.id,
    });
  });

  it('uses the current limit but all stable-method claims and frozen grant quantities across publications', async () => {
    const policy = await publish({ ...definition, perUserClaimLimit: '3', openingsGranted: '5' });
    const approved = await submit(policy);
    await approve(approved.id);
    const pending = await submit(policy);
    expect(await methodState(policy)).toMatchObject({
      claimLimit: '3',
      reservedSlots: '1',
      consumedSlots: '1',
      remainingSlots: '1',
      canSubmit: true,
    });
    const current = (await entries.listMethods({ actorId: owner.id, creatorId, boxId })).find(
      (m) => m.id === policy.methodId,
    );
    if (current === undefined) throw new Error('Missing method.');
    const draft = await entries.updateMethod({
      actorId: owner.id,
      creatorId,
      boxId,
      methodId: current.id,
      expectedRevision: current.revision,
      definition: { ...definition, perUserClaimLimit: '1', openingsGranted: '9' },
    });
    const published = await entries.publishMethod({
      actorId: owner.id,
      creatorId,
      boxId,
      methodId: current.id,
      expectedRevision: draft.revision,
      boxVersionId,
    });
    expect(await methodState(policy)).toMatchObject({
      policy: published.published,
      claimLimit: '1',
      reservedSlots: '1',
      consumedSlots: '1',
      remainingSlots: '0',
      canSubmit: false,
      claimCount: '2',
      claims: [
        { id: pending.id, policyId: policy.id, status: 'pending' },
        { id: approved.id, policyId: policy.id, openingsGranted: '5' },
      ],
    });
    if (published.published === null) throw new Error('Missing publication.');
    await expect(submit(published.published)).rejects.toMatchObject({
      code: 'ENTRY_CLAIM_LIMIT_REACHED',
    });
    await approve(pending.id, owner, 'rejected');
    expect(await methodState(policy)).toMatchObject({
      reservedSlots: '0',
      consumedSlots: '1',
      remainingSlots: '0',
    });
    const increased = await entries.updateMethod({
      actorId: owner.id,
      creatorId,
      boxId,
      methodId: current.id,
      expectedRevision: published.revision,
      definition: { ...definition, perUserClaimLimit: '4' },
    });
    await entries.publishMethod({
      actorId: owner.id,
      creatorId,
      boxId,
      methodId: current.id,
      expectedRevision: increased.revision,
      boxVersionId,
    });
    expect(await methodState(policy)).toMatchObject({
      claimLimit: '4',
      remainingSlots: '3',
      canSubmit: true,
    });
  });

  it('omits drafts and disabled methods without discarding their claims', async () => {
    const draft = await entries.createMethod({ actorId: owner.id, creatorId, boxId, definition });
    expect((await ownState()).methods.some((m) => m.policy.methodId === draft.id)).toBe(false);
    const policy = await publish();
    const claim = await submit(policy);
    const method = (await entries.listMethods({ actorId: owner.id, creatorId, boxId })).find(
      (m) => m.id === policy.methodId,
    );
    if (method === undefined) throw new Error('Missing method.');
    await entries.setMethodEnabled({
      actorId: owner.id,
      creatorId,
      boxId,
      methodId: method.id,
      expectedRevision: method.revision,
      enabled: false,
    });
    expect((await ownState()).methods.some((m) => m.policy.methodId === method.id)).toBe(false);
    expect((await entries.getOwnClaim(fan.id, claim.id)).status).toBe('pending');
  });

  it('bounds recent summaries without truncating counts or historical consumed slots', async () => {
    const policy = await publish({ ...definition, perUserClaimLimit: '105' });
    const oldest = await submit(policy);
    await approve(oldest.id);
    for (let index = 0; index < 100; index += 1) await submit(policy);
    const state = await methodState(policy);
    expect(state).toMatchObject({
      claimCount: '101',
      reservedSlots: '100',
      consumedSlots: '1',
      remainingSlots: '4',
      canSubmit: true,
    });
    expect(state.claims).toHaveLength(100);
    expect(state.claims.some((c) => c.id === oldest.id)).toBe(false);
    expect(state.claims.every((c) => c.status === 'pending')).toBe(true);
  });

  it('isolates users including another creator member and rejects identity/scope injection', async () => {
    const policy = await publish();
    const claim = await submit(policy);
    expect(await methodState(policy, other)).toMatchObject({
      claimCount: '0',
      claims: [],
      remainingSlots: '1',
    });
    await submit(policy, other);
    expect((await methodState(policy)).claims.map((c) => c.id)).toEqual([claim.id]);
    for (const suffix of [
      `?userId=${other.id}`,
      `?creatorId=${otherCreatorId}`,
      '?boxId=invalid',
    ]) {
      const response = await request(api)
        .get(`/v1/boxes/${boxId}/me/entry-state${suffix}`)
        .set('Authorization', `Bearer ${fan.token}`);
      expect(response.status).toBe(400);
    }
    const invalid = await request(api)
      .get('/v1/boxes/not-a-uuid/me/entry-state')
      .set('Authorization', `Bearer ${fan.token}`);
    expect(invalid.status).toBe(400);
    await expect(entries.getOwnEntryState(fan.id, randomUUID())).rejects.toMatchObject({
      code: 'ENTRY_NOT_FOUND',
    });
  });

  it('does not expose another creator draft or mix claims between published Drops', async () => {
    const catalog = createCatalogService({ database, logger });
    const scope = { actorUserId: other.id, creatorId: otherCreatorId, requestId: randomUUID() };
    const box = await catalog.createBox({
      ...scope,
      ...parseBoxDraftInput({
        name: 'Synthetic other Drop',
        description: '',
        openingCompatibilityVersion: 'opening-v2',
        maxOpeningsPerUser: '2',
      }),
    });
    const denied = await request(api)
      .get(`/v1/boxes/${box.id}/me/entry-state`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(denied.status).toBe(404);
    const reward = await catalog.createReward({
      ...scope,
      ...parseRewardDraftInput({
        name: 'Synthetic other reward',
        description: '',
        inventoryMode: 'unlimited',
        inventoryQuantity: null,
        inventoryStockoutPolicy: null,
        rewardType: 'digital',
      }),
    });
    if (reward.draft === null) throw new Error('Missing draft.');
    await catalog.replaceDraftConfiguration({
      ...scope,
      boxId: box.id,
      expectedRevision: 1,
      openingCompatibilityVersion: 'opening-v2',
      entries: [{ rewardVersionId: reward.draft.id, weight: 1n as ProbabilityWeight }],
    });
    const version = await catalog.publishBox({ ...scope, boxId: box.id, expectedRevision: 2 });
    expect(await ownState(fan, box.id)).toEqual({ boxId: box.id, methods: [] });
    const methodScope = { actorId: other.id, creatorId: otherCreatorId, boxId: box.id };
    const method = await entries.createMethod({ ...methodScope, definition });
    const published = await entries.publishMethod({
      ...methodScope,
      methodId: method.id,
      expectedRevision: method.revision,
      boxVersionId: version.version.id,
    });
    if (published.published === null) throw new Error('Missing publication.');
    const claim = await entries.submitClaim({
      actorId: fan.id,
      boxId: box.id,
      policyId: published.published.id,
      evidence: { note: 'Synthetic other creator proof' },
      idempotencyKey: `claim_${randomUUID()}`,
    });
    expect((await ownState()).methods.some((m) => m.policy.methodId === method.id)).toBe(false);
    expect((await ownState(fan, box.id)).methods).toMatchObject([
      { policy: published.published, claims: [{ id: claim.id }], canSubmit: false },
    ]);
    expect((await ownState(owner, box.id)).methods).toMatchObject([
      { claims: [], canSubmit: true },
    ]);
    await admin.query("update app.creators set status='suspended' where id=$1", [otherCreatorId]);
    try {
      await expect(entries.getOwnEntryState(fan.id, box.id)).rejects.toMatchObject({
        code: 'ENTRY_NOT_FOUND',
      });
    } finally {
      await admin.query("update app.creators set status='active' where id=$1", [otherCreatorId]);
    }
    // Republishing the Drop hides entry policies still bound to the older Drop version.
    const updated = await catalog.updateBox({
      ...scope,
      boxId: box.id,
      expectedRevision: 3,
      ...parseBoxDraftInput({
        name: 'Synthetic other Drop revised',
        description: '',
        openingCompatibilityVersion: 'opening-v2',
        maxOpeningsPerUser: '3',
      }),
    });
    await catalog.publishBox({ ...scope, boxId: box.id, expectedRevision: updated.revision });
    expect(await ownState(fan, box.id)).toEqual({ boxId: box.id, methods: [] });
    await catalog.archiveBox({ ...scope, boxId: box.id, expectedRevision: updated.revision + 1 });
    await expect(entries.getOwnEntryState(fan.id, box.id)).rejects.toMatchObject({
      code: 'ENTRY_NOT_FOUND',
    });
  });

  it('requires a verified active actor at HTTP and database boundaries', async () => {
    const path = `/v1/boxes/${boxId}/me/entry-state`;
    expect((await request(api).get(path)).status).toBe(401);
    expect(
      (await request(api).get(path).set('Authorization', 'Bearer synthetic-invalid')).status,
    ).toBe(401);
    const suspended = await newActor();
    await admin.query(
      "update app.users set status='suspended', updated_at=statement_timestamp() where id=$1",
      [suspended.id],
    );
    const response = await request(api).get(path).set('Authorization', `Bearer ${suspended.token}`);
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: 'ACCOUNT_NOT_ACTIVE' } });
    await expect(entries.getOwnEntryState(suspended.id, boxId)).rejects.toMatchObject({
      code: 'ENTRY_FORBIDDEN',
    });
    const binding = signer.bind(fan.id, 'state.own', { boxId });
    await expect(
      database.query('select app.entry_fan_state($1,$2,$3,$4,$5,$6)', [
        other.id,
        binding.operation,
        binding.payload,
        binding.keyVersion,
        binding.expiresMs,
        binding.signature,
      ]),
    ).rejects.toMatchObject({ code: 'P2002' });
    for (const signed of [
      signer.bind(fan.id, 'claim.own', { boxId }),
      signer.bind(fan.id, 'state.own', { boxId, userId: other.id }),
    ]) {
      await expect(
        database.query('select app.entry_fan_state($1,$2,$3,$4,$5,$6)', [
          signed.actorId,
          signed.operation,
          signed.payload,
          signed.keyVersion,
          signed.expiresMs,
          signed.signature,
        ]),
      ).rejects.toMatchObject({ code: 'P2005' });
    }
  });

  it('publishes a separate immutable policy without changing the R1 RNG hash', async () => {
    const policy = await publish();
    expect(await entries.listPublishedMethods(boxId)).toContainEqual(policy);
    await expect(
      admin.query(`update app.entry_policy_versions set openings_granted=10 where id=$1`, [
        policy.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    const method = (await entries.listMethods({ actorId: owner.id, creatorId, boxId })).find(
      (m) => m.id === policy.methodId,
    );
    if (method === undefined) throw new Error('Missing method.');
    const changed = await entries.updateMethod({
      actorId: owner.id,
      creatorId,
      boxId,
      methodId: method.id,
      expectedRevision: method.revision,
      definition: { ...definition, openingsGranted: '10' },
    });
    expect(changed.published?.definition.openingsGranted).toBe('1');
    const republished = await entries.publishMethod({
      actorId: owner.id,
      creatorId,
      boxId,
      methodId: method.id,
      expectedRevision: changed.revision,
      boxVersionId,
    });
    expect(republished.published?.definition.openingsGranted).toBe('10');
    expect(republished.published?.id).not.toBe(policy.id);
    expect(
      (
        await admin.query<{ readonly hash: string }>(
          `select encode(configuration_hash,'hex') as hash from app.box_versions where id=$1`,
          [boxVersionId],
        )
      ).rows[0]?.hash,
    ).toBe(originalHash);
    await expect(submit(policy)).rejects.toMatchObject({ code: 'ENTRY_UNAVAILABLE' });
  });

  it('creates pending proof, grants nothing until approval, and grants exactly once', async () => {
    const policy = await publish({ ...definition, openingsGranted: '5' });
    const claim = await submit(policy);
    expect(claim.status).toBe('pending');
    expect(await grants(claim.id)).toEqual([{ count: '0', quantity: '0' }]);
    expect((await approve(claim.id, manager)).status).toBe('approved');
    expect((await approve(claim.id)).status).toBe('approved');
    expect(await grants(claim.id)).toEqual([{ count: '1', quantity: '5' }]);
    await expect(approve(claim.id, owner, 'rejected')).rejects.toMatchObject({
      code: 'ENTRY_CONFLICT',
    });
    await expect(submit(policy)).rejects.toMatchObject({ code: 'ENTRY_CLAIM_LIMIT_REACHED' });
  });

  it('rejection is terminal, grants nothing, and releases the slot for corrected proof', async () => {
    const policy = await publish();
    const claim = await submit(policy);
    expect((await approve(claim.id, owner, 'rejected')).status).toBe('rejected');
    expect((await approve(claim.id, manager, 'rejected')).status).toBe('rejected');
    await expect(approve(claim.id)).rejects.toMatchObject({ code: 'ENTRY_CONFLICT' });
    expect(await grants(claim.id)).toEqual([{ count: '0', quantity: '0' }]);
    expect((await submit(policy)).status).toBe('pending');
  });

  it('denies cross-user/cross-creator reads, editor approval, and actor mass assignment', async () => {
    const policy = await publish();
    const claim = await submit(policy);
    await expect(entries.getOwnClaim(other.id, claim.id)).rejects.toMatchObject({
      code: 'ENTRY_NOT_FOUND',
    });
    await expect(entries.getReviewClaim(other.id, creatorId, claim.id)).rejects.toMatchObject({
      code: 'ENTRY_NOT_FOUND',
    });
    await expect(entries.getReviewClaim(owner.id, otherCreatorId, claim.id)).rejects.toMatchObject({
      code: 'ENTRY_NOT_FOUND',
    });
    await expect(approve(claim.id, editor)).rejects.toMatchObject({ code: 'ENTRY_FORBIDDEN' });
    const response = await request(api)
      .post(`/v1/boxes/${boxId}/entry-claims`)
      .set('Authorization', `Bearer ${fan.token}`)
      .set('Idempotency-Key', `claim_${randomUUID()}`)
      .send({ policyId: policy.id, evidence: { note: 'synthetic' }, userId: other.id });
    expect(response.status).toBe(400);
    expect(await grants(claim.id)).toEqual([{ count: '0', quantity: '0' }]);
  });

  it('prevents a creator reviewer from approving their own claim', async () => {
    const policy = await publish();
    const ownerClaim = await submit(policy, owner);
    await expect(approve(ownerClaim.id, owner)).rejects.toMatchObject({
      code: 'ENTRY_FORBIDDEN',
    });
    expect((await entries.getOwnClaim(owner.id, ownerClaim.id)).status).toBe('pending');
    expect(await grants(ownerClaim.id)).toEqual([{ count: '0', quantity: '0' }]);
    expect((await approve(ownerClaim.id, manager)).status).toBe('approved');

    const managerClaim = await submit(policy, manager);
    await expect(approve(managerClaim.id, manager)).rejects.toMatchObject({
      code: 'ENTRY_FORBIDDEN',
    });
    expect(await grants(managerClaim.id)).toEqual([{ count: '0', quantity: '0' }]);
    expect((await approve(managerClaim.id, owner)).status).toBe('approved');
  });

  it('rejects missing required evidence, unknown fields, and unpublished methods', async () => {
    const policy = await publish();
    await expect(submit(policy, fan, {})).rejects.toMatchObject({ code: 'ENTRY_INVALID_INPUT' });
    await expect(
      submit(policy, fan, { note: 'synthetic', grantId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'ENTRY_INVALID_INPUT' });
    await expect(
      entries.submitClaim({
        actorId: fan.id,
        boxId,
        policyId: randomUUID(),
        evidence: { note: 'synthetic' },
        idempotencyKey: `claim_${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: 'ENTRY_NOT_FOUND' });
  });

  it('uses authenticated private Storage for the Instagram username + screenshot flow', async () => {
    const policy = await publish({
      ...definition,
      platform: 'instagram',
      action: 'like_post',
      targetReference: 'https://instagram.com/p/synthetic',
      evidenceRequirements: {
        ...definition.evidenceRequirements,
        platform_username: 'required',
        screenshot: 'required',
        note: 'optional',
      },
    });
    const evidence = await entries.createEvidence({
      actorId: fan.id,
      boxId,
      policyId: policy.id,
      mediaType: 'image/png',
      byteLength: png.length,
    });
    const uploaded = await entries.uploadEvidence({
      actorId: fan.id,
      evidenceId: evidence.id,
      accessToken: fan.token,
      mediaType: 'image/png',
      bytes: png,
    });
    expect(uploaded.uploaded).toBe(true);
    const storageHeaders = { apikey: publicKey, Authorization: `Bearer ${fan.token}` };
    const overwrite = await fetch(`${baseUrl}/storage/v1/object/entry-evidence/${evidence.id}`, {
      method: 'PUT',
      headers: { ...storageHeaders, 'Content-Type': 'image/png' },
      body: png,
    });
    expect(overwrite.ok).toBe(false);
    await overwrite.body?.cancel();
    const signedUpload = await fetch(
      `${baseUrl}/storage/v1/object/upload/sign/entry-evidence/${evidence.id}`,
      {
        method: 'POST',
        headers: { ...storageHeaders, 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    expect(signedUpload.ok).toBe(false);
    await signedUpload.body?.cancel();
    const listing = await fetch(`${baseUrl}/storage/v1/object/list/entry-evidence`, {
      method: 'POST',
      headers: { ...storageHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: '', limit: 100 }),
    });
    const listed: unknown = await listing.json();
    if (listing.ok) expect(listed).toEqual([]);
    const removal = await fetch(`${baseUrl}/storage/v1/object/entry-evidence`, {
      method: 'DELETE',
      headers: { ...storageHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [evidence.id] }),
    });
    await removal.body?.cancel();
    // The authorized reads below also prove that no object was removed or overwritten.
    const claim = await submit(policy, fan, {
      platform_username: 'synthetic_fan',
      screenshot: evidence.id,
    });
    const authorized = await entries.downloadEvidence({
      actorId: owner.id,
      creatorId,
      evidenceId: evidence.id,
      accessToken: owner.token,
    });
    expect(Buffer.from(authorized.bytes)).toEqual(png);
    expect(
      Buffer.from(
        (
          await entries.downloadEvidence({
            actorId: fan.id,
            creatorId: null,
            evidenceId: evidence.id,
            accessToken: fan.token,
          })
        ).bytes,
      ),
    ).toEqual(png);
    for (const token of [fan.token, owner.token]) {
      const signed = await fetch(
        `${baseUrl}/storage/v1/object/sign/entry-evidence/${evidence.id}`,
        {
          method: 'POST',
          headers: {
            apikey: publicKey,
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ expiresIn: 31536000 }),
        },
      );
      expect(signed.ok).toBe(false);
      await signed.body?.cancel();
    }
    await expect(
      entries.downloadEvidence({
        actorId: other.id,
        creatorId: otherCreatorId,
        evidenceId: evidence.id,
        accessToken: other.token,
      }),
    ).rejects.toMatchObject({ code: 'ENTRY_NOT_FOUND' });
    for (const [path, token] of [
      [`object/public/entry-evidence/${evidence.id}`, null],
      [`object/authenticated/entry-evidence/${evidence.id}`, other.token],
      [`object/authenticated/entry-evidence/${evidence.id}`, editor.token],
    ] as const) {
      const response = await fetch(`${baseUrl}/storage/v1/${path}`, {
        headers: {
          apikey: publicKey,
          ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        },
      });
      expect(response.ok).toBe(false);
      await response.body?.cancel();
    }
    const publicPolicies = JSON.stringify(await entries.listPublishedMethods(boxId));
    expect(publicPolicies).not.toContain(evidence.id);
    expect(publicPolicies).not.toContain('synthetic_fan');
    expect((await approve(claim.id)).status).toBe('approved');
    expect(await grants(claim.id)).toEqual([{ count: '1', quantity: '1' }]);
  });

  it('approved claim entitlements feed one normal non-financial v2 opening and replay', async () => {
    const policy = await publish();
    const claim = await submit(policy, other);
    await approve(claim.id);
    const fairness = createFairnessService({
      database,
      logger,
      generateSeed: () => randomBytes(32),
      keyProvider: createEnvironmentSeedEncryptionKeyProvider({
        historicalKeys: {},
        keyHex: '00'.repeat(32),
        version: 'local-dev-v1',
      }),
      policy: { maxAgeMs: 86400000, maxOpenings: 1000n },
    });
    const initialized = await fairness.initialize({ requestId: randomUUID(), userId: other.id });
    const clientSeed = 'ab'.repeat(32) as ClientSeed;
    await fairness.updateClientSeed({
      requestId: randomUUID(),
      userId: other.id,
      clientSeed,
      expectedRevision: initialized.fairness.revision,
      expectedSeedSetId: initialized.fairness.activeSeedSet.id,
      expectedServerSeedCommitment: initialized.fairness.activeSeedSet.commitment,
    });
    const opening = createOpeningService({ database, logger, fairnessService: fairness });
    const command = {
      boxId,
      clientSeed,
      userId: other.id,
      requestId: randomUUID(),
      idempotencyKey: `opening_${randomUUID()}`,
      expectedBoxVersionId: boxVersionId,
      expectedConfigurationHash: originalHash,
      expectedSeedSetId: initialized.fairness.activeSeedSet.id,
      expectedServerSeedCommitment: initialized.fairness.activeSeedSet.commitment,
    };
    const result = await opening.openBox(command);
    expect(result.body.opening).toMatchObject({
      openingCompatibilityVersion: 'opening-v2',
      entitlement: { remaining: '0' },
    });
    expect(result.body.opening).not.toHaveProperty('wallet');
    expect(result.body.opening).not.toHaveProperty('cost');
    expect(await opening.openBox(command)).toEqual({ ...result, replayed: true });
  });

  it('completes the Instagram configuration, upload, pending review and approval entirely over HTTP', async () => {
    const methodsPath = `/v1/creators/${creatorId}/boxes/${boxId}/entry-methods`;
    const rules = {
      ...definition,
      platform: 'instagram',
      action: 'like_post',
      targetReference: 'https://instagram.com/p/synthetic-http',
      evidenceRequirements: {
        ...definition.evidenceRequirements,
        note: 'optional',
        platform_username: 'required',
        screenshot: 'required',
      },
    };
    expect((await request(api).post(methodsPath).send({ definition: rules })).status).toBe(401);
    expect(
      (
        await request(api)
          .post(methodsPath)
          .set('Authorization', `Bearer ${other.token}`)
          .send({ definition: rules })
      ).status,
    ).toBe(404);
    const created = await request(api)
      .post(methodsPath)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ definition: rules });
    expect(created.status).toBe(201);
    const draft = parseEntryMethod(entryRecord(created.body, ['method']).method);
    expect(
      (
        await request(api)
          .post(`${methodsPath}/${draft.id}/publish`)
          .set('Authorization', `Bearer ${owner.token}`)
          .send({ boxVersionId })
      ).status,
    ).toBe(428);
    const published = await request(api)
      .post(`${methodsPath}/${draft.id}/publish`)
      .set('Authorization', `Bearer ${owner.token}`)
      .set('If-Match', `"${String(draft.revision)}"`)
      .send({ boxVersionId });
    expect(published.status).toBe(200);
    const policy = parseEntryMethod(entryRecord(published.body, ['method']).method).published;
    if (policy === null) throw new Error('Missing HTTP entry policy.');
    const evidencePath = `/v1/boxes/${boxId}/entry-evidence`;
    for (const invalid of [
      { mediaType: 'image/svg+xml', byteLength: 100 },
      { mediaType: 'image/png', byteLength: 5242881 },
    ]) {
      expect(
        (
          await request(api)
            .post(evidencePath)
            .set('Authorization', `Bearer ${fan.token}`)
            .send({ policyId: policy.id, ...invalid })
        ).status,
      ).toBe(400);
    }
    const initialized = await request(api)
      .post(evidencePath)
      .set('Authorization', `Bearer ${fan.token}`)
      .send({ policyId: policy.id, mediaType: 'image/png', byteLength: png.length });
    expect(initialized.status).toBe(201);
    const metadata = entryRecord(entryRecord(initialized.body, ['evidence']).evidence, [
      'id',
      'mediaType',
      'byteLength',
      'uploaded',
    ]);
    const evidenceId = entryId(metadata.id);
    const ownContent = `/v1/me/entry-evidence/${evidenceId}/content`;
    const proof = { platform_username: 'synthetic_http_fan', screenshot: evidenceId };
    const postClaim = (actor: Actor) =>
      request(api)
        .post(`/v1/boxes/${boxId}/entry-claims`)
        .set('Authorization', `Bearer ${actor.token}`)
        .set('Idempotency-Key', `http_${randomUUID()}`)
        .send({ policyId: policy.id, evidence: proof });
    expect((await postClaim(fan)).status).toBe(400); // unfinished object is not submitted proof
    expect(
      (
        await request(api)
          .post(ownContent)
          .set('Authorization', `Bearer ${other.token}`)
          .set('Content-Type', 'image/png')
          .send(png)
      ).status,
    ).toBe(404);
    expect(
      (
        await request(api)
          .post(ownContent)
          .set('Authorization', `Bearer ${fan.token}`)
          .set('Content-Type', 'image/png')
          .send(png)
      ).status,
    ).toBe(200);
    expect((await postClaim(other)).status).toBe(400); // cannot reuse someone else's screenshot
    const submitted = await postClaim(fan);
    expect(submitted.status).toBe(201);
    const claim = parseEntryClaim(entryRecord(submitted.body, ['claim']).claim);
    expect(claim.status).toBe('pending');
    expect(await grants(claim.id)).toEqual([{ count: '0', quantity: '0' }]);
    const reviewContent = `/v1/creators/${creatorId}/entry-evidence/${evidenceId}/content`;
    for (const denied of [other, editor]) {
      expect(
        (await request(api).get(reviewContent).set('Authorization', `Bearer ${denied.token}`))
          .status,
      ).toBe(denied === editor ? 403 : 404);
    }
    const image = await request(api)
      .get(reviewContent)
      .set('Authorization', `Bearer ${manager.token}`);
    expect(image.status).toBe(200);
    expect(image.headers['cache-control']).toBe('private, no-store');
    expect(image.headers['x-content-type-options']).toBe('nosniff');
    expect(image.body).toEqual(png);
    const reviewPath = `/v1/creators/${creatorId}/entry-claims/${claim.id}/review`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reviewed = await request(api)
        .post(reviewPath)
        .set('Authorization', `Bearer ${manager.token}`)
        .send({ decision: 'approved', note: 'Synthetic human review.' });
      expect(reviewed.status).toBe(200);
      expect(parseEntryClaim(entryRecord(reviewed.body, ['claim']).claim).status).toBe('approved');
    }
    expect(await grants(claim.id)).toEqual([{ count: '1', quantity: '1' }]);
    const own = await request(api)
      .get(`/v1/me/entry-claims/${claim.id}`)
      .set('Authorization', `Bearer ${fan.token}`);
    expect(own.status).toBe(200);
    expect(parseEntryClaim(entryRecord(own.body, ['claim']).claim)).toMatchObject({
      status: 'approved',
      policy,
    });
    const publicResponse = await request(api).get(`/v1/boxes/${boxId}/entry-methods`);
    expect(publicResponse.status).toBe(200);
    expect(publicResponse.text).not.toContain(evidenceId);
    expect(publicResponse.text).not.toContain('synthetic_http_fan');
  });

  const serviceFor = (connection: Database) =>
    createEntryService({
      database: connection,
      signer,
      storage: createSupabaseEntryStorage({
        url: `${baseUrl}/storage/v1`,
        publishableKey: publicKey,
      }),
    });
  const waitForBlocked = async (pids: readonly number[]) => {
    for (let attempt = 0; attempt < 2000; attempt += 1) {
      const result = await admin.query<{ readonly blocked: number }>(
        `select count(*)::integer as blocked from pg_stat_activity where pid = any($1::integer[]) and cardinality(pg_blocking_pids(pid)) > 0`,
        [pids],
      );
      if (result.rows[0]?.blocked === pids.length) return;
    }
    throw new Error('R2A concurrency barrier was not reached.');
  };
  const holdGuard = async (userId: string, methodId: string | null) => {
    if (methodId === null)
      await admin.query(
        `insert into app_private.entry_submission_guards values ($1) on conflict do nothing`,
        [userId],
      );
    const ready = signal();
    const release = signal();
    const done = admin
      .transaction(async (transaction) => {
        if (methodId === null)
          await transaction.query(
            `select 1 from app_private.entry_submission_guards where user_id=$1 for update`,
            [userId],
          );
        else
          await transaction.query(
            `select 1 from app_private.entry_claim_guards where user_id=$1 and method_id=$2 for update`,
            [userId, methodId],
          );
        ready.resolve();
        await release.promise;
      })
      .catch((error: unknown) => {
        ready.reject(error);
        throw error;
      });
    await ready.promise;
    return { release: () => release.resolve(), done };
  };
  const pid = async (connection: Database) => {
    const result = await connection.query<{ readonly pid: number }>(
      'select pg_backend_pid() as pid',
    );
    const value = result.rows[0]?.pid;
    if (value === undefined) throw new Error('Missing test connection PID.');
    return value;
  };
  it('serializes concurrent submissions at limit one using independent connections and a barrier', async () => {
    const policy = await publish();
    const a = pool(false, 1);
    const b = pool(false, 1);
    const barrier = await holdGuard(fan.id, null);
    try {
      const pids = await Promise.all([pid(a), pid(b)]);
      const results = Promise.allSettled([
        submit(policy, fan, { note: 'first' }, serviceFor(a)),
        submit(policy, fan, { note: 'second' }, serviceFor(b)),
      ]);
      try {
        await waitForBlocked(pids);
        expect(await methodState(policy)).toMatchObject({
          remainingSlots: '1',
          canSubmit: true,
          claims: [],
        });
      } finally {
        barrier.release();
      }
      const outcomes = await results;
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const failures = outcomes.filter((o) => o.status === 'rejected');
      expect(failures).toHaveLength(1);
      expect(failures[0]?.reason).toMatchObject({ code: 'ENTRY_CLAIM_LIMIT_REACHED' });
      expect(await methodState(policy)).toMatchObject({
        reservedSlots: '1',
        remainingSlots: '0',
        canSubmit: false,
        claimCount: '1',
        claims: [{ status: 'pending' }],
      });
      expect(
        (
          await admin.query(
            `select status from app.entry_claims where method_id=$1 and user_id=$2`,
            [policy.methodId, fan.id],
          )
        ).rows,
      ).toEqual([{ status: 'pending' }]);
    } finally {
      barrier.release();
      await barrier.done;
      await a.close();
      await b.close();
    }
  });
  it('two concurrent reviewers converge on one decision and one exact grant', async () => {
    const policy = await publish({ ...definition, openingsGranted: '7' });
    const claim = await submit(policy);
    const a = pool(false, 1);
    const b = pool(false, 1);
    const barrier = await holdGuard(fan.id, policy.methodId);
    try {
      const pids = await Promise.all([pid(a), pid(b)]);
      const result = Promise.all([
        approve(claim.id, owner, 'approved', serviceFor(a)),
        approve(claim.id, manager, 'approved', serviceFor(b)),
      ]);
      try {
        await waitForBlocked(pids);
      } finally {
        barrier.release();
      }
      const [first, second] = await result;
      expect(first).toEqual(second);
      expect(first.status).toBe('approved');
      expect(await grants(claim.id)).toEqual([{ count: '1', quantity: '7' }]);
      expect(
        (
          await admin.query(
            `select count(*)::text as count from app.entry_claim_reviews where claim_id=$1`,
            [claim.id],
          )
        ).rows,
      ).toEqual([{ count: '1' }]);
    } finally {
      barrier.release();
      await barrier.done;
      await a.close();
      await b.close();
    }
  });
  it('same-key concurrent submission replays one claim and rejects different semantics', async () => {
    const policy = await publish();
    const input = {
      actorId: fan.id,
      boxId,
      policyId: policy.id,
      evidence: { note: 'same synthetic evidence' },
      idempotencyKey: `claim_${randomUUID()}`,
    };
    const a = pool(false, 1);
    const b = pool(false, 1);
    const barrier = await holdGuard(fan.id, null);
    try {
      const pids = await Promise.all([pid(a), pid(b)]);
      const result = Promise.all([
        serviceFor(a).submitClaim(input),
        serviceFor(b).submitClaim(input),
      ]);
      try {
        await waitForBlocked(pids);
      } finally {
        barrier.release();
      }
      const [first, second] = await result;
      expect(first).toEqual(second);
      await expect(
        entries.submitClaim({ ...input, evidence: { note: 'different' } }),
      ).rejects.toMatchObject({ code: 'ENTRY_CONFLICT' });
    } finally {
      barrier.release();
      await barrier.done;
      await a.close();
      await b.close();
    }
  });
  it('rolls back the review when the existing R1 grant primitive fails', async () => {
    const policy = await publish();
    const claim = await submit(policy);
    const fault = pool(true, 1);
    // Session-owned fault injection affects this synthetic claim only, not other grants.
    if (!/^[0-9a-f-]{36}$/u.test(claim.id)) throw new Error('Invalid synthetic claim ID.');
    try {
      await fault.query(`create function pg_temp.reject_r2a_grant() returns trigger language plpgsql as $f$ begin
        if new.source_type = 'entry_claim' and new.source_identity = tg_argv[0] then raise exception 'synthetic entry grant failure'; end if; return new; end $f$`);
      await fault.query(
        `create trigger synthetic_r2a_grant_failure before insert on app.opening_entitlement_grants for each row execute function pg_temp.reject_r2a_grant('entry_claim:${claim.id}')`,
      );
      await expect(approve(claim.id)).rejects.toThrow('synthetic entry grant failure');
      expect((await entries.getOwnClaim(fan.id, claim.id)).status).toBe('pending');
      expect(await grants(claim.id)).toEqual([{ count: '0', quantity: '0' }]);
      expect(
        (
          await admin.query(
            `select count(*)::text as count from app.entry_claim_reviews where claim_id=$1`,
            [claim.id],
          )
        ).rows,
      ).toEqual([{ count: '0' }]);
    } finally {
      await fault.query(
        'drop trigger if exists synthetic_r2a_grant_failure on app.opening_entitlement_grants',
      );
      await fault.close();
    }
    expect((await approve(claim.id)).status).toBe('approved');
  });
  it('enforces higher limits and creator-wide normalized order-reference reuse', async () => {
    const policy = await publish({
      ...definition,
      platform: 'commerce',
      action: 'previous_purchase',
      perUserClaimLimit: '3',
      evidenceRequirements: {
        ...definition.evidenceRequirements,
        order_reference: 'required',
        note: 'optional',
      },
    });
    const reference = `synthetic-${randomUUID()}`;
    const first = await submit(policy, fan, { order_reference: reference });
    await expect(
      submit(policy, other, { order_reference: reference.toUpperCase() }),
    ).rejects.toMatchObject({ code: 'ENTRY_CONFLICT' });
    await submit(policy, fan, { order_reference: `${reference}-2` });
    await submit(policy, fan, { order_reference: `${reference}-3` });
    await expect(submit(policy, fan, { order_reference: `${reference}-4` })).rejects.toMatchObject({
      code: 'ENTRY_CLAIM_LIMIT_REACHED',
    });
    await approve(first.id, owner, 'rejected');
    expect((await submit(policy, other, { order_reference: reference })).status).toBe('pending');
  });
  it('retains the claimed policy and grant quantity when rules are republished or disabled', async () => {
    const policy = await publish();
    const claim = await submit(policy);
    const changed = await entries.updateMethod({
      actorId: owner.id,
      creatorId,
      boxId,
      methodId: policy.methodId,
      expectedRevision: 2,
      definition: { ...definition, openingsGranted: '10' },
    });
    const published = await entries.publishMethod({
      actorId: owner.id,
      creatorId,
      boxId,
      methodId: policy.methodId,
      expectedRevision: changed.revision,
      boxVersionId,
    });
    await entries.setMethodEnabled({
      actorId: owner.id,
      creatorId,
      boxId,
      methodId: policy.methodId,
      expectedRevision: published.revision,
      enabled: false,
    });
    if (published.published === null) throw new Error('Missing published rule.');
    await expect(submit(published.published)).rejects.toMatchObject({ code: 'ENTRY_UNAVAILABLE' });
    const approved = await approve(claim.id);
    expect(approved.policy).toEqual(policy);
    expect(await grants(claim.id)).toEqual([{ count: '1', quantity: '1' }]);
  });
  it('denies raw runtime table writes, operator grants, and forged/expired/null actor capabilities', async () => {
    const privileges = await admin.query(
      `select n.nspname as schema, p.proname as function from pg_proc p
       join pg_namespace n on n.oid=p.pronamespace
       where n.nspname in ('app','app_private') and p.proname like 'entry_%'
       and has_function_privilege('authenticated',p.oid,'EXECUTE') order by 1,2`,
    );
    expect(privileges.rows).toEqual([{ schema: 'app_private', function: 'entry_storage_allowed' }]);
    expect(
      (
        await admin.query(
          `select has_schema_privilege('authenticated','app_private','USAGE') as allowed`,
        )
      ).rows,
    ).toEqual([{ allowed: false }]);
    expect(
      (
        await admin.query(`select p.proname as function from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('app','app_private') and p.proname like 'entry_%'
      and has_function_privilege('anon',p.oid,'EXECUTE')`)
      ).rows,
    ).toEqual([]);
    const policy = await publish();
    await expect(
      database.query(`update app.entry_policy_versions set openings_granted=10 where id=$1`, [
        policy.id,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      database.query(
        `select * from app_private.grant_opening_entitlement($1,$2,$3,$4,1,'synthetic','synthetic',$2,'synthetic')`,
        [randomUUID(), fan.id, creatorId, boxId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const binding = signer.bind(fan.id, 'claim.own', { claimId: randomUUID() });
    for (const [operation, expiry, signature] of [
      [binding.operation, binding.expiresMs, Buffer.alloc(32)],
      [null, binding.expiresMs, Buffer.alloc(32)],
      [binding.operation, null, Buffer.alloc(32)],
      [binding.operation, '1', binding.signature],
    ] as const) {
      await expect(
        database.query(`select app.entry_claim_command($1,$2,$3,$4,$5,$6)`, [
          fan.id,
          operation,
          binding.payload,
          binding.keyVersion,
          expiry,
          signature,
        ]),
      ).rejects.toMatchObject({ code: 'P2002' });
    }
  });
});
