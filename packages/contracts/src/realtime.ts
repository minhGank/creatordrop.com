export const realtimeOpeningEventType = 'opening.completed.v1' as const;
export const realtimeDropEventType = 'drop.created.v1' as const;
export const realtimeReadyEventType = 'realtime.ready.v1' as const;

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class RealtimeContractError extends Error {
  constructor() {
    super('The realtime message does not match its versioned contract.');
    this.name = 'RealtimeContractError';
  }
}

const contractError = (): never => {
  throw new RealtimeContractError();
};

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return contractError();
  return value as Record<string, unknown>;
};

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): void => {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  if (
    actual.length !== canonicalExpected.length ||
    actual.some((key, index) => key !== canonicalExpected[index])
  ) {
    contractError();
  }
};

const stringValue = (value: unknown, maximumLength: number): string => {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximumLength) {
    return contractError();
  }
  return value;
};

const uuidValue = (value: unknown): string => {
  const parsed = stringValue(value, 36);
  return canonicalUuidPattern.test(parsed) ? parsed : contractError();
};

const timestampValue = (value: unknown): string => {
  const parsed = stringValue(value, 24);
  const date = new Date(parsed);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === parsed ? parsed : contractError();
};

const imageUrlValue = (value: unknown): string | null => {
  if (value === null) return null;
  const parsed = stringValue(value, 2_048);
  let url: URL;
  try {
    url = new URL(parsed);
  } catch {
    return contractError();
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? parsed : contractError();
};

export interface OpeningCompletedRealtimeEvent {
  readonly data: {
    readonly boxId: string;
    readonly boxVersionId: string;
    readonly creatorId: string;
    readonly openingId: string;
    readonly rewardVersionId: string;
  };
  readonly eventId: string;
  readonly occurredAt: string;
  readonly type: typeof realtimeOpeningEventType;
  readonly version: 1;
}

export interface DropCreatedRealtimeEvent {
  readonly data: {
    readonly boxId: string;
    readonly creatorId: string;
    readonly openingId: string;
    readonly reward: {
      readonly imageUrl: string | null;
      readonly name: string;
      readonly rewardId: string;
    };
  };
  readonly eventId: string;
  readonly occurredAt: string;
  readonly type: typeof realtimeDropEventType;
  readonly version: 1;
}

export interface RealtimeReadyEvent {
  readonly data: {
    readonly delivery: 'at-least-once';
    readonly refetchRequired: true;
  };
  readonly eventId: string;
  readonly occurredAt: string;
  readonly type: typeof realtimeReadyEventType;
  readonly version: 1;
}

export type DurableRealtimeEvent = OpeningCompletedRealtimeEvent | DropCreatedRealtimeEvent;

export type RealtimePublishCommand =
  | Readonly<{
      event: OpeningCompletedRealtimeEvent;
      target: Readonly<{ kind: 'user'; userId: string }>;
    }>
  | Readonly<{
      event: DropCreatedRealtimeEvent;
      target: Readonly<{ creatorId: string; kind: 'drop' }>;
    }>;

export type RealtimePublishAcknowledgement =
  Readonly<{ ok: true }> | Readonly<{ code: 'INVALID_EVENT' | 'PUBLISH_FAILED'; ok: false }>;

export type RealtimeSubscriptionAcknowledgement =
  Readonly<{ ok: true }> | Readonly<{ code: 'INVALID_SUBSCRIPTION'; ok: false }>;

export type RealtimeDropSubscription =
  Readonly<{ scope: 'global' }> | Readonly<{ creatorId: string; scope: 'creator' }>;

export interface RealtimeServerToClientEvents {
  'drop.created.v1': (event: DropCreatedRealtimeEvent) => void;
  'opening.completed.v1': (event: OpeningCompletedRealtimeEvent) => void;
  'realtime.ready.v1': (event: RealtimeReadyEvent) => void;
}

export interface RealtimeClientToServerEvents {
  'drops.subscribe.v1': (
    subscription: unknown,
    acknowledge: (result: RealtimeSubscriptionAcknowledgement) => void,
  ) => void;
  'drops.unsubscribe.v1': (
    subscription: unknown,
    acknowledge: (result: RealtimeSubscriptionAcknowledgement) => void,
  ) => void;
}

export interface RealtimeWorkerToServerEvents {
  'outbox.publish.v1': (
    command: unknown,
    acknowledge: (result: RealtimePublishAcknowledgement) => void,
  ) => void;
}

const parseOpeningEvent = (value: unknown): OpeningCompletedRealtimeEvent => {
  const event = record(value);
  exactKeys(event, ['data', 'eventId', 'occurredAt', 'type', 'version']);
  if (event.type !== realtimeOpeningEventType || event.version !== 1) return contractError();
  const data = record(event.data);
  exactKeys(data, ['boxId', 'boxVersionId', 'creatorId', 'openingId', 'rewardVersionId']);
  return {
    data: {
      boxId: uuidValue(data.boxId),
      boxVersionId: uuidValue(data.boxVersionId),
      creatorId: uuidValue(data.creatorId),
      openingId: uuidValue(data.openingId),
      rewardVersionId: uuidValue(data.rewardVersionId),
    },
    eventId: uuidValue(event.eventId),
    occurredAt: timestampValue(event.occurredAt),
    type: realtimeOpeningEventType,
    version: 1,
  };
};

const parseDropEvent = (value: unknown): DropCreatedRealtimeEvent => {
  const event = record(value);
  exactKeys(event, ['data', 'eventId', 'occurredAt', 'type', 'version']);
  if (event.type !== realtimeDropEventType || event.version !== 1) return contractError();
  const data = record(event.data);
  exactKeys(data, ['boxId', 'creatorId', 'openingId', 'reward']);
  const reward = record(data.reward);
  exactKeys(reward, ['imageUrl', 'name', 'rewardId']);
  return {
    data: {
      boxId: uuidValue(data.boxId),
      creatorId: uuidValue(data.creatorId),
      openingId: uuidValue(data.openingId),
      reward: {
        imageUrl: imageUrlValue(reward.imageUrl),
        name: stringValue(reward.name, 120),
        rewardId: uuidValue(reward.rewardId),
      },
    },
    eventId: uuidValue(event.eventId),
    occurredAt: timestampValue(event.occurredAt),
    type: realtimeDropEventType,
    version: 1,
  };
};

export const parseRealtimePublishCommand = (value: unknown): RealtimePublishCommand => {
  const command = record(value);
  exactKeys(command, ['event', 'target']);
  const eventRecord = record(command.event);
  const target = record(command.target);
  if (eventRecord.type === realtimeOpeningEventType) {
    exactKeys(target, ['kind', 'userId']);
    if (target.kind !== 'user') return contractError();
    return {
      event: parseOpeningEvent(eventRecord),
      target: { kind: 'user', userId: uuidValue(target.userId) },
    };
  }
  if (eventRecord.type === realtimeDropEventType) {
    exactKeys(target, ['creatorId', 'kind']);
    if (target.kind !== 'drop') return contractError();
    const event = parseDropEvent(eventRecord);
    const creatorId = uuidValue(target.creatorId);
    if (event.data.creatorId !== creatorId) return contractError();
    return { event, target: { creatorId, kind: 'drop' } };
  }
  return contractError();
};

export const parseRealtimeDropSubscription = (value: unknown): RealtimeDropSubscription => {
  const subscription = record(value);
  if (subscription.scope === 'global') {
    exactKeys(subscription, ['scope']);
    return { scope: 'global' };
  }
  if (subscription.scope === 'creator') {
    exactKeys(subscription, ['creatorId', 'scope']);
    return { creatorId: uuidValue(subscription.creatorId), scope: 'creator' };
  }
  return contractError();
};
