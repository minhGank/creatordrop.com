import { createHash, timingSafeEqual } from 'node:crypto';

import { v7 as uuidv7 } from 'uuid';

import type { Database, QueryExecutor } from '@creatordrop/database';
import type {
  FulfillmentAddressContract,
  FulfillmentContract,
  FulfillmentDeliveryDataResponse,
  InventoryRestockResponse,
} from '@creatordrop/contracts';
import type { Logger } from '@creatordrop/observability';

import { canPerformCreatorAction, type CreatorAction } from '../creators/creator.policy.js';
import type { CreatorRole } from '../creators/creator.js';
import { IdempotencyKeyReusedError } from '../wallet/wallet.errors.js';
import {
  type FulfillmentActorBindingInput,
  type FulfillmentActorBindingProvider,
} from './fulfillment.actor-binding.js';
import {
  buildFulfillmentAad,
  decryptFulfillmentValue,
  encryptFulfillmentValue,
  fingerprintFulfillmentCommand,
} from './fulfillment.crypto.js';
import {
  FulfillmentCryptographyError,
  FulfillmentDataUnavailableError,
  FulfillmentKeyUnavailableError,
  FulfillmentNotFoundError,
  FulfillmentPermissionDeniedError,
  FulfillmentRevisionConflictError,
  FulfillmentTransitionError,
  InventoryRestockError,
} from './fulfillment.errors.js';
import {
  deriveFulfillmentKeyIdentity,
  type FulfillmentEncryptionKey,
  type FulfillmentEncryptionKeyProvider,
} from './fulfillment.key-provider.js';
import {
  applyCreatorAction,
  deliverDigital,
  findActiveActorBindingKey,
  findCreatorFulfillment,
  findCreatorRole,
  findRegisteredKeyIdentity,
  findSensitiveEventFingerprintKey,
  findUserFulfillment,
  listCreatorFulfillments,
  listUserFulfillments,
  readProtectedDeliveryData,
  recordProtectedDeliveryDataAccess,
  redactDeliveryData,
  restockInventory,
  submitAddress,
} from './fulfillment.repository.js';
import type { CreatorFulfillmentAction } from './fulfillment.schema.js';
import { parseAddress } from './fulfillment.schema.js';
import type { FulfillmentEncryptionDomain } from './fulfillment.js';

interface ActorCommand {
  readonly actionKey: string;
  readonly actorUserId: string;
  readonly expectedRevision: number;
  readonly fulfillmentId: string;
  readonly requestId: string;
}

export interface FulfillmentService {
  applyCreatorAction(
    input: ActorCommand & {
      readonly action: CreatorFulfillmentAction;
      readonly creatorId: string;
    },
  ): Promise<{ readonly fulfillment: FulfillmentContract; readonly replayed: boolean }>;
  getCreatorDeliveryData(input: {
    readonly actorUserId: string;
    readonly creatorId: string;
    readonly fulfillmentId: string;
    readonly purpose: 'fulfillment_execution';
  }): Promise<FulfillmentDeliveryDataResponse>;
  getCreatorFulfillment(input: {
    readonly actorUserId: string;
    readonly creatorId: string;
    readonly fulfillmentId: string;
  }): Promise<FulfillmentContract>;
  getUserDeliveryData(
    userId: string,
    fulfillmentId: string,
  ): Promise<FulfillmentDeliveryDataResponse>;
  getUserFulfillment(userId: string, fulfillmentId: string): Promise<FulfillmentContract>;
  listCreatorFulfillments(
    actorUserId: string,
    creatorId: string,
  ): Promise<readonly FulfillmentContract[]>;
  listUserFulfillments(userId: string): Promise<readonly FulfillmentContract[]>;
  redactCreatorDeliveryData(input: ActorCommand & { readonly creatorId: string }): Promise<{
    readonly fulfillment: FulfillmentContract;
    readonly replayed: boolean;
  }>;
  redactUserDeliveryData(input: ActorCommand): Promise<{
    readonly fulfillment: FulfillmentContract;
    readonly replayed: boolean;
  }>;
  restock(input: {
    readonly actionKey: string;
    readonly actorUserId: string;
    readonly creatorId: string;
    readonly poolId: string;
    readonly quantity: bigint;
    readonly requestId: string;
  }): Promise<InventoryRestockResponse>;
  submitAddress(input: ActorCommand & { readonly address: FulfillmentAddressContract }): Promise<{
    readonly fulfillment: FulfillmentContract;
    readonly replayed: boolean;
  }>;
}

export interface FulfillmentServiceOptions {
  readonly actorBindingProvider: FulfillmentActorBindingProvider;
  readonly createId?: () => string;
  readonly database: Database;
  readonly keyProvider: FulfillmentEncryptionKeyProvider;
  readonly logger: Logger;
  readonly retentionMs: number | null;
  readonly clock?: () => Date;
}

const fingerprint = (value: unknown): Uint8Array =>
  createHash('sha256').update(JSON.stringify(value)).digest();

const keyIdentityMatches = (left: string, right: string): boolean => {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
};

const errorConstraint = (error: unknown): string | undefined =>
  typeof error === 'object' &&
  error !== null &&
  'constraint' in error &&
  typeof error.constraint === 'string'
    ? error.constraint
    : undefined;

const mapMutationError = (error: unknown): never => {
  const constraint = errorConstraint(error);
  if (constraint?.endsWith('action_key_reused') === true) throw new IdempotencyKeyReusedError();
  if (constraint === 'fulfillment_revision_conflict') throw new FulfillmentRevisionConflictError();
  if (constraint === 'fulfillment_not_found' || constraint === 'inventory_pool_not_found') {
    throw new FulfillmentNotFoundError();
  }
  if (constraint?.includes('permission_denied') === true)
    throw new FulfillmentPermissionDeniedError();
  if (constraint?.startsWith('inventory_restock_') === true) throw new InventoryRestockError();
  if (constraint?.startsWith('fulfillment_') === true) throw new FulfillmentTransitionError();
  throw error;
};

export const createFulfillmentService = ({
  actorBindingProvider,
  clock = () => new Date(),
  createId = uuidv7,
  database,
  keyProvider,
  logger,
  retentionMs,
}: FulfillmentServiceOptions): FulfillmentService => {
  const bindActor = async (input: FulfillmentActorBindingInput) => {
    const activeKey = await findActiveActorBindingKey(database);
    if (
      activeKey?.version !== actorBindingProvider.keyVersion ||
      !keyIdentityMatches(activeKey.identity, actorBindingProvider.keyIdentity)
    ) {
      throw new FulfillmentKeyUnavailableError();
    }
    return actorBindingProvider.bind(input);
  };
  const requireCreator = async (
    executor: QueryExecutor,
    creatorId: string,
    actorUserId: string,
    action: CreatorAction,
  ): Promise<CreatorRole> => {
    const role = await findCreatorRole(executor, creatorId, actorUserId);
    if (role === undefined) throw new FulfillmentNotFoundError();
    if (!canPerformCreatorAction(role, action)) throw new FulfillmentPermissionDeniedError();
    return role;
  };

  const requireRegisteredKey = async (
    executor: QueryExecutor,
    domain: FulfillmentEncryptionDomain,
    key: FulfillmentEncryptionKey,
  ): Promise<string> => {
    const identity = deriveFulfillmentKeyIdentity(key.key);
    const registered = await findRegisteredKeyIdentity(executor, domain, key.version);
    if (registered === undefined || !keyIdentityMatches(identity, registered)) {
      throw new FulfillmentKeyUnavailableError();
    }
    return identity;
  };

  const expiry = (): Date | null =>
    retentionMs === null ? null : new Date(clock().getTime() + retentionMs);

  const protectJson = async (
    domain: FulfillmentEncryptionDomain,
    context: {
      readonly creatorId: string;
      readonly fulfillmentId: string;
      readonly userId: string;
    },
    value: unknown,
    canonicalCommand: string,
    existingKeyVersion?: string,
  ) => {
    const key =
      existingKeyVersion === undefined
        ? await keyProvider.getActiveKey(domain)
        : await keyProvider.getKey(domain, existingKeyVersion);
    let completed = false;
    let plaintext: Uint8Array | undefined;
    let fingerprintForCleanup: Uint8Array | undefined;
    try {
      const identity = await requireRegisteredKey(database, domain, key);
      plaintext = new TextEncoder().encode(JSON.stringify(value));
      const commandFingerprint = fingerprintFulfillmentCommand({
        canonicalCommand,
        domain,
        key: key.key,
      });
      fingerprintForCleanup = commandFingerprint;
      const encrypted = encryptFulfillmentValue({
        aad: buildFulfillmentAad({ ...context, domain, keyVersion: key.version }),
        key: key.key,
        plaintext,
      });
      completed = true;
      return { ...encrypted, commandFingerprint, identity, keyVersion: key.version };
    } finally {
      key.key.fill(0);
      plaintext?.fill(0);
      if (!completed) fingerprintForCleanup?.fill(0);
    }
  };

  const existingSensitiveKeyVersion = async (
    fulfillmentId: string,
    actionKey: string,
    expectedDomain: FulfillmentEncryptionDomain,
  ): Promise<string | undefined> => {
    const existing = await findSensitiveEventFingerprintKey(database, fulfillmentId, actionKey);
    if (existing === undefined) return undefined;
    if (existing.domain !== expectedDomain || existing.version === null) {
      throw new IdempotencyKeyReusedError();
    }
    return existing.version;
  };

  const readData = async (input: {
    readonly actorUserId: string;
    readonly creatorId: string | null;
    readonly fulfillment: FulfillmentContract;
    readonly purpose: string;
  }): Promise<FulfillmentDeliveryDataResponse> => {
    // The user id is intentionally not public; retrieve it through the already-scoped record.
    const internal =
      input.creatorId === null
        ? await findUserFulfillment(database, input.actorUserId, input.fulfillment.id)
        : await findCreatorFulfillment(database, input.creatorId, input.fulfillment.id);
    if (internal === undefined) throw new FulfillmentNotFoundError();
    const accessEventId = createId();
    const actorBinding = await bindActor({
      actionKey: null,
      actorUserId: input.actorUserId,
      commandFingerprint: null,
      commandName: input.purpose,
      creatorId: input.creatorId,
      expectedRevision: null,
      nonce: accessEventId,
      operation: input.creatorId === null ? 'fulfillment.read_user' : 'fulfillment.read_creator',
      quantity: null,
      resourceId: input.fulfillment.id,
    });
    return database.transaction(async (transaction) => {
      const data = await readProtectedDeliveryData(transaction, {
        accessEventId,
        actorBinding,
        actorUserId: input.actorUserId,
        creatorId: input.creatorId,
        fulfillmentId: input.fulfillment.id,
        purpose: input.purpose,
      });
      if (data === undefined) throw new FulfillmentDataUnavailableError();
      const key = await keyProvider.getKey(data.domain, data.keyVersion);
      let plaintext: Uint8Array | undefined;
      try {
        const identity = await requireRegisteredKey(transaction, data.domain, key);
        if (!keyIdentityMatches(identity, data.keyIdentity)) {
          throw new FulfillmentKeyUnavailableError();
        }
        plaintext = decryptFulfillmentValue({
          aad: buildFulfillmentAad({
            creatorId: input.fulfillment.creatorId,
            domain: data.domain,
            fulfillmentId: input.fulfillment.id,
            keyVersion: data.keyVersion,
            userId: internal.userId,
          }),
          authenticationTag: data.authenticationTag,
          ciphertext: data.ciphertext,
          iv: data.iv,
          key: key.key,
        });
        const decoded = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(plaintext),
        ) as unknown;
        let response: FulfillmentDeliveryDataResponse;
        if (data.domain === 'address') {
          response = {
            address: parseAddress(decoded),
            expiresAt: data.expiresAt,
            fulfillmentId: data.fulfillmentId,
          };
        } else {
          if (
            typeof decoded !== 'object' ||
            decoded === null ||
            Array.isArray(decoded) ||
            Object.keys(decoded).length !== 1 ||
            !('secret' in decoded) ||
            typeof decoded.secret !== 'string'
          ) {
            throw new FulfillmentCryptographyError();
          }
          response = {
            digitalSecret: decoded.secret,
            expiresAt: data.expiresAt,
            fulfillmentId: data.fulfillmentId,
          };
        }
        if (input.creatorId !== null) {
          await recordProtectedDeliveryDataAccess(transaction, {
            accessEventId,
            actorBinding,
            actorUserId: input.actorUserId,
            creatorId: input.creatorId,
            fulfillmentId: input.fulfillment.id,
            purpose: input.purpose,
          });
        }
        return response;
      } catch (error) {
        if (error instanceof FulfillmentKeyUnavailableError) throw error;
        throw new FulfillmentDataUnavailableError();
      } finally {
        key.key.fill(0);
        plaintext?.fill(0);
      }
    });
  };

  const reloadUser = async (
    userId: string,
    fulfillmentId: string,
  ): Promise<FulfillmentContract> => {
    const result = await findUserFulfillment(database, userId, fulfillmentId);
    if (result === undefined) throw new FulfillmentNotFoundError();
    return result.fulfillment;
  };
  const reloadCreator = async (
    creatorId: string,
    fulfillmentId: string,
  ): Promise<FulfillmentContract> => {
    const result = await findCreatorFulfillment(database, creatorId, fulfillmentId);
    if (result === undefined) throw new FulfillmentNotFoundError();
    return result.fulfillment;
  };

  return {
    listUserFulfillments: async (userId) =>
      (await listUserFulfillments(database, userId)).map(({ fulfillment }) => fulfillment),
    getUserFulfillment: async (userId, fulfillmentId) => reloadUser(userId, fulfillmentId),
    listCreatorFulfillments: async (actorUserId, creatorId) => {
      await requireCreator(database, creatorId, actorUserId, 'fulfillment.view');
      return (await listCreatorFulfillments(database, creatorId)).map(
        ({ fulfillment }) => fulfillment,
      );
    },
    getCreatorFulfillment: async ({ actorUserId, creatorId, fulfillmentId }) => {
      await requireCreator(database, creatorId, actorUserId, 'fulfillment.view');
      return reloadCreator(creatorId, fulfillmentId);
    },
    submitAddress: async (input) => {
      const record = await findUserFulfillment(database, input.actorUserId, input.fulfillmentId);
      if (record === undefined) throw new FulfillmentNotFoundError();
      const protectedValue = await protectJson(
        'address',
        {
          creatorId: record.fulfillment.creatorId,
          fulfillmentId: input.fulfillmentId,
          userId: record.userId,
        },
        input.address,
        JSON.stringify({
          action: 'submit_address',
          address: {
            addressLine1: input.address.addressLine1,
            addressLine2: input.address.addressLine2,
            city: input.address.city,
            country: input.address.country,
            postalCode: input.address.postalCode,
            recipientName: input.address.recipientName,
            region: input.address.region,
          },
        }),
        await existingSensitiveKeyVersion(input.fulfillmentId, input.actionKey, 'address'),
      );
      try {
        const eventId = createId();
        const actorBinding = await bindActor({
          actionKey: input.actionKey,
          actorUserId: input.actorUserId,
          commandFingerprint: protectedValue.commandFingerprint,
          commandName: 'submit_address',
          creatorId: null,
          expectedRevision: input.expectedRevision,
          nonce: eventId,
          operation: 'fulfillment.submit_address',
          quantity: null,
          resourceId: input.fulfillmentId,
        });
        const replayed = await database.transaction((transaction) =>
          submitAddress(transaction, {
            actionKey: input.actionKey,
            actorBinding,
            actorUserId: input.actorUserId,
            authenticationTag: protectedValue.authenticationTag,
            ciphertext: protectedValue.ciphertext,
            eventId,
            expectedRevision: input.expectedRevision,
            expiresAt: expiry(),
            fingerprint: protectedValue.commandFingerprint,
            fingerprintKeyVersion: protectedValue.keyVersion,
            fulfillmentId: input.fulfillmentId,
            iv: protectedValue.iv,
            keyIdentity: Buffer.from(protectedValue.identity, 'hex'),
            keyVersion: protectedValue.keyVersion,
          }),
        );
        logger.info('fulfillment.address.submitted', {
          actorUserId: input.actorUserId,
          fulfillmentId: input.fulfillmentId,
          replayed,
          requestId: input.requestId,
        });
        return { fulfillment: await reloadUser(input.actorUserId, input.fulfillmentId), replayed };
      } catch (error) {
        return mapMutationError(error);
      } finally {
        protectedValue.authenticationTag.fill(0);
        protectedValue.ciphertext.fill(0);
        protectedValue.commandFingerprint.fill(0);
        protectedValue.iv.fill(0);
      }
    },
    applyCreatorAction: async (input) => {
      await requireCreator(database, input.creatorId, input.actorUserId, 'fulfillment.manage');
      const record = await findCreatorFulfillment(database, input.creatorId, input.fulfillmentId);
      if (record === undefined) throw new FulfillmentNotFoundError();
      try {
        let replayed: boolean;
        if (input.action.action === 'deliver_digital') {
          const protectedValue = await protectJson(
            'digital_secret',
            {
              creatorId: record.fulfillment.creatorId,
              fulfillmentId: input.fulfillmentId,
              userId: record.userId,
            },
            { secret: input.action.secret },
            JSON.stringify({ action: 'deliver_digital', secret: input.action.secret }),
            await existingSensitiveKeyVersion(
              input.fulfillmentId,
              input.actionKey,
              'digital_secret',
            ),
          );
          try {
            const eventId = createId();
            const actorBinding = await bindActor({
              actionKey: input.actionKey,
              actorUserId: input.actorUserId,
              commandFingerprint: protectedValue.commandFingerprint,
              commandName: 'deliver_digital',
              creatorId: record.fulfillment.creatorId,
              expectedRevision: input.expectedRevision,
              nonce: eventId,
              operation: 'fulfillment.deliver_digital',
              quantity: null,
              resourceId: input.fulfillmentId,
            });
            replayed = await database.transaction((transaction) =>
              deliverDigital(transaction, {
                actionKey: input.actionKey,
                actorBinding,
                actorUserId: input.actorUserId,
                authenticationTag: protectedValue.authenticationTag,
                ciphertext: protectedValue.ciphertext,
                creatorId: record.fulfillment.creatorId,
                eventId,
                expectedRevision: input.expectedRevision,
                expiresAt: expiry(),
                fingerprint: protectedValue.commandFingerprint,
                fingerprintKeyVersion: protectedValue.keyVersion,
                fulfillmentId: input.fulfillmentId,
                iv: protectedValue.iv,
                keyIdentity: Buffer.from(protectedValue.identity, 'hex'),
                keyVersion: protectedValue.keyVersion,
              }),
            );
          } finally {
            protectedValue.authenticationTag.fill(0);
            protectedValue.ciphertext.fill(0);
            protectedValue.commandFingerprint.fill(0);
            protectedValue.iv.fill(0);
          }
        } else {
          const commandFingerprint = fingerprint(input.action);
          const eventId = createId();
          const actorBinding = await bindActor({
            actionKey: input.actionKey,
            actorUserId: input.actorUserId,
            commandFingerprint,
            commandName: input.action.action,
            creatorId: input.creatorId,
            expectedRevision: input.expectedRevision,
            nonce: eventId,
            operation: 'fulfillment.creator_action',
            quantity: null,
            resourceId: input.fulfillmentId,
          });
          replayed = await database.transaction((transaction) =>
            applyCreatorAction(transaction, {
              action: input.action.action,
              actionKey: input.actionKey,
              actorBinding,
              actorUserId: input.actorUserId,
              creatorId: input.creatorId,
              eventId,
              expectedRevision: input.expectedRevision,
              fingerprint: commandFingerprint,
              fulfillmentId: input.fulfillmentId,
            }),
          );
        }
        logger.info('fulfillment.creator_action.completed', {
          action: input.action.action,
          actorUserId: input.actorUserId,
          creatorId: input.creatorId,
          fulfillmentId: input.fulfillmentId,
          replayed,
          requestId: input.requestId,
        });
        return { fulfillment: await reloadCreator(input.creatorId, input.fulfillmentId), replayed };
      } catch (error) {
        return mapMutationError(error);
      }
    },
    getUserDeliveryData: async (userId, fulfillmentId) => {
      const fulfillment = await reloadUser(userId, fulfillmentId);
      return readData({
        actorUserId: userId,
        creatorId: null,
        fulfillment,
        purpose: 'self_service',
      });
    },
    getCreatorDeliveryData: async ({ actorUserId, creatorId, fulfillmentId, purpose }) => {
      await requireCreator(database, creatorId, actorUserId, 'fulfillment.sensitive.read');
      const fulfillment = await reloadCreator(creatorId, fulfillmentId);
      return readData({ actorUserId, creatorId, fulfillment, purpose });
    },
    redactUserDeliveryData: async (input) => {
      try {
        const commandFingerprint = fingerprint({ action: 'redact_delivery_data' });
        const eventId = createId();
        const actorBinding = await bindActor({
          actionKey: input.actionKey,
          actorUserId: input.actorUserId,
          commandFingerprint,
          commandName: 'redact_delivery_data',
          creatorId: null,
          expectedRevision: input.expectedRevision,
          nonce: eventId,
          operation: 'fulfillment.redact_user',
          quantity: null,
          resourceId: input.fulfillmentId,
        });
        const replayed = await database.transaction((transaction) =>
          redactDeliveryData(transaction, {
            actionKey: input.actionKey,
            actorBinding,
            actorUserId: input.actorUserId,
            creatorId: null,
            eventId,
            expectedRevision: input.expectedRevision,
            fingerprint: commandFingerprint,
            fulfillmentId: input.fulfillmentId,
          }),
        );
        return { fulfillment: await reloadUser(input.actorUserId, input.fulfillmentId), replayed };
      } catch (error) {
        return mapMutationError(error);
      }
    },
    redactCreatorDeliveryData: async (input) => {
      await requireCreator(database, input.creatorId, input.actorUserId, 'fulfillment.manage');
      try {
        const commandFingerprint = fingerprint({ action: 'redact_delivery_data' });
        const eventId = createId();
        const actorBinding = await bindActor({
          actionKey: input.actionKey,
          actorUserId: input.actorUserId,
          commandFingerprint,
          commandName: 'redact_delivery_data',
          creatorId: input.creatorId,
          expectedRevision: input.expectedRevision,
          nonce: eventId,
          operation: 'fulfillment.redact_creator',
          quantity: null,
          resourceId: input.fulfillmentId,
        });
        const replayed = await database.transaction((transaction) =>
          redactDeliveryData(transaction, {
            actionKey: input.actionKey,
            actorBinding,
            actorUserId: input.actorUserId,
            creatorId: input.creatorId,
            eventId,
            expectedRevision: input.expectedRevision,
            fingerprint: commandFingerprint,
            fulfillmentId: input.fulfillmentId,
          }),
        );
        return { fulfillment: await reloadCreator(input.creatorId, input.fulfillmentId), replayed };
      } catch (error) {
        return mapMutationError(error);
      }
    },
    restock: async (input) => {
      await requireCreator(database, input.creatorId, input.actorUserId, 'inventory.restock');
      try {
        const eventId = createId();
        const commandFingerprint = fingerprint({
          action: 'inventory_restock',
          quantity: input.quantity.toString(),
        });
        const actorBinding = await bindActor({
          actionKey: input.actionKey,
          actorUserId: input.actorUserId,
          commandFingerprint,
          commandName: 'inventory_restock',
          creatorId: input.creatorId,
          expectedRevision: null,
          nonce: eventId,
          operation: 'inventory.restock',
          quantity: input.quantity,
          resourceId: input.poolId,
        });
        const record = await database.transaction((transaction) =>
          restockInventory(transaction, {
            actionKey: input.actionKey,
            actorBinding,
            actorUserId: input.actorUserId,
            creatorId: input.creatorId,
            eventId,
            fingerprint: commandFingerprint,
            poolId: input.poolId,
            quantity: input.quantity,
          }),
        );
        logger.info('inventory.restock.completed', {
          actorUserId: input.actorUserId,
          creatorId: input.creatorId,
          inventoryPoolId: input.poolId,
          replayed: record.replayed,
          requestId: input.requestId,
        });
        return {
          inventoryPool: {
            availableQuantity: record.availableQuantity,
            id: record.poolId,
            initialQuantity: record.initialQuantity,
          },
          replayed: record.replayed,
          restockEvent: {
            createdAt: record.createdAt,
            id: record.eventId,
            quantityAdded: input.quantity.toString(),
          },
        };
      } catch (error) {
        return mapMutationError(error);
      }
    },
  };
};
