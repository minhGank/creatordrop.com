import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';

import { Server } from 'socket.io';

import {
  parseRealtimeDropSubscription,
  parseRealtimePublishCommand,
  RealtimeContractError,
  type RealtimeClientToServerEvents,
  type RealtimePublishAcknowledgement,
  type RealtimeServerToClientEvents,
  type RealtimeSubscriptionAcknowledgement,
  type RealtimeWorkerToServerEvents,
} from '@creatordrop/contracts';
import type { Logger } from '@creatordrop/observability';

import type { AuthenticateAccessToken } from '../../modules/auth/authentication.js';

type AllInboundEvents = RealtimeClientToServerEvents & RealtimeWorkerToServerEvents;
type EmptyServerEvents = Record<never, never>;
interface RealtimeSocketData {
  userId?: string;
}

export interface RealtimeServerOptions {
  readonly allowedOrigins: readonly string[];
  readonly authenticateAccessToken: AuthenticateAccessToken;
  readonly createEventId?: () => string;
  readonly httpServer: HttpServer;
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly workerToken: string;
}

export interface RealtimeServerRuntime {
  close(): Promise<void>;
}

export const globalDropRoom = 'drops:global';
export const creatorDropRoom = (creatorId: string): string => `creator:${creatorId}`;
export const userRoom = (userId: string): string => `user:${userId}`;

const strictAuthenticationValue = (
  value: unknown,
  key: 'accessToken' | 'workerToken',
  maximumLength: number,
): string | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const authentication = value as Record<string, unknown>;
  if (Object.keys(authentication).length !== 1) return undefined;
  const token = authentication[key];
  return typeof token === 'string' && token.length >= 1 && token.length <= maximumLength
    ? token
    : undefined;
};

const tokensEqual = (actual: string, expected: string): boolean => {
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
};

const invalidSubscription: RealtimeSubscriptionAcknowledgement = {
  code: 'INVALID_SUBSCRIPTION',
  ok: false,
};
const invalidEvent: RealtimePublishAcknowledgement = { code: 'INVALID_EVENT', ok: false };

export const createRealtimeServer = ({
  allowedOrigins,
  authenticateAccessToken,
  createEventId = randomUUID,
  httpServer,
  logger,
  now = () => new Date(),
  workerToken,
}: RealtimeServerOptions): RealtimeServerRuntime => {
  const io = new Server<
    AllInboundEvents,
    RealtimeServerToClientEvents,
    EmptyServerEvents,
    RealtimeSocketData
  >(httpServer, {
    cors: { methods: ['GET', 'POST'], origin: [...allowedOrigins] },
    serveClient: false,
  });

  io.use((socket, next) => {
    const accessToken = strictAuthenticationValue(socket.handshake.auth, 'accessToken', 8_192);
    if (accessToken === undefined) {
      next(new Error('AUTHENTICATION_REQUIRED'));
      return;
    }
    void authenticateAccessToken(accessToken)
      .then((actor) => {
        socket.data.userId = actor.user.id;
        next();
      })
      .catch(() => next(new Error('AUTHENTICATION_REQUIRED')));
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId;
    if (userId === undefined) {
      socket.disconnect(true);
      return;
    }
    void socket.join(userRoom(userId));
    const occurredAt = now().toISOString();
    socket.emit('realtime.ready.v1', {
      data: { delivery: 'at-least-once', refetchRequired: true },
      eventId: createEventId(),
      occurredAt,
      type: 'realtime.ready.v1',
      version: 1,
    });

    const changeSubscription = (
      operation: 'join' | 'leave',
      input: unknown,
      acknowledge: (result: RealtimeSubscriptionAcknowledgement) => void,
    ): void => {
      try {
        const subscription = parseRealtimeDropSubscription(input);
        const room =
          subscription.scope === 'global'
            ? globalDropRoom
            : creatorDropRoom(subscription.creatorId);
        void Promise.resolve(socket[operation](room)).then(
          () => acknowledge({ ok: true }),
          () => {
            logger.error('realtime.subscription.failed', { errorName: 'RoomOperationError' });
            acknowledge(invalidSubscription);
          },
        );
      } catch (error) {
        if (!(error instanceof RealtimeContractError)) {
          logger.error('realtime.subscription.failed', { errorName: 'UnexpectedError' });
        }
        acknowledge(invalidSubscription);
      }
    };

    socket.on('drops.subscribe.v1', (input, acknowledge) => {
      if (typeof acknowledge !== 'function') return;
      changeSubscription('join', input, acknowledge);
    });
    socket.on('drops.unsubscribe.v1', (input, acknowledge) => {
      if (typeof acknowledge !== 'function') return;
      changeSubscription('leave', input, acknowledge);
    });
  });

  const workerNamespace = io.of('/worker');
  workerNamespace.use((socket, next) => {
    const suppliedToken = strictAuthenticationValue(socket.handshake.auth, 'workerToken', 512);
    if (suppliedToken === undefined || !tokensEqual(suppliedToken, workerToken)) {
      next(new Error('AUTHENTICATION_REQUIRED'));
      return;
    }
    next();
  });
  workerNamespace.on('connection', (socket) => {
    socket.on('outbox.publish.v1', (input, acknowledge) => {
      if (typeof acknowledge !== 'function') return;
      try {
        const command = parseRealtimePublishCommand(input);
        if (command.target.kind === 'user' && command.event.type === 'opening.completed.v1') {
          io.to(userRoom(command.target.userId)).emit(command.event.type, command.event);
        } else if (command.target.kind === 'drop' && command.event.type === 'drop.created.v1') {
          io.to(globalDropRoom)
            .to(creatorDropRoom(command.target.creatorId))
            .emit(command.event.type, command.event);
        } else {
          throw new RealtimeContractError();
        }
        acknowledge({ ok: true });
      } catch (error) {
        if (!(error instanceof RealtimeContractError)) {
          logger.error('realtime.publish.failed', { errorName: 'UnexpectedError' });
          acknowledge({ code: 'PUBLISH_FAILED', ok: false });
          return;
        }
        acknowledge(invalidEvent);
      }
    });
  });

  return {
    close: async () => {
      await io.close();
    },
  };
};
