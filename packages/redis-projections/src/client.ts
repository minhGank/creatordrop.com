import { createClient } from 'redis';

export interface RedisCommandClient {
  readonly isReady: boolean;
  connect(): Promise<void>;
  close(): Promise<void>;
  sendCommand(arguments_: readonly string[]): Promise<unknown>;
}

export interface RedisConnectionOptions {
  readonly connectTimeoutMs?: number;
  readonly onError: (error: Error) => void;
  readonly url: string;
}

export const createRedisConnection = ({
  connectTimeoutMs = 1_000,
  onError,
  url,
}: RedisConnectionOptions): RedisCommandClient => {
  const client = createClient({
    socket: {
      connectTimeout: connectTimeoutMs,
      reconnectStrategy: false,
    },
    url,
  });
  client.on('error', onError);
  let connection: Promise<void> | undefined;
  const connect = async (): Promise<void> => {
    if (client.isReady) return;
    if (connection === undefined) {
      if (client.isOpen) client.destroy();
      connection = client
        .connect()
        .then(() => undefined)
        .finally(() => {
          connection = undefined;
        });
    }
    await connection;
  };
  return {
    close: async () => {
      if (client.isOpen) await client.close();
    },
    connect,
    get isReady() {
      return client.isReady;
    },
    sendCommand: async (arguments_) => {
      await connect();
      return client.sendCommand([...arguments_]);
    },
  };
};
