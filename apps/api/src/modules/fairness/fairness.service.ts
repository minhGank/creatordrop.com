import { createHash, timingSafeEqual } from 'node:crypto';

import { validate as isUuid, v7 as uuidv7 } from 'uuid';

import {
  assertTransactionExecutor,
  type Database,
  type QueryExecutor,
  type TransactionExecutor,
} from '@creatordrop/database';
import type { OpeningFairnessProofResponse } from '@creatordrop/contracts';
import {
  parseVersionedPublishedManifest,
  rngAlgorithmVersion,
  selectReward,
  verifyPublishedManifestHash,
} from '@creatordrop/domain';
import type { VersionedPublishedManifest } from '@creatordrop/domain';
import type { Logger } from '@creatordrop/observability';

import type { UserId } from '../creators/creator.js';
import {
  buildSeedEncryptionAad,
  commitServerSeed,
  decryptServerSeed,
  encryptServerSeed,
  generateServerSeed,
  serverSeedMatchesCommitment,
  type SecureRandomBytes,
} from './fairness.crypto.js';
import {
  deriveSeedEncryptionKeyIdentity,
  type SeedEncryptionKey,
  type SeedEncryptionKeyProvider,
} from './fairness.key-provider.js';
import {
  FairnessClientSeedMismatchError,
  FairnessConfirmationStaleError,
  FairnessNotInitializedError,
  FairnessRevisionConflictError,
  OpeningFairnessProofNotFoundError,
  SeedCryptographyError,
  SeedEncryptionKeyUnavailableError,
  SeedReplacementKeyUnsafeError,
  SeedRevealNotAllowedError,
  SeedRotationIdempotencyConflictError,
  SeedRotationRequiredError,
  SeedSetCompromisedError,
  SeedSetNotFoundError,
  SeedSetUnavailableError,
} from './fairness.errors.js';
import {
  findOpeningProofHeader,
  listOpeningProofManifestEntries,
} from './opening-proof.repository.js';
import {
  allocateSeedSetNonce,
  completeRotation,
  compromiseSeedSet,
  establishSeedSetKeyIdentity,
  findActiveSeedSet,
  findEncryptionKeyIdentity,
  findFairnessProfile,
  findPublicSeedSet,
  findRotation,
  findSeedSetForUser,
  insertFairnessProfile,
  insertRotation,
  insertSeedSet,
  lockFairnessProfile,
  readDatabaseTimestamp,
  retireSeedSet,
  revealSeedSet,
  updateFairnessClientSeed,
  type RotationRecord,
  type SeedSetInsert,
} from './fairness.repository.js';
import {
  toPublicSeedSet,
  type ClientSeed,
  type CurrentFairnessState,
  type Nonce,
  type NonceAllocation,
  type PublicSeedSet,
  type RngRotationId,
  type RngSeedSetId,
  type SeedRotationResult,
} from './fairness.js';

export interface SeedRotationPolicy {
  readonly maxAgeMs: number;
  readonly maxOpenings: bigint;
}

export interface InitializeFairnessCommand {
  readonly requestId: string;
  readonly userId: UserId;
}

export interface UpdateClientSeedCommand extends InitializeFairnessCommand {
  readonly clientSeed: ClientSeed;
  readonly expectedSeedSetId: RngSeedSetId;
  readonly expectedServerSeedCommitment: string;
  readonly expectedRevision: number;
}

type SeedRetirementReason = 'operational_request' | 'policy_change' | 'user_request';
type SeedCompromiseReason = 'key_compromise' | 'operational_compromise';

interface RotationCommandIdentity {
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly userId: UserId;
}

interface RotationIntent {
  readonly fingerprint: string;
  readonly operationType: RotationRecord['operationType'];
  readonly reason: SeedCompromiseReason | SeedRetirementReason;
}

interface PreparedSeedMaterial {
  readonly algorithmVersion: typeof rngAlgorithmVersion;
  readonly authenticationTag: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly commitment: string;
  readonly encryptionIv: Uint8Array;
  readonly encryptionKeyIdentity: string;
  readonly encryptionKeyVersion: string;
  readonly id: RngSeedSetId;
  readonly userId: UserId;
}

export interface RotateSeedCommand extends RotationCommandIdentity {
  readonly reason?: SeedRetirementReason;
}

export interface RevealSeedCommand {
  readonly actorUserId: UserId;
  readonly requestId: string;
  readonly seedSetId: RngSeedSetId;
}

export interface ReplaceCompromisedSeedCommand extends RotationCommandIdentity {
  readonly reason: SeedCompromiseReason;
}

export interface FairnessService {
  getCurrent(userId: UserId): Promise<CurrentFairnessState>;
  getOpeningProof(publicOpeningId: string): Promise<OpeningFairnessProofResponse['proof']>;
  getPublicSeedSet(seedSetId: RngSeedSetId): Promise<PublicSeedSet>;
  initialize(command: InitializeFairnessCommand): Promise<{
    readonly created: boolean;
    readonly fairness: CurrentFairnessState;
  }>;
  replaceCompromisedActiveSeed(command: ReplaceCompromisedSeedCommand): Promise<SeedRotationResult>;
  revealRetiredSeedSet(command: RevealSeedCommand): Promise<PublicSeedSet>;
  rotate(command: RotateSeedCommand): Promise<SeedRotationResult>;
  selectForOpening(
    transaction: TransactionExecutor,
    input: {
      readonly clientSeed: ClientSeed;
      readonly expectedSeedSetId: RngSeedSetId;
      readonly expectedServerSeedCommitment: string;
      readonly expectedManifestHash: string;
      readonly manifest: VersionedPublishedManifest;
      readonly userId: UserId;
    },
  ): Promise<OpeningFairnessSelection>;
  updateClientSeed(command: UpdateClientSeedCommand): Promise<CurrentFairnessState>;
}

export interface OpeningFairnessSelection extends NonceAllocation {
  readonly acceptedDigestHex: string;
  readonly acceptedRound: bigint;
  readonly boxVersionRewardId: string;
  readonly manifestHash: string;
  readonly rewardVersionId: string;
  readonly selectionValue: bigint;
}

export interface FairnessServiceOptions {
  readonly createRotationId?: () => string;
  readonly createSeedSetId?: () => string;
  readonly database: Database;
  readonly generateEncryptionIv?: SecureRandomBytes;
  readonly generateSeed?: () => Uint8Array;
  readonly keyProvider: SeedEncryptionKeyProvider;
  readonly logger: Logger;
  readonly policy: SeedRotationPolicy;
}

const generatedUuid = (factory: () => string, name: string): string => {
  const value = factory();
  if (!isUuid(value)) throw new Error(`${name} generator returned an invalid UUID.`);
  return value.toLowerCase();
};

const parsedTimestamp = (value: string, name: string): number => {
  const parsed = new Date(value).valueOf();
  if (!Number.isSafeInteger(parsed)) throw new Error(`The ${name} timestamp is invalid.`);
  return parsed;
};

const currentFairness = (
  profile: { readonly clientSeed: ClientSeed | null; readonly revision: number },
  seedSet: PublicSeedSet,
): CurrentFairnessState => {
  const maxAgeMs =
    parsedTimestamp(seedSet.rotateAfter, 'seed rotation') -
    parsedTimestamp(seedSet.createdAt, 'seed creation');
  if (maxAgeMs < 0 || !Number.isSafeInteger(maxAgeMs)) {
    throw new Error('The active seed rotation policy is invalid.');
  }
  return {
    activeSeedSet: toPublicSeedSet(seedSet),
    clientSeed: profile.clientSeed,
    revision: profile.revision,
    rotationPolicy: { maxAgeMs, maxOpenings: seedSet.maxNonceExclusive },
  };
};

const wipeKey = (candidate: unknown): void => {
  try {
    if ((typeof candidate !== 'object' && typeof candidate !== 'function') || candidate === null) {
      return;
    }
    const key = Reflect.get(candidate, 'key') as unknown;
    if (key instanceof Uint8Array) key.fill(0);
  } catch {
    // Cleanup must not replace the stable error produced for an invalid provider value.
  }
};

const wipeKeyBytes = (candidate: unknown): void => {
  try {
    if (candidate instanceof Uint8Array) candidate.fill(0);
  } catch {
    // A malformed provider value must not be able to replace the stable error.
  }
};

const keyIdentitiesMatch = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return (
    leftBytes.byteLength === 32 &&
    rightBytes.byteLength === 32 &&
    timingSafeEqual(leftBytes, rightBytes)
  );
};

const wipePreparedSeed = (prepared: PreparedSeedMaterial | undefined): void => {
  prepared?.authenticationTag.fill(0);
  prepared?.ciphertext.fill(0);
  prepared?.encryptionIv.fill(0);
};

const rotationIntent = (
  operationType: RotationIntent['operationType'],
  reason: RotationIntent['reason'],
): RotationIntent => ({
  fingerprint: createHash('sha256')
    .update(`creatordrop:rng-rotation:v1|${operationType}|${reason}`, 'utf8')
    .digest('hex'),
  operationType,
  reason,
});

const requireMatchingRotation = (record: RotationRecord, intent: RotationIntent): void => {
  if (
    record.operationFingerprint !== intent.fingerprint ||
    record.operationType !== intent.operationType ||
    record.transitionReason !== intent.reason
  ) {
    throw new SeedRotationIdempotencyConflictError();
  }
};

const replayRotation = async (
  executor: QueryExecutor,
  record: RotationRecord,
): Promise<SeedRotationResult | undefined> => {
  if (record.newSeedSetId === null) return undefined;
  const newSeedSet = await findPublicSeedSet(executor, record.newSeedSetId);
  if (newSeedSet === undefined) throw new Error('Recorded seed rotation is incomplete.');
  return {
    newSeedSet: toPublicSeedSet(newSeedSet),
    previousSeedSetId: record.previousSeedSetId,
    replayed: true,
  };
};

const seedSetInsert = (
  prepared: PreparedSeedMaterial,
  rotatedFromSeedSetId: RngSeedSetId | null,
  timestamp: string,
  policy: SeedRotationPolicy,
): SeedSetInsert => ({
  ...prepared,
  createdAt: timestamp,
  maxNonceExclusive: policy.maxOpenings,
  rotateAfter: new Date(
    parsedTimestamp(timestamp, 'database lifecycle') + policy.maxAgeMs,
  ).toISOString(),
  rotatedFromSeedSetId,
});

export const allocateNextNonce = async (
  transaction: TransactionExecutor,
  input: {
    readonly expectedSeedSetId?: RngSeedSetId;
    readonly expectedServerSeedCommitment?: string;
    readonly userId: UserId;
  },
): Promise<NonceAllocation> => {
  assertTransactionExecutor(transaction);
  const profile = await lockFairnessProfile(transaction, input.userId);
  if (profile === undefined) throw new FairnessNotInitializedError();
  if (profile.clientSeed === null) throw new FairnessClientSeedMismatchError();
  const seedSet = await findActiveSeedSet(transaction, input.userId, true);
  if (seedSet === undefined) throw new SeedSetUnavailableError();
  if (
    (input.expectedSeedSetId !== undefined || input.expectedServerSeedCommitment !== undefined) &&
    (seedSet.id !== input.expectedSeedSetId ||
      seedSet.commitment !== input.expectedServerSeedCommitment)
  ) {
    throw new FairnessConfirmationStaleError();
  }

  const allocatedNonce = await allocateSeedSetNonce(transaction, seedSet.id);
  if (allocatedNonce === undefined) throw new SeedRotationRequiredError();
  const nonce = BigInt(allocatedNonce) as Nonce;
  return {
    algorithmVersion: seedSet.algorithmVersion,
    clientSeed: profile.clientSeed,
    nonce,
    seedSetId: seedSet.id,
    serverSeedCommitment: seedSet.commitment,
  };
};

export const createFairnessService = ({
  createRotationId = uuidv7,
  createSeedSetId = uuidv7,
  database,
  generateEncryptionIv,
  generateSeed = generateServerSeed,
  keyProvider,
  logger,
  policy,
}: FairnessServiceOptions): FairnessService => {
  if (
    policy.maxAgeMs < 60_000 ||
    !Number.isSafeInteger(policy.maxAgeMs) ||
    policy.maxOpenings <= 0n ||
    policy.maxOpenings > 9_223_372_036_854_775_807n
  ) {
    throw new Error('Fairness rotation policy is invalid.');
  }

  const requireProviderKey = async (
    operation: () => Promise<SeedEncryptionKey>,
    expectedVersion?: string,
  ): Promise<SeedEncryptionKey> => {
    let candidate: unknown;
    let candidateKey: unknown;
    try {
      candidate = await operation();
      if (
        (typeof candidate !== 'object' && typeof candidate !== 'function') ||
        candidate === null
      ) {
        throw new SeedEncryptionKeyUnavailableError();
      }
      candidateKey = Reflect.get(candidate, 'key') as unknown;
      const candidateVersion = Reflect.get(candidate, 'version') as unknown;
      if (
        !(candidateKey instanceof Uint8Array) ||
        candidateKey.byteLength !== 32 ||
        typeof candidateVersion !== 'string' ||
        (expectedVersion !== undefined && candidateVersion !== expectedVersion)
      ) {
        throw new SeedEncryptionKeyUnavailableError();
      }
      return { key: Uint8Array.from(candidateKey), version: candidateVersion };
    } catch {
      throw new SeedEncryptionKeyUnavailableError();
    } finally {
      if (candidateKey === undefined) wipeKey(candidate);
      else wipeKeyBytes(candidateKey);
    }
  };

  const requireRegisteredProviderKey = async (
    executor: QueryExecutor,
    operation: () => Promise<SeedEncryptionKey>,
    expectedVersion?: string,
  ): Promise<{ readonly identity: string; readonly key: SeedEncryptionKey }> => {
    const key = await requireProviderKey(operation, expectedVersion);
    try {
      const actualIdentity = deriveSeedEncryptionKeyIdentity(key.key);
      const registeredIdentity = await findEncryptionKeyIdentity(executor, key.version);
      if (
        registeredIdentity === undefined ||
        !keyIdentitiesMatch(actualIdentity, registeredIdentity)
      ) {
        throw new SeedEncryptionKeyUnavailableError();
      }
      return { identity: registeredIdentity, key };
    } catch (error) {
      wipeKey(key);
      throw error;
    }
  };

  const prepareSeedSet = async (userId: UserId): Promise<PreparedSeedMaterial> => {
    const id = generatedUuid(createSeedSetId, 'Seed-set ID') as RngSeedSetId;
    const serverSeed = generateSeed();
    let encryptionKey: SeedEncryptionKey | undefined;
    try {
      const commitment = commitServerSeed(serverSeed);
      const registeredKey = await requireRegisteredProviderKey(database, () =>
        keyProvider.getActiveEncryptionKey(),
      );
      encryptionKey = registeredKey.key;
      const encrypted = encryptServerSeed({
        aad: buildSeedEncryptionAad({
          algorithmVersion: rngAlgorithmVersion,
          keyVersion: encryptionKey.version,
          seedSetId: id,
          userId,
        }),
        ...(generateEncryptionIv === undefined ? {} : { ivSource: generateEncryptionIv }),
        key: encryptionKey.key,
        serverSeed,
      });
      return {
        algorithmVersion: rngAlgorithmVersion,
        authenticationTag: encrypted.authenticationTag,
        ciphertext: encrypted.ciphertext,
        commitment,
        encryptionIv: encrypted.iv,
        encryptionKeyIdentity: registeredKey.identity,
        encryptionKeyVersion: encryptionKey.version,
        id,
        userId,
      };
    } finally {
      if (serverSeed instanceof Uint8Array) serverSeed.fill(0);
      wipeKey(encryptionKey);
    }
  };

  const loadCurrent = async (userId: UserId): Promise<CurrentFairnessState> => {
    const [profile, activeSeedSet] = await Promise.all([
      findFairnessProfile(database, userId),
      findActiveSeedSet(database, userId),
    ]);
    if (profile === undefined) throw new FairnessNotInitializedError();
    if (activeSeedSet === undefined) throw new SeedSetUnavailableError();
    return currentFairness(profile, activeSeedSet);
  };

  const fastRotationReplay = async (
    command: RotationCommandIdentity,
    intent: RotationIntent,
  ): Promise<{ readonly record?: RotationRecord; readonly result?: SeedRotationResult }> => {
    const existing = await findRotation(database, command.userId, command.idempotencyKey);
    if (existing === undefined) return {};
    requireMatchingRotation(existing, intent);
    const result = await replayRotation(database, existing);
    return result === undefined ? { record: existing } : { result };
  };

  const replayCompletedAfterFailure = async (
    command: RotationCommandIdentity,
    intent: RotationIntent,
    originalError: unknown,
  ): Promise<SeedRotationResult> => {
    const replay = await fastRotationReplay(command, intent);
    if (replay.result !== undefined) return replay.result;
    throw originalError;
  };

  const rotate = async (
    command: RotationCommandIdentity,
    retirementReason: SeedRetirementReason,
  ): Promise<SeedRotationResult> => {
    const intent = rotationIntent('rotation', retirementReason);
    const fastReplay = await fastRotationReplay(command, intent);
    if (fastReplay.result !== undefined) return fastReplay.result;
    if (fastReplay.record !== undefined)
      throw new Error('A normal seed rotation cannot be pending.');

    let prepared: PreparedSeedMaterial | undefined;
    try {
      const preparedSeed = await prepareSeedSet(command.userId);
      prepared = preparedSeed;
      const rotationId = generatedUuid(createRotationId, 'Seed rotation ID') as RngRotationId;
      const result = await database.transaction(async (transaction) => {
        const profile = await lockFairnessProfile(transaction, command.userId);
        if (profile === undefined) throw new FairnessNotInitializedError();
        const existing = await findRotation(transaction, command.userId, command.idempotencyKey);
        if (existing !== undefined) {
          requireMatchingRotation(existing, intent);
          const replayed = await replayRotation(transaction, existing);
          if (replayed === undefined) throw new Error('A normal seed rotation cannot be pending.');
          return replayed;
        }

        const active = await findActiveSeedSet(transaction, command.userId, true);
        if (active === undefined) throw new SeedSetUnavailableError();
        const timestamp = await readDatabaseTimestamp(transaction);
        await retireSeedSet(transaction, active.id, retirementReason, timestamp);
        const newSeedSet = await insertSeedSet(
          transaction,
          seedSetInsert(preparedSeed, active.id, timestamp, policy),
        );
        await insertRotation(transaction, {
          id: rotationId,
          idempotencyKey: command.idempotencyKey,
          newSeedSetId: newSeedSet.id,
          operationFingerprint: intent.fingerprint,
          operationType: intent.operationType,
          previousSeedSetId: active.id,
          transitionReason: intent.reason,
          userId: command.userId,
        });
        return {
          newSeedSet: toPublicSeedSet(newSeedSet),
          previousSeedSetId: active.id,
          replayed: false,
        };
      });

      if (!result.replayed) {
        logger.info('fairness.audit', {
          action: 'seed.retired',
          actorUserId: command.userId,
          reason: retirementReason,
          requestId: command.requestId,
          seedSetId: result.previousSeedSetId,
        });
        logger.info('fairness.audit', {
          action: 'seed.created',
          actorUserId: command.userId,
          requestId: command.requestId,
          seedSetId: result.newSeedSet.id,
        });
        logger.info('fairness.audit', {
          action: 'seed.rotated',
          actorUserId: command.userId,
          newSeedSetId: result.newSeedSet.id,
          previousSeedSetId: result.previousSeedSetId,
          requestId: command.requestId,
        });
      }
      return result;
    } catch (error) {
      return await replayCompletedAfterFailure(command, intent, error);
    } finally {
      wipePreparedSeed(prepared);
    }
  };

  const replaceCompromisedActiveSeed = async (
    command: ReplaceCompromisedSeedCommand,
  ): Promise<SeedRotationResult> => {
    const intent = rotationIntent('compromise_replacement', command.reason);
    const fastReplay = await fastRotationReplay(command, intent);
    if (fastReplay.result !== undefined) return fastReplay.result;

    let pending = fastReplay.record;
    let compromiseRecorded = false;
    if (pending === undefined) {
      const rotationId = generatedUuid(createRotationId, 'Seed rotation ID') as RngRotationId;
      const recorded = await database.transaction(async (transaction) => {
        if ((await lockFairnessProfile(transaction, command.userId)) === undefined) {
          throw new FairnessNotInitializedError();
        }
        const existing = await findRotation(transaction, command.userId, command.idempotencyKey);
        if (existing !== undefined) {
          requireMatchingRotation(existing, intent);
          return { created: false, record: existing };
        }
        const active = await findActiveSeedSet(transaction, command.userId, true);
        if (active === undefined) throw new SeedSetUnavailableError();
        const timestamp = await readDatabaseTimestamp(transaction);
        const record: RotationRecord = {
          id: rotationId,
          newSeedSetId: null,
          operationFingerprint: intent.fingerprint,
          operationType: intent.operationType,
          previousSeedSetId: active.id,
          transitionReason: intent.reason,
        };
        await insertRotation(transaction, {
          ...record,
          idempotencyKey: command.idempotencyKey,
          userId: command.userId,
        });
        await compromiseSeedSet(transaction, active.id, command.reason, timestamp);
        return { created: true, record };
      });
      pending = recorded.record;
      compromiseRecorded = recorded.created;
    }

    const alreadyCompleted = await replayRotation(database, pending);
    if (alreadyCompleted !== undefined) return alreadyCompleted;
    if (compromiseRecorded) {
      logger.error('fairness.audit', {
        action: 'seed.marked_compromised',
        actorUserId: command.userId,
        reason: command.reason,
        requestId: command.requestId,
        seedSetId: pending.previousSeedSetId,
      });
    }

    const predecessor = await findSeedSetForUser(
      database,
      command.userId,
      pending.previousSeedSetId,
    );
    if (predecessor?.status !== 'compromised') {
      throw new Error('Pending seed remediation has an invalid predecessor.');
    }

    let prepared: PreparedSeedMaterial | undefined;
    try {
      let establishedPredecessorKeyIdentity = predecessor.encryptionKeyIdentity;
      if (predecessor.encryptionKeyIdentity === null) {
        let resolvedPredecessorKey: SeedEncryptionKey | undefined;
        try {
          const registeredPredecessorKey = await requireRegisteredProviderKey(
            database,
            () => keyProvider.getEncryptionKey(predecessor.encryptionKeyVersion),
            predecessor.encryptionKeyVersion,
          );
          resolvedPredecessorKey = registeredPredecessorKey.key;
          establishedPredecessorKeyIdentity = registeredPredecessorKey.identity;
        } finally {
          wipeKey(resolvedPredecessorKey);
        }
      } else {
        const registeredPredecessorKeyIdentity = await findEncryptionKeyIdentity(
          database,
          predecessor.encryptionKeyVersion,
        );
        if (
          registeredPredecessorKeyIdentity === undefined ||
          !keyIdentitiesMatch(predecessor.encryptionKeyIdentity, registeredPredecessorKeyIdentity)
        ) {
          throw new SeedEncryptionKeyUnavailableError();
        }
        establishedPredecessorKeyIdentity = registeredPredecessorKeyIdentity;
      }
      const preparedSeed = await prepareSeedSet(command.userId);
      prepared = preparedSeed;
      if (
        command.reason === 'key_compromise' &&
        (preparedSeed.encryptionKeyVersion === predecessor.encryptionKeyVersion ||
          keyIdentitiesMatch(preparedSeed.encryptionKeyIdentity, establishedPredecessorKeyIdentity))
      ) {
        throw new SeedReplacementKeyUnsafeError();
      }

      const result = await database.transaction(async (transaction) => {
        if ((await lockFairnessProfile(transaction, command.userId)) === undefined) {
          throw new FairnessNotInitializedError();
        }
        const lockedRotation = await findRotation(
          transaction,
          command.userId,
          command.idempotencyKey,
        );
        if (lockedRotation === undefined)
          throw new Error('Pending seed remediation was not found.');
        requireMatchingRotation(lockedRotation, intent);
        const replayed = await replayRotation(transaction, lockedRotation);
        if (replayed !== undefined) return replayed;
        if ((await findActiveSeedSet(transaction, command.userId, true)) !== undefined) {
          throw new Error('Pending seed remediation cannot replace an unrelated active seed.');
        }
        let lockedPredecessor = await findSeedSetForUser(
          transaction,
          command.userId,
          lockedRotation.previousSeedSetId,
          true,
        );
        if (lockedPredecessor?.status !== 'compromised') {
          throw new Error('Pending seed remediation predecessor is invalid.');
        }
        if (lockedPredecessor.encryptionKeyIdentity === null) {
          lockedPredecessor = await establishSeedSetKeyIdentity(transaction, lockedPredecessor.id);
        } else if (
          !keyIdentitiesMatch(
            lockedPredecessor.encryptionKeyIdentity,
            establishedPredecessorKeyIdentity,
          )
        ) {
          throw new SeedReplacementKeyUnsafeError();
        }
        if (lockedPredecessor.encryptionKeyIdentity === null) {
          throw new SeedEncryptionKeyUnavailableError();
        }
        if (
          command.reason === 'key_compromise' &&
          (preparedSeed.encryptionKeyVersion === lockedPredecessor.encryptionKeyVersion ||
            keyIdentitiesMatch(
              preparedSeed.encryptionKeyIdentity,
              lockedPredecessor.encryptionKeyIdentity,
            ))
        ) {
          throw new SeedReplacementKeyUnsafeError();
        }
        const timestamp = await readDatabaseTimestamp(transaction);
        const newSeedSet = await insertSeedSet(
          transaction,
          seedSetInsert(preparedSeed, lockedRotation.previousSeedSetId, timestamp, policy),
        );
        await completeRotation(transaction, lockedRotation.id, newSeedSet.id);
        return {
          newSeedSet: toPublicSeedSet(newSeedSet),
          previousSeedSetId: lockedRotation.previousSeedSetId,
          replayed: false,
        };
      });

      if (!result.replayed) {
        logger.info('fairness.audit', {
          action: 'seed.created',
          actorUserId: command.userId,
          requestId: command.requestId,
          seedSetId: result.newSeedSet.id,
        });
        logger.info('fairness.audit', {
          action: 'seed.rotated',
          actorUserId: command.userId,
          newSeedSetId: result.newSeedSet.id,
          previousSeedSetId: result.previousSeedSetId,
          requestId: command.requestId,
        });
      }
      return result;
    } catch (error) {
      return await replayCompletedAfterFailure(command, intent, error);
    } finally {
      wipePreparedSeed(prepared);
    }
  };

  return {
    getCurrent: loadCurrent,

    getOpeningProof: async (publicOpeningId) =>
      database.transaction(
        async (transaction) => {
          const header = await findOpeningProofHeader(transaction, publicOpeningId);
          if (header === undefined) throw new OpeningFairnessProofNotFoundError();
          const entries = await listOpeningProofManifestEntries(transaction, header.boxVersionId);
          const manifest = parseVersionedPublishedManifest(
            header.openingCompatibilityVersion === 'opening-v2'
              ? {
                  algorithmVersion: header.algorithmVersion,
                  boxId: header.boxId,
                  boxVersionId: header.boxVersionId,
                  entries: entries.map((entry) => ({
                    boxVersionRewardId: entry.boxVersionRewardId,
                    position: entry.position,
                    rarity: entry.rarity,
                    rarityPolicyVersion: entry.rarityPolicyVersion,
                    ...(entry.xpReward === undefined ? {} : { xpReward: entry.xpReward }),
                    rewardVersionId: entry.rewardVersionId,
                    weight: entry.weight,
                  })),
                  maxOpeningsPerUser: header.maxOpeningsPerUser,
                  openingCompatibilityVersion: 'opening-v2',
                  totalWeight: header.totalWeight,
                }
              : {
                  algorithmVersion: header.algorithmVersion,
                  boxId: header.boxId,
                  boxVersionId: header.boxVersionId,
                  currency: header.currency,
                  entries: entries.map((entry) => ({
                    boxVersionRewardId: entry.boxVersionRewardId,
                    position: entry.position,
                    rewardVersionId: entry.rewardVersionId,
                    weight: entry.weight,
                  })),
                  priceMinor: header.priceMinor,
                  totalWeight: header.totalWeight,
                },
          );
          verifyPublishedManifestHash(manifest, header.configurationHash);

          const selected = manifest.entries[header.position];
          if (selected?.boxVersionRewardId !== header.selectedBoxVersionRewardId) {
            throw new Error('Opening proof has an inconsistent recorded reward.');
          }
          if (selected.rewardVersionId !== header.rewardVersionId) {
            throw new Error('Opening proof has an inconsistent recorded reward.');
          }
          let intervalStart = 0n;
          for (const entry of manifest.entries.slice(0, header.position)) {
            intervalStart += BigInt(entry.weight);
          }
          const selectionValue = BigInt(header.selectionValue);
          if (
            selectionValue < intervalStart ||
            selectionValue >= intervalStart + BigInt(selected.weight)
          ) {
            throw new Error('Opening proof has an inconsistent selection value.');
          }

          const verificationStatus =
            header.seedStatus === 'revealed'
              ? ('ready' as const)
              : header.seedStatus === 'compromised'
                ? ('unverifiable' as const)
                : ('pending_reveal' as const);
          return {
            algorithmVersion: header.algorithmVersion,
            clientSeed: header.clientSeed,
            configurationHash: header.configurationHash,
            manifest,
            nonce: header.nonce,
            openedAt: header.openedAt,
            openingId: header.openingId,
            recorded: {
              acceptedDigestHex: header.acceptedDigestHex,
              acceptedRound: header.acceptedRound,
              boxVersionRewardId: header.selectedBoxVersionRewardId,
              position: header.position,
              rewardVersionId: header.rewardVersionId,
              selectionValue: header.selectionValue,
            },
            seedSetId: header.seedSetId,
            serverSeedCommitment: header.serverSeedCommitment,
            ...(verificationStatus === 'ready' && header.revealedServerSeedHex !== null
              ? { serverSeedHex: header.revealedServerSeedHex }
              : {}),
            specificationId: 'creatordrop-rng-hmac-sha256-rejection-v1',
            verificationStatus,
          };
        },
        { isolationLevel: 'repeatable-read', readOnly: true },
      ),

    getPublicSeedSet: async (seedSetId) => {
      const seedSet = await findPublicSeedSet(database, seedSetId);
      if (seedSet === undefined) throw new SeedSetNotFoundError();
      return toPublicSeedSet(seedSet);
    },

    initialize: async (command) => {
      const existingProfile = await findFairnessProfile(database, command.userId);
      if (existingProfile !== undefined) {
        const active = await findActiveSeedSet(database, command.userId);
        if (active === undefined) throw new SeedSetUnavailableError();
        return { created: false, fairness: currentFairness(existingProfile, active) };
      }

      let prepared: PreparedSeedMaterial | undefined;
      try {
        const preparedSeed = await prepareSeedSet(command.userId);
        prepared = preparedSeed;
        const result = await database.transaction(async (transaction) => {
          const timestamp = await readDatabaseTimestamp(transaction);
          const inserted = await insertFairnessProfile(
            transaction,
            command.userId,
            null,
            timestamp,
          );
          if (inserted === undefined) {
            const existing = await lockFairnessProfile(transaction, command.userId);
            if (existing === undefined) {
              throw new Error('Fairness profile conflict could not be read.');
            }
            const active = await findActiveSeedSet(transaction, command.userId, true);
            if (active === undefined) throw new SeedSetUnavailableError();
            return { created: false, fairness: currentFairness(existing, active) };
          }
          const seedSet = await insertSeedSet(
            transaction,
            seedSetInsert(preparedSeed, null, timestamp, policy),
          );
          return { created: true, fairness: currentFairness(inserted, seedSet) };
        });

        if (result.created) {
          logger.info('fairness.audit', {
            action: 'seed.created',
            actorUserId: command.userId,
            requestId: command.requestId,
            seedSetId: result.fairness.activeSeedSet.id,
          });
        }
        return result;
      } finally {
        wipePreparedSeed(prepared);
      }
    },

    replaceCompromisedActiveSeed,

    revealRetiredSeedSet: async (command) => {
      const existing = await findSeedSetForUser(database, command.actorUserId, command.seedSetId);
      if (existing === undefined) throw new SeedSetNotFoundError();
      if (existing.status === 'revealed') return toPublicSeedSet(existing);
      if (existing.status === 'compromised') throw new SeedSetCompromisedError();
      if (existing.status !== 'retired') throw new SeedRevealNotAllowedError();

      let key: SeedEncryptionKey | undefined;
      try {
        const registeredKey = await requireRegisteredProviderKey(
          database,
          () => keyProvider.getEncryptionKey(existing.encryptionKeyVersion),
          existing.encryptionKeyVersion,
        );
        const resolvedKey = registeredKey.key;
        key = resolvedKey;
        if (
          existing.encryptionKeyIdentity !== null &&
          !keyIdentitiesMatch(existing.encryptionKeyIdentity, registeredKey.identity)
        ) {
          throw new SeedEncryptionKeyUnavailableError();
        }
        const outcome = await database.transaction(async (transaction) => {
          if ((await lockFairnessProfile(transaction, command.actorUserId)) === undefined) {
            throw new FairnessNotInitializedError();
          }
          let locked = await findSeedSetForUser(
            transaction,
            command.actorUserId,
            command.seedSetId,
            true,
          );
          if (locked === undefined) throw new SeedSetNotFoundError();
          if (locked.status === 'revealed') {
            return { compromised: false as const, seedSet: toPublicSeedSet(locked) };
          }
          if (locked.status === 'compromised') throw new SeedSetCompromisedError();
          if (locked.status !== 'retired') throw new SeedRevealNotAllowedError();

          const currentRegisteredIdentity = await findEncryptionKeyIdentity(
            transaction,
            locked.encryptionKeyVersion,
          );
          if (
            currentRegisteredIdentity === undefined ||
            !keyIdentitiesMatch(currentRegisteredIdentity, registeredKey.identity)
          ) {
            throw new SeedEncryptionKeyUnavailableError();
          }
          if (locked.encryptionKeyIdentity === null) {
            locked = await establishSeedSetKeyIdentity(transaction, locked.id);
          }
          if (locked.encryptionKeyIdentity === null) {
            throw new SeedEncryptionKeyUnavailableError();
          }
          if (!keyIdentitiesMatch(locked.encryptionKeyIdentity, currentRegisteredIdentity)) {
            throw new SeedEncryptionKeyUnavailableError();
          }
          const timestamp = await readDatabaseTimestamp(transaction);

          let decrypted: Uint8Array | undefined;
          try {
            decrypted = decryptServerSeed({
              aad: buildSeedEncryptionAad({
                algorithmVersion: locked.algorithmVersion,
                keyVersion: locked.encryptionKeyVersion,
                seedSetId: locked.id,
                userId: locked.userId,
              }),
              authenticationTag: locked.authenticationTag,
              ciphertext: locked.ciphertext,
              iv: locked.encryptionIv,
              key: resolvedKey.key,
            });
            if (!serverSeedMatchesCommitment(decrypted, locked.commitment)) {
              throw new SeedCryptographyError();
            }
            const revealed = await revealSeedSet(transaction, locked.id, decrypted, timestamp);
            return { compromised: false as const, seedSet: toPublicSeedSet(revealed) };
          } catch (error) {
            if (!(error instanceof SeedCryptographyError)) throw error;
            await compromiseSeedSet(
              transaction,
              locked.id,
              'integrity_verification_failed',
              timestamp,
            );
            return { compromised: true as const };
          } finally {
            decrypted?.fill(0);
          }
        });

        if (outcome.compromised) {
          logger.error('fairness.audit', {
            action: 'seed.marked_compromised',
            actorUserId: command.actorUserId,
            requestId: command.requestId,
            seedSetId: command.seedSetId,
          });
          throw new SeedSetCompromisedError();
        }
        logger.info('fairness.audit', {
          action: 'seed.revealed',
          actorUserId: command.actorUserId,
          requestId: command.requestId,
          seedSetId: command.seedSetId,
        });
        return outcome.seedSet;
      } finally {
        wipeKey(key);
      }
    },

    rotate: (command) => rotate(command, command.reason ?? 'user_request'),

    selectForOpening: async (transaction, input) => {
      assertTransactionExecutor(transaction);
      const allocation = await allocateNextNonce(transaction, {
        expectedSeedSetId: input.expectedSeedSetId,
        expectedServerSeedCommitment: input.expectedServerSeedCommitment,
        userId: input.userId,
      });
      if (allocation.clientSeed !== input.clientSeed) throw new FairnessClientSeedMismatchError();
      const seedSet = await findSeedSetForUser(
        transaction,
        input.userId,
        allocation.seedSetId,
        true,
      );
      if (seedSet?.status !== 'active') throw new SeedSetUnavailableError();

      let registeredKey: { readonly identity: string; readonly key: SeedEncryptionKey } | undefined;
      let decrypted: Uint8Array | undefined;
      try {
        registeredKey = await requireRegisteredProviderKey(
          transaction,
          () => keyProvider.getEncryptionKey(seedSet.encryptionKeyVersion),
          seedSet.encryptionKeyVersion,
        );
        if (
          seedSet.encryptionKeyIdentity === null ||
          !keyIdentitiesMatch(seedSet.encryptionKeyIdentity, registeredKey.identity)
        ) {
          throw new SeedEncryptionKeyUnavailableError();
        }
        decrypted = decryptServerSeed({
          aad: buildSeedEncryptionAad({
            algorithmVersion: seedSet.algorithmVersion,
            keyVersion: seedSet.encryptionKeyVersion,
            seedSetId: seedSet.id,
            userId: seedSet.userId,
          }),
          authenticationTag: seedSet.authenticationTag,
          ciphertext: seedSet.ciphertext,
          iv: seedSet.encryptionIv,
          key: registeredKey.key.key,
        });
        if (!serverSeedMatchesCommitment(decrypted, seedSet.commitment)) {
          throw new SeedCryptographyError();
        }
        const selection = selectReward({
          algorithmVersion: seedSet.algorithmVersion,
          clientSeed: allocation.clientSeed,
          expectedManifestHash: input.expectedManifestHash,
          manifest: input.manifest,
          nonce: allocation.nonce.toString(),
          seedSetId: seedSet.id,
          serverSeed: decrypted,
        });
        return {
          acceptedDigestHex: selection.acceptedDigestHex,
          acceptedRound: selection.acceptedRound,
          algorithmVersion: allocation.algorithmVersion,
          boxVersionRewardId: selection.boxVersionRewardId,
          clientSeed: allocation.clientSeed,
          manifestHash: selection.manifestHash,
          nonce: allocation.nonce,
          rewardVersionId: selection.rewardVersionId,
          seedSetId: seedSet.id,
          selectionValue: selection.selectionValue,
          serverSeedCommitment: allocation.serverSeedCommitment,
        };
      } finally {
        decrypted?.fill(0);
        wipeKey(registeredKey?.key);
      }
    },

    updateClientSeed: async (command) => {
      const result = await database.transaction(async (transaction) => {
        const current = await lockFairnessProfile(transaction, command.userId);
        if (current === undefined) throw new FairnessNotInitializedError();
        if (current.revision !== command.expectedRevision) {
          throw new FairnessRevisionConflictError(current.revision);
        }
        const active = await findActiveSeedSet(transaction, command.userId, true);
        if (active === undefined) throw new SeedSetUnavailableError();
        if (
          active.id !== command.expectedSeedSetId ||
          active.commitment !== command.expectedServerSeedCommitment
        ) {
          throw new FairnessConfirmationStaleError();
        }
        if (current.clientSeed === command.clientSeed) {
          return { changed: false as const, fairness: currentFairness(current, active) };
        }
        const timestamp = await readDatabaseTimestamp(transaction);
        const updated = await updateFairnessClientSeed(
          transaction,
          command.userId,
          command.clientSeed,
          command.expectedRevision,
          timestamp,
        );
        if (updated === undefined) throw new FairnessRevisionConflictError(current.revision);
        return { changed: true as const, fairness: currentFairness(updated, active) };
      });
      if (result.changed) {
        logger.info('fairness.audit', {
          action: 'client_seed.changed',
          actorUserId: command.userId,
          requestId: command.requestId,
          revision: result.fairness.revision,
        });
      }
      return result.fairness;
    },
  };
};
