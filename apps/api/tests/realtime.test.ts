import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { io, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  OpeningCompletedRealtimeEvent,
  RealtimeClientToServerEvents,
  RealtimePublishAcknowledgement,
  RealtimePublishCommand,
  RealtimeServerToClientEvents,
  RealtimeSubscriptionAcknowledgement,
  RealtimeWorkerToServerEvents,
} from '@creatordrop/contracts';
import type { Logger } from '@creatordrop/observability';

import type { AuthenticateAccessToken } from '../src/modules/auth/authentication.js';
import {
  createRealtimeServer,
  type RealtimeServerRuntime,
} from '../src/platform/realtime/realtime.server.js';

const workerToken = 'synthetic-realtime-worker-token-00000001';
const userA = '019d0000-0000-7000-8000-000000000001';
const userB = '019d0000-0000-7000-8000-000000000002';
const creatorA = '019d0000-0000-7000-8000-000000000003';
const creatorB = '019d0000-0000-7000-8000-000000000004';
const logger: Logger = { error: vi.fn(), info: vi.fn() };

type BrowserSocket = Socket<RealtimeServerToClientEvents, RealtimeClientToServerEvents>;
type WorkerSocket = Socket<Record<never, never>, RealtimeWorkerToServerEvents>;

const openingEvent = (): OpeningCompletedRealtimeEvent => ({
  data: {
    boxId: '019d0000-0000-7000-8000-000000000005',
    boxVersionId: '019d0000-0000-7000-8000-000000000006',
    creatorId: creatorA,
    openingId: '019d0000-0000-7000-8000-000000000007',
    rewardVersionId: '019d0000-0000-7000-8000-000000000008',
  },
  eventId: '019d0000-0000-7000-8000-000000000009',
  occurredAt: '2026-08-29T12:00:00.000Z',
  type: 'opening.completed.v1',
  version: 1,
});

const connect = async <ListenEvents extends object, EmitEvents extends object>(
  socket: Socket<ListenEvents, EmitEvents>,
): Promise<void> =>
  new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
    socket.connect();
  });

const connectFailure = async (socket: Socket): Promise<Error> =>
  new Promise((resolve) => {
    socket.once('connect_error', resolve);
    socket.connect();
  });

const publish = async (
  socket: WorkerSocket,
  command: RealtimePublishCommand,
): Promise<RealtimePublishAcknowledgement> =>
  new Promise((resolve) => {
    socket.emit('outbox.publish.v1', command, resolve);
  });

const subscribe = async (
  socket: BrowserSocket,
  subscription: unknown,
): Promise<RealtimeSubscriptionAcknowledgement> =>
  new Promise((resolve) => {
    socket.emit('drops.subscribe.v1', subscription, resolve);
  });

describe('Socket.io realtime gateway', () => {
  let baseUrl: string;
  let httpServer: HttpServer;
  let realtime: RealtimeServerRuntime;
  let sockets: Socket[];

  beforeEach(async () => {
    sockets = [];
    httpServer = createServer();
    const authenticateAccessToken: AuthenticateAccessToken = (token) => {
      const userId = token === 'token-a' ? userA : token === 'token-b' ? userB : undefined;
      if (userId === undefined) return Promise.reject(new Error('synthetic invalid access token'));
      return Promise.resolve({
        provider: 'synthetic',
        subject: token,
        user: { id: userId, status: 'active', username: `user_${userId}` },
      });
    };
    realtime = createRealtimeServer({
      allowedOrigins: ['http://localhost:5173'],
      authenticateAccessToken,
      createEventId: randomUUID,
      httpServer,
      logger,
      now: () => new Date('2026-08-29T12:00:00.000Z'),
      workerToken,
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(address.port)}`;
  });

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    await realtime.close();
  });

  const browser = (accessToken: string, extraAuthentication: object = {}): BrowserSocket => {
    const socket: BrowserSocket = io(baseUrl, {
      auth: { accessToken, ...extraAuthentication },
      autoConnect: false,
      transports: ['websocket'],
    });
    sockets.push(socket);
    return socket;
  };

  const worker = (token = workerToken): WorkerSocket => {
    const socket: WorkerSocket = io(`${baseUrl}/worker`, {
      auth: { workerToken: token },
      autoConnect: false,
      transports: ['websocket'],
    });
    sockets.push(socket);
    return socket;
  };

  it('authenticates users and workers and derives private user rooms server-side', async () => {
    await expect(connectFailure(browser('invalid'))).resolves.toMatchObject({
      message: 'AUTHENTICATION_REQUIRED',
    });
    await expect(connectFailure(browser('token-b', { userId: userA }))).resolves.toMatchObject({
      message: 'AUTHENTICATION_REQUIRED',
    });
    await expect(
      connectFailure(worker('wrong-synthetic-worker-token-00000000')),
    ).resolves.toMatchObject({ message: 'AUTHENTICATION_REQUIRED' });

    const first = browser('token-a');
    const second = browser('token-b');
    const publisher = worker();
    await Promise.all([connect(first), connect(second), connect(publisher)]);
    const firstDelivery = new Promise<OpeningCompletedRealtimeEvent>((resolve) => {
      first.once('opening.completed.v1', resolve);
    });
    const secondDelivery = vi.fn();
    second.on('opening.completed.v1', secondDelivery);
    const event = openingEvent();
    await expect(
      publish(publisher, { event, target: { kind: 'user', userId: userA } }),
    ).resolves.toEqual({ ok: true });
    await expect(firstDelivery).resolves.toEqual(event);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(secondDelivery).not.toHaveBeenCalled();
  });

  it('publishes sanitized public drops only to subscribed global/creator rooms', async () => {
    const creatorSubscriber = browser('token-a');
    const otherCreatorSubscriber = browser('token-b');
    const globalSubscriber = browser('token-b');
    const publisher = worker();
    await Promise.all([
      connect(creatorSubscriber),
      connect(otherCreatorSubscriber),
      connect(globalSubscriber),
      connect(publisher),
    ]);
    await expect(
      Promise.all([
        subscribe(creatorSubscriber, { creatorId: creatorA, scope: 'creator' }),
        subscribe(otherCreatorSubscriber, { creatorId: creatorB, scope: 'creator' }),
        subscribe(globalSubscriber, { scope: 'global' }),
      ]),
    ).resolves.toEqual([{ ok: true }, { ok: true }, { ok: true }]);

    const event = {
      data: {
        boxId: '019d0000-0000-7000-8000-000000000005',
        creatorId: creatorA,
        openingId: '019d0000-0000-7000-8000-000000000007',
        reward: {
          imageUrl: null,
          name: 'Synthetic Reward',
          rewardId: '019d0000-0000-7000-8000-000000000008',
        },
      },
      eventId: '019d0000-0000-7000-8000-000000000010',
      occurredAt: '2026-08-29T12:00:00.000Z',
      type: 'drop.created.v1',
      version: 1,
    } as const;
    const creatorDelivery = new Promise((resolve) =>
      creatorSubscriber.once('drop.created.v1', resolve),
    );
    const globalDelivery = new Promise((resolve) =>
      globalSubscriber.once('drop.created.v1', resolve),
    );
    const unrelatedDelivery = vi.fn();
    otherCreatorSubscriber.on('drop.created.v1', unrelatedDelivery);
    await expect(
      publish(publisher, { event, target: { creatorId: creatorA, kind: 'drop' } }),
    ).resolves.toEqual({ ok: true });
    await expect(Promise.all([creatorDelivery, globalDelivery])).resolves.toEqual([event, event]);
    expect(JSON.stringify(event)).not.toMatch(
      /serverSeed|ciphertext|wallet|ledger|earnings|userId/iu,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unrelatedDelivery).not.toHaveBeenCalled();
  });

  it('retains stable event IDs for at-least-once duplicates and requires refetch on reconnect', async () => {
    const client = browser('token-a');
    const publisher = worker();
    const readyEvents: unknown[] = [];
    client.on('realtime.ready.v1', (event) => readyEvents.push(event));
    await Promise.all([connect(client), connect(publisher)]);
    await vi.waitFor(() => expect(readyEvents).toHaveLength(1));
    const deliveries: OpeningCompletedRealtimeEvent[] = [];
    client.on('opening.completed.v1', (event) => deliveries.push(event));
    const event = openingEvent();
    const command: RealtimePublishCommand = {
      event,
      target: { kind: 'user', userId: userA },
    };
    await publish(publisher, command);
    await publish(publisher, command);
    await vi.waitFor(() => expect(deliveries).toHaveLength(2));
    expect(new Set(deliveries.map(({ eventId }) => eventId))).toEqual(new Set([event.eventId]));

    client.disconnect();
    await connect(client);
    await vi.waitFor(() => expect(readyEvents).toHaveLength(2));
    expect(readyEvents).toEqual([
      expect.objectContaining({ data: { delivery: 'at-least-once', refetchRequired: true } }),
      expect.objectContaining({ data: { delivery: 'at-least-once', refetchRequired: true } }),
    ]);
  });
});
