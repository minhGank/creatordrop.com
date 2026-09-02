import type { RedisCommandClient } from './client.js';

export interface RedisJsonCache {
  delete(key: string): Promise<void>;
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
}

const cacheKeyPattern = /^[A-Za-z0-9:{}._-]{1,512}$/u;

const requireKey = (key: string): string => {
  if (!cacheKeyPattern.test(key)) throw new Error('Invalid Redis cache key.');
  return key;
};

export const createRedisJsonCache = (client: RedisCommandClient): RedisJsonCache => ({
  delete: async (key) => {
    await client.sendCommand(['DEL', requireKey(key)]);
  },
  get: async (key) => {
    const result = await client.sendCommand(['GET', requireKey(key)]);
    if (result === null) return undefined;
    if (typeof result !== 'string') throw new Error('Redis returned a non-string cache value.');
    return JSON.parse(result) as unknown;
  },
  set: async (key, value, ttlSeconds) => {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86_400) {
      throw new Error('Invalid Redis cache TTL.');
    }
    await client.sendCommand([
      'SET',
      requireKey(key),
      JSON.stringify(value),
      'EX',
      ttlSeconds.toString(),
    ]);
  },
});

export const publicCatalogCacheKeys = {
  currentBox: (boxId: string): string => `creatordrop:{catalog}:v1:box:${boxId}:current`,
  version: (boxId: string, versionId: string): string =>
    `creatordrop:{catalog}:v1:box:${boxId}:version:${versionId}`,
};
