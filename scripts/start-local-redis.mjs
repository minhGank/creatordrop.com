import { ensureLocalRedis, localRedisUrl } from './local-redis.mjs';

await ensureLocalRedis();
process.stdout.write(`Local Redis is ready at ${localRedisUrl}.\n`);
