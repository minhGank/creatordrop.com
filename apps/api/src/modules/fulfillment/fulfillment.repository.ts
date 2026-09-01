import { assertTransactionExecutor } from '@creatordrop/database';
import type { QueryExecutor, TransactionExecutor } from '@creatordrop/database';
import {
  fulfillmentStates,
  fulfillmentTypes,
  type CreatorRole,
  type FulfillmentContract,
  type FulfillmentEventContract,
  type FulfillmentState,
  type FulfillmentType,
} from '@creatordrop/contracts';

import type { ProtectedFulfillmentData } from './fulfillment.js';
import type { FulfillmentActorBinding } from './fulfillment.actor-binding.js';

interface ActorBoundInput {
  readonly actorBinding: FulfillmentActorBinding;
}

interface FulfillmentRow {
  readonly createdAt: unknown;
  readonly creatorId: unknown;
  readonly currentState: unknown;
  readonly deliveredAt: unknown;
  readonly deliveryAvailable: unknown;
  readonly deliveryExpiresAt: unknown;
  readonly deliveryRedactedAt: unknown;
  readonly fulfilledAt: unknown;
  readonly fulfillmentType: unknown;
  readonly id: unknown;
  readonly imageUrl: unknown;
  readonly name: unknown;
  readonly openingId: unknown;
  readonly revision: unknown;
  readonly rewardId: unknown;
  readonly rewardVersionId: unknown;
  readonly shippedAt: unknown;
  readonly updatedAt: unknown;
  readonly userId: unknown;
}

interface EventRow {
  readonly action: unknown;
  readonly actorType: unknown;
  readonly createdAt: unknown;
  readonly fromState: unknown;
  readonly id: unknown;
  readonly resultRevision: unknown;
  readonly toState: unknown;
}

export interface FulfillmentRecord {
  readonly fulfillment: FulfillmentContract;
  readonly userId: string;
}

const string = (value: unknown, field: string): string => {
  if (typeof value !== 'string') throw new Error(`Invalid fulfillment ${field}.`);
  return value;
};
const nullableString = (value: unknown, field: string): string | null =>
  value === null ? null : string(value, field);
const date = (value: unknown, field: string): string => {
  if (!(value instanceof Date)) throw new Error(`Invalid fulfillment ${field}.`);
  return value.toISOString();
};
const nullableDate = (value: unknown, field: string): string | null =>
  value === null ? null : date(value, field);
const number = (value: unknown, field: string): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid fulfillment ${field}.`);
  return parsed;
};
const state = (value: unknown): FulfillmentState => {
  if (typeof value !== 'string' || !fulfillmentStates.includes(value as FulfillmentState)) {
    throw new Error('Invalid fulfillment state.');
  }
  return value as FulfillmentState;
};
const type = (value: unknown): FulfillmentType => {
  if (typeof value !== 'string' || !fulfillmentTypes.includes(value as FulfillmentType)) {
    throw new Error('Invalid fulfillment type.');
  }
  return value as FulfillmentType;
};

const selectFulfillment = `
  select obligation.id, obligation.opening_id as "openingId",
    obligation.user_id as "userId", obligation.creator_id as "creatorId",
    obligation.reward_version_id as "rewardVersionId",
    obligation.fulfillment_type as "fulfillmentType",
    obligation.current_state as "currentState", obligation.revision,
    obligation.created_at as "createdAt", obligation.updated_at as "updatedAt",
    obligation.shipped_at as "shippedAt", obligation.delivered_at as "deliveredAt",
    obligation.fulfilled_at as "fulfilledAt", reward.id as "rewardId",
    reward_version.name, reward_version.image_url as "imageUrl",
    (delivery.id is not null and delivery.redacted_at is null
      and (delivery.expires_at is null or delivery.expires_at > clock_timestamp())) as "deliveryAvailable",
    delivery.expires_at as "deliveryExpiresAt", delivery.redacted_at as "deliveryRedactedAt"
  from app.fulfillment_obligations as obligation
  join app.reward_versions as reward_version on reward_version.id = obligation.reward_version_id
  join app.rewards as reward on reward.id = reward_version.reward_id
  left join app.fulfillment_delivery_data as delivery on delivery.id = obligation.id`;

const events = async (
  executor: QueryExecutor,
  fulfillmentId: string,
): Promise<readonly FulfillmentEventContract[]> => {
  const result = await executor.query<EventRow>(
    `select id, from_state as "fromState", to_state as "toState",
       actor_type as "actorType", action, result_revision as "resultRevision",
       created_at as "createdAt"
     from app.fulfillment_events where fulfillment_id = $1
     order by result_revision, created_at, id`,
    [fulfillmentId],
  );
  return result.rows.map((row) => {
    const actorType = string(row.actorType, 'event actor type');
    if (actorType !== 'system' && actorType !== 'user' && actorType !== 'creator') {
      throw new Error('Invalid fulfillment event actor type.');
    }
    return {
      action: string(row.action, 'event action'),
      actorType,
      createdAt: date(row.createdAt, 'event createdAt'),
      fromState: row.fromState === null ? null : state(row.fromState),
      id: string(row.id, 'event id'),
      revision: number(row.resultRevision, 'event revision'),
      toState: state(row.toState),
    };
  });
};

const map = async (executor: QueryExecutor, row: FulfillmentRow): Promise<FulfillmentRecord> => ({
  fulfillment: {
    createdAt: date(row.createdAt, 'createdAt'),
    creatorId: string(row.creatorId, 'creatorId'),
    deliveryData: {
      available: row.deliveryAvailable === true,
      expiresAt: nullableDate(row.deliveryExpiresAt, 'delivery expiresAt'),
      redactedAt: nullableDate(row.deliveryRedactedAt, 'delivery redactedAt'),
    },
    deliveredAt: nullableDate(row.deliveredAt, 'deliveredAt'),
    events: await events(executor, string(row.id, 'id')),
    fulfilledAt: nullableDate(row.fulfilledAt, 'fulfilledAt'),
    fulfillmentType: type(row.fulfillmentType),
    id: string(row.id, 'id'),
    openingId: string(row.openingId, 'openingId'),
    revision: number(row.revision, 'revision'),
    reward: {
      imageUrl: nullableString(row.imageUrl, 'imageUrl'),
      name: string(row.name, 'reward name'),
      rewardId: string(row.rewardId, 'rewardId'),
      rewardVersionId: string(row.rewardVersionId, 'rewardVersionId'),
    },
    shippedAt: nullableDate(row.shippedAt, 'shippedAt'),
    state: state(row.currentState),
    updatedAt: date(row.updatedAt, 'updatedAt'),
  },
  userId: string(row.userId, 'userId'),
});

export const listUserFulfillments = async (
  executor: QueryExecutor,
  userId: string,
): Promise<readonly FulfillmentRecord[]> => {
  const result = await executor.query<FulfillmentRow>(
    `${selectFulfillment} where obligation.user_id = $1 order by obligation.created_at desc, obligation.id`,
    [userId],
  );
  return Promise.all(result.rows.map((row) => map(executor, row)));
};

export const findUserFulfillment = async (
  executor: QueryExecutor,
  userId: string,
  fulfillmentId: string,
): Promise<FulfillmentRecord | undefined> => {
  const result = await executor.query<FulfillmentRow>(
    `${selectFulfillment} where obligation.user_id = $1 and obligation.id = $2`,
    [userId, fulfillmentId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : map(executor, row);
};

export const findCreatorRole = async (
  executor: QueryExecutor,
  creatorId: string,
  userId: string,
): Promise<CreatorRole | undefined> => {
  const result = await executor.query<{ readonly role: unknown }>(
    `select role from app.creator_memberships where creator_id = $1 and user_id = $2`,
    [creatorId, userId],
  );
  const role = result.rows[0]?.role;
  if (role === 'owner' || role === 'manager' || role === 'editor' || role === 'viewer') return role;
  return undefined;
};

export const listCreatorFulfillments = async (
  executor: QueryExecutor,
  creatorId: string,
): Promise<readonly FulfillmentRecord[]> => {
  const result = await executor.query<FulfillmentRow>(
    `${selectFulfillment} where obligation.creator_id = $1 order by obligation.created_at, obligation.id`,
    [creatorId],
  );
  return Promise.all(result.rows.map((row) => map(executor, row)));
};

export const findCreatorFulfillment = async (
  executor: QueryExecutor,
  creatorId: string,
  fulfillmentId: string,
): Promise<FulfillmentRecord | undefined> => {
  const result = await executor.query<FulfillmentRow>(
    `${selectFulfillment} where obligation.creator_id = $1 and obligation.id = $2`,
    [creatorId, fulfillmentId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : map(executor, row);
};

export const findRegisteredKeyIdentity = async (
  executor: QueryExecutor,
  domain: string,
  version: string,
): Promise<string | undefined> => {
  const result = await executor.query<{ readonly identity: unknown }>(
    `select encode(key_identity, 'hex') as identity
     from app.fulfillment_encryption_key_versions
     where encryption_domain = $1 and version = $2`,
    [domain, version],
  );
  const value = result.rows[0]?.identity;
  return value === undefined ? undefined : string(value, 'key identity');
};

export interface ActiveActorBindingKey {
  readonly identity: string;
  readonly version: string;
}

export const findActiveActorBindingKey = async (
  executor: QueryExecutor,
): Promise<ActiveActorBindingKey | undefined> => {
  const result = await executor.query<{
    readonly identity: unknown;
    readonly version: unknown;
  }>(
    `select version, encode(key_identity, 'hex') as identity
       from app.get_active_fulfillment_actor_binding_key()`,
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  return {
    identity: string(row.identity, 'actor-binding key identity'),
    version: string(row.version, 'actor-binding key version'),
  };
};

export interface SensitiveEventFingerprintKey {
  readonly domain: string | null;
  readonly version: string | null;
}

export const findSensitiveEventFingerprintKey = async (
  executor: QueryExecutor,
  fulfillmentId: string,
  actionKey: string,
): Promise<SensitiveEventFingerprintKey | undefined> => {
  const result = await executor.query<{
    readonly domain: unknown;
    readonly version: unknown;
  }>(
    `select fingerprint_key_domain as domain, fingerprint_key_version as version
       from app.fulfillment_events
      where fulfillment_id = $1 and action_key = $2`,
    [fulfillmentId, actionKey],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  return {
    domain: nullableString(row.domain, 'fingerprint key domain'),
    version: nullableString(row.version, 'fingerprint key version'),
  };
};

export interface FulfillmentMutationResult {
  readonly record: FulfillmentRecord;
  readonly replayed: boolean;
}

export const submitAddress = async (
  transaction: TransactionExecutor,
  input: ActorBoundInput & {
    readonly actionKey: string;
    readonly actorUserId: string;
    readonly authenticationTag: Uint8Array;
    readonly ciphertext: Uint8Array;
    readonly eventId: string;
    readonly expectedRevision: number;
    readonly expiresAt: Date | null;
    readonly fingerprint: Uint8Array;
    readonly fingerprintKeyVersion: string;
    readonly fulfillmentId: string;
    readonly iv: Uint8Array;
    readonly keyIdentity: Uint8Array;
    readonly keyVersion: string;
  },
): Promise<boolean> => {
  assertTransactionExecutor(transaction);
  const result = await transaction.query<{ readonly replayed: unknown }>(
    `select app.submit_fulfillment_address_bound(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
     ) as replayed`,
    [
      input.fulfillmentId,
      input.actorUserId,
      input.expectedRevision,
      input.eventId,
      input.actionKey,
      input.fingerprint,
      input.fingerprintKeyVersion,
      input.ciphertext,
      input.iv,
      input.authenticationTag,
      input.keyVersion,
      input.keyIdentity,
      input.expiresAt,
      input.actorBinding.keyVersion,
      input.actorBinding.expiresAtMs,
      input.actorBinding.signature,
    ],
  );
  return result.rows[0]?.replayed === true;
};

export const applyCreatorAction = async (
  transaction: TransactionExecutor,
  input: ActorBoundInput & {
    readonly action: string;
    readonly actionKey: string;
    readonly actorUserId: string;
    readonly creatorId: string;
    readonly eventId: string;
    readonly expectedRevision: number;
    readonly fingerprint: Uint8Array;
    readonly fulfillmentId: string;
  },
): Promise<boolean> => {
  assertTransactionExecutor(transaction);
  const result = await transaction.query<{ readonly replayed: unknown }>(
    `select app.apply_creator_fulfillment_action_bound(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
     ) as replayed`,
    [
      input.fulfillmentId,
      input.creatorId,
      input.actorUserId,
      input.expectedRevision,
      input.eventId,
      input.action,
      input.actionKey,
      input.fingerprint,
      input.actorBinding.keyVersion,
      input.actorBinding.expiresAtMs,
      input.actorBinding.signature,
    ],
  );
  return result.rows[0]?.replayed === true;
};

export const deliverDigital = async (
  transaction: TransactionExecutor,
  input: Parameters<typeof submitAddress>[1] & { readonly creatorId: string },
): Promise<boolean> => {
  assertTransactionExecutor(transaction);
  const result = await transaction.query<{ readonly replayed: unknown }>(
    `select app.deliver_digital_fulfillment_bound(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
     ) as replayed`,
    [
      input.fulfillmentId,
      input.creatorId,
      input.actorUserId,
      input.expectedRevision,
      input.eventId,
      input.actionKey,
      input.fingerprint,
      input.fingerprintKeyVersion,
      input.ciphertext,
      input.iv,
      input.authenticationTag,
      input.keyVersion,
      input.keyIdentity,
      input.expiresAt,
      input.actorBinding.keyVersion,
      input.actorBinding.expiresAtMs,
      input.actorBinding.signature,
    ],
  );
  return result.rows[0]?.replayed === true;
};

export const redactDeliveryData = async (
  transaction: TransactionExecutor,
  input: ActorBoundInput & {
    readonly actionKey: string;
    readonly actorUserId: string;
    readonly creatorId: string | null;
    readonly eventId: string;
    readonly expectedRevision: number;
    readonly fingerprint: Uint8Array;
    readonly fulfillmentId: string;
  },
): Promise<boolean> => {
  assertTransactionExecutor(transaction);
  const result = await transaction.query<{ readonly replayed: unknown }>(
    `select app.redact_fulfillment_delivery_data_bound(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
     ) as replayed`,
    [
      input.fulfillmentId,
      input.actorUserId,
      input.creatorId,
      input.expectedRevision,
      input.eventId,
      input.actionKey,
      input.fingerprint,
      input.actorBinding.keyVersion,
      input.actorBinding.expiresAtMs,
      input.actorBinding.signature,
    ],
  );
  return result.rows[0]?.replayed === true;
};

export const readProtectedDeliveryData = async (
  transaction: TransactionExecutor,
  input: ActorBoundInput & {
    readonly accessEventId: string;
    readonly actorUserId: string;
    readonly creatorId: string | null;
    readonly fulfillmentId: string;
    readonly purpose: string;
  },
): Promise<ProtectedFulfillmentData | undefined> => {
  assertTransactionExecutor(transaction);
  const result = await transaction.query<{
    readonly ciphertext: unknown;
    readonly encryptionAuthTag: unknown;
    readonly encryptionDomain: unknown;
    readonly encryptionIv: unknown;
    readonly encryptionKeyIdentity: unknown;
    readonly encryptionKeyVersion: unknown;
    readonly expiresAt: unknown;
    readonly fulfillmentId: unknown;
  }>(
    `select fulfillment_id as "fulfillmentId", encryption_domain as "encryptionDomain",
       ciphertext, encryption_iv as "encryptionIv",
       encryption_auth_tag as "encryptionAuthTag",
       encryption_key_version as "encryptionKeyVersion",
       encryption_key_identity as "encryptionKeyIdentity", expires_at as "expiresAt"
     from app.read_fulfillment_delivery_data_bound($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      input.fulfillmentId,
      input.actorUserId,
      input.creatorId,
      input.accessEventId,
      input.purpose,
      input.actorBinding.keyVersion,
      input.actorBinding.expiresAtMs,
      input.actorBinding.signature,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  const domain = string(row.encryptionDomain, 'encryption domain');
  if (domain !== 'address' && domain !== 'digital_secret')
    throw new Error('Invalid encryption domain.');
  if (
    !(row.ciphertext instanceof Uint8Array) ||
    !(row.encryptionIv instanceof Uint8Array) ||
    !(row.encryptionAuthTag instanceof Uint8Array) ||
    !(row.encryptionKeyIdentity instanceof Uint8Array)
  ) {
    throw new Error('Invalid encrypted fulfillment data.');
  }
  return {
    authenticationTag: Uint8Array.from(row.encryptionAuthTag),
    ciphertext: Uint8Array.from(row.ciphertext),
    domain,
    expiresAt: nullableDate(row.expiresAt, 'expiresAt'),
    fulfillmentId: string(row.fulfillmentId, 'fulfillmentId'),
    iv: Uint8Array.from(row.encryptionIv),
    keyIdentity: Buffer.from(row.encryptionKeyIdentity).toString('hex'),
    keyVersion: string(row.encryptionKeyVersion, 'key version'),
  };
};

export const recordProtectedDeliveryDataAccess = async (
  transaction: TransactionExecutor,
  input: ActorBoundInput & {
    readonly accessEventId: string;
    readonly actorUserId: string;
    readonly creatorId: string;
    readonly fulfillmentId: string;
    readonly purpose: string;
  },
): Promise<void> => {
  assertTransactionExecutor(transaction);
  await transaction.query(
    `select app.record_fulfillment_data_access_bound($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      input.fulfillmentId,
      input.actorUserId,
      input.creatorId,
      input.accessEventId,
      input.purpose,
      input.actorBinding.keyVersion,
      input.actorBinding.expiresAtMs,
      input.actorBinding.signature,
    ],
  );
};

export interface RestockRecord {
  readonly availableQuantity: string;
  readonly createdAt: string;
  readonly eventId: string;
  readonly initialQuantity: string;
  readonly poolId: string;
  readonly replayed: boolean;
}

export const restockInventory = async (
  transaction: TransactionExecutor,
  input: ActorBoundInput & {
    readonly actionKey: string;
    readonly actorUserId: string;
    readonly creatorId: string;
    readonly eventId: string;
    readonly fingerprint: Uint8Array;
    readonly poolId: string;
    readonly quantity: bigint;
  },
): Promise<RestockRecord> => {
  assertTransactionExecutor(transaction);
  const result = await transaction.query<{
    readonly availableQuantity: unknown;
    readonly eventCreatedAt: unknown;
    readonly eventId: unknown;
    readonly initialQuantity: unknown;
    readonly inventoryPoolId: unknown;
    readonly replayed: unknown;
  }>(
    `select inventory_pool_id as "inventoryPoolId", initial_quantity as "initialQuantity",
       available_quantity as "availableQuantity", event_id as "eventId",
       replayed, event_created_at as "eventCreatedAt"
     from app.restock_inventory_pool_bound($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      input.poolId,
      input.creatorId,
      input.actorUserId,
      input.eventId,
      input.quantity.toString(),
      input.actionKey,
      input.fingerprint,
      input.actorBinding.keyVersion,
      input.actorBinding.expiresAtMs,
      input.actorBinding.signature,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Restock returned no row.');
  return {
    availableQuantity: string(row.availableQuantity, 'available quantity'),
    createdAt: date(row.eventCreatedAt, 'restock createdAt'),
    eventId: string(row.eventId, 'restock event id'),
    initialQuantity: string(row.initialQuantity, 'initial quantity'),
    poolId: string(row.inventoryPoolId, 'pool id'),
    replayed: row.replayed === true,
  };
};
