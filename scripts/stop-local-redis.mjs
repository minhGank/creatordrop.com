import { stopLocalRedis } from './local-redis.mjs';

await stopLocalRedis();
process.stdout.write('Local Redis is stopped.\n');
