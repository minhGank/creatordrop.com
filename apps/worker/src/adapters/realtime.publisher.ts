import { io, type Socket } from 'socket.io-client';

import type {
  RealtimePublishAcknowledgement,
  RealtimePublishCommand,
  RealtimeWorkerToServerEvents,
} from '@creatordrop/contracts';

type EmptyServerEvents = Record<never, never>;

export interface RealtimePublisher {
  close(): void;
  publish(command: RealtimePublishCommand): Promise<void>;
}

export class RealtimePublicationError extends Error {
  readonly failureCode = 'REALTIME_UNAVAILABLE';

  constructor() {
    super('The realtime gateway did not acknowledge publication.');
    this.name = 'RealtimePublicationError';
  }
}

export interface SocketRealtimePublisherOptions {
  readonly publishTimeoutMs: number;
  readonly realtimeUrl: string;
  readonly workerToken: string;
}

const acknowledgementSucceeded = (value: unknown): value is RealtimePublishAcknowledgement => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return result.ok === true && Object.keys(result).length === 1;
};

export const createSocketRealtimePublisher = ({
  publishTimeoutMs,
  realtimeUrl,
  workerToken,
}: SocketRealtimePublisherOptions): RealtimePublisher => {
  const socket: Socket<EmptyServerEvents, RealtimeWorkerToServerEvents> = io(
    new URL('/worker', realtimeUrl).toString(),
    {
      auth: { workerToken },
      reconnection: true,
    },
  );

  return {
    close: () => socket.close(),
    publish: (command) =>
      new Promise<void>((resolve, reject) => {
        socket
          .timeout(publishTimeoutMs)
          .emit(
            'outbox.publish.v1',
            command,
            (error: Error | null, acknowledgement: RealtimePublishAcknowledgement) => {
              if (error !== null || !acknowledgementSucceeded(acknowledgement)) {
                reject(new RealtimePublicationError());
                return;
              }
              resolve();
            },
          );
      }),
  };
};
