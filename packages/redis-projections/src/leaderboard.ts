import { randomUUID } from 'node:crypto';

import type { RedisCommandClient } from './client.js';

const maximumSignedBigint = 9_223_372_036_854_775_807n;
const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const decimalPattern = /^(?:0|[1-9][0-9]{0,18})$/u;
const generationPattern = /^g[0-9a-f]{32}$/u;
const namespace = 'creatordrop:{leaderboards}:v1';
const activeGenerationKey = `${namespace}:active-generation`;
const buildingGenerationKey = `${namespace}:building-generation`;

export interface LeaderboardScope {
  readonly creatorId: string | null;
  readonly periodType: 'all_time' | 'season';
  readonly scopeType: 'creator' | 'global';
  readonly seasonId: string | null;
}

export interface LeaderboardAggregate extends LeaderboardScope {
  readonly asOf: string;
  readonly baseRewardWins: string;
  readonly points: string;
  readonly scoreReachedAt: string;
  readonly scoreReachedAtMicros: string;
  readonly totalOpenings: string;
  readonly userId: string;
  readonly username: string;
}

export interface LeaderboardProjectionEvent {
  readonly boards: readonly LeaderboardAggregate[];
  readonly eventId: string;
  readonly openingId: string;
}

export interface LeaderboardRow {
  readonly baseRewardWins: string;
  readonly points: string;
  readonly rank: number;
  readonly scoreReachedAt: string;
  readonly totalOpenings: string;
  readonly userId: string;
  readonly username: string;
}

export interface LeaderboardReadResult {
  readonly asOf: string;
  readonly rows: readonly LeaderboardRow[];
}

export interface LeaderboardProjectionStore {
  abortRebuild(generation: string): Promise<void>;
  apply(event: LeaderboardProjectionEvent): Promise<'applied' | 'duplicate'>;
  beginRebuild(): Promise<string>;
  completeRebuild(generation: string): Promise<void>;
  deleteGeneration(generation: string): Promise<void>;
  listProjectedScopes(): Promise<readonly string[]>;
  markRebuildEvent(generation: string, eventId: string, openingId: string): Promise<void>;
  read(scope: LeaderboardScope, maximumRows?: number): Promise<LeaderboardReadResult | undefined>;
  writeRebuildAggregate(generation: string, aggregate: LeaderboardAggregate): Promise<void>;
}

const requireUuid = (value: string): string => {
  if (!canonicalUuidPattern.test(value)) throw new Error('Expected a canonical UUID.');
  return value;
};

const requireDecimal = (value: string): string => {
  if (!decimalPattern.test(value) || BigInt(value) > maximumSignedBigint) {
    throw new Error('Expected a non-negative signed-64 decimal string.');
  }
  return value;
};

const requireTimestamp = (value: string): string => {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new Error('Expected a canonical UTC timestamp.');
  }
  return value;
};

const requireUsername = (value: string): string => {
  let hasControlCharacter = false;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 31 || codeUnit === 127) {
      hasControlCharacter = true;
      break;
    }
  }
  if (value.length < 1 || value.length > 64 || hasControlCharacter) {
    throw new Error('Expected a valid public username.');
  }
  return value;
};

export const leaderboardScopeKey = (scope: LeaderboardScope): string => {
  let period: string;
  if (scope.periodType === 'all_time') {
    if (scope.seasonId !== null) throw new Error('All-time leaderboard cannot have a season.');
    period = 'all-time';
  } else {
    if (scope.seasonId === null) throw new Error('Season leaderboard requires a season.');
    period = `season:${requireUuid(scope.seasonId)}`;
  }
  if (scope.scopeType === 'global') {
    if (scope.creatorId !== null) throw new Error('Global leaderboard cannot have a creator.');
    return `global:${period}`;
  }
  if (scope.creatorId === null) throw new Error('Creator leaderboard requires a creator.');
  return `creator:${requireUuid(scope.creatorId)}:${period}`;
};

const rankMember = (aggregate: LeaderboardAggregate): string => {
  const inversePoints = (maximumSignedBigint - BigInt(requireDecimal(aggregate.points)))
    .toString()
    .padStart(19, '0');
  const reached = requireDecimal(aggregate.scoreReachedAtMicros).padStart(19, '0');
  return `${inversePoints}:${reached}:${requireUuid(aggregate.userId)}`;
};

const requireAggregate = (aggregate: LeaderboardAggregate) => ({
  ...aggregate,
  asOf: requireTimestamp(aggregate.asOf),
  baseRewardWins: requireDecimal(aggregate.baseRewardWins),
  points: requireDecimal(aggregate.points),
  rankMember: rankMember(aggregate),
  scoreReachedAt: requireTimestamp(aggregate.scoreReachedAt),
  scoreReachedAtMicros: requireDecimal(aggregate.scoreReachedAtMicros),
  scopeKey: leaderboardScopeKey(aggregate),
  totalOpenings: requireDecimal(aggregate.totalOpenings),
  userId: requireUuid(aggregate.userId),
  username: requireUsername(aggregate.username),
});

const applyScript = `
local payload = cjson.decode(ARGV[2])
local prefix = ARGV[1]
local active = redis.call('GET', KEYS[1])
if not active then
  active = 'g00000000000000000000000000000000'
  redis.call('SET', KEYS[1], active)
end
local generations = { active }
local building = redis.call('GET', KEYS[2])
if building and building ~= active then table.insert(generations, building) end
local applied = 0
local function greater_or_equal_decimal(left, right)
  if not right then return true end
  if string.len(left) ~= string.len(right) then return string.len(left) > string.len(right) end
  return left >= right
end
for _, generation in ipairs(generations) do
  local generationPrefix = prefix .. ':g:' .. generation
  local eventKey = generationPrefix .. ':processed:' .. payload.eventId
  if redis.call('EXISTS', eventKey) == 0 then
    for _, board in ipairs(payload.boards) do
      local boardPrefix = generationPrefix .. ':board:' .. board.scopeKey
      local userKey = boardPrefix .. ':user:' .. board.userId
      local previousOpenings = redis.call('HGET', userKey, 'totalOpenings')
      if greater_or_equal_decimal(board.totalOpenings, previousOpenings) then
        local previousMember = redis.call('HGET', userKey, 'rankMember')
        if previousMember then redis.call('ZREM', boardPrefix .. ':order', previousMember) end
        redis.call('HSET', userKey,
          'username', board.username, 'points', board.points,
          'totalOpenings', board.totalOpenings, 'baseRewardWins', board.baseRewardWins,
          'scoreReachedAt', board.scoreReachedAt,
          'scoreReachedAtMicros', board.scoreReachedAtMicros, 'rankMember', board.rankMember)
        redis.call('ZADD', boardPrefix .. ':order', 0, board.rankMember)
      end
      local metaKey = boardPrefix .. ':meta'
      local previousAsOf = redis.call('HGET', metaKey, 'asOfMicros')
      if greater_or_equal_decimal(board.asOfMicros, previousAsOf) then
        redis.call('HSET', metaKey, 'asOf', board.asOf, 'asOfMicros', board.asOfMicros)
      end
    end
    redis.call('SET', eventKey, payload.openingId)
    applied = applied + 1
  end
end
return applied
`;

const rebuildAggregateScript = `
local board = cjson.decode(ARGV[3])
local prefix = ARGV[1] .. ':g:' .. ARGV[2] .. ':board:' .. board.scopeKey
local userKey = prefix .. ':user:' .. board.userId
local previousOpenings = redis.call('HGET', userKey, 'totalOpenings')
local replace = false
if not previousOpenings then replace = true
elseif string.len(board.totalOpenings) > string.len(previousOpenings) then replace = true
elseif string.len(board.totalOpenings) == string.len(previousOpenings)
  and board.totalOpenings >= previousOpenings then replace = true end
if replace then
  local previousMember = redis.call('HGET', userKey, 'rankMember')
  if previousMember then redis.call('ZREM', prefix .. ':order', previousMember) end
  redis.call('HSET', userKey,
    'username', board.username, 'points', board.points,
    'totalOpenings', board.totalOpenings, 'baseRewardWins', board.baseRewardWins,
    'scoreReachedAt', board.scoreReachedAt,
    'scoreReachedAtMicros', board.scoreReachedAtMicros, 'rankMember', board.rankMember)
  redis.call('ZADD', prefix .. ':order', 0, board.rankMember)
end
local metaKey = prefix .. ':meta'
local previousAsOf = redis.call('HGET', metaKey, 'asOfMicros')
if not previousAsOf or string.len(board.asOfMicros) > string.len(previousAsOf)
  or (string.len(board.asOfMicros) == string.len(previousAsOf)
      and board.asOfMicros >= previousAsOf) then
  redis.call('HSET', metaKey, 'asOf', board.asOf, 'asOfMicros', board.asOfMicros)
end
return 1
`;

const beginRebuildScript = `
if redis.call('EXISTS', KEYS[1]) == 1 then return redis.error_reply('REBUILD_IN_PROGRESS') end
redis.call('SET', KEYS[1], ARGV[1])
return 1
`;

const completeRebuildScript = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return redis.error_reply('REBUILD_NOT_OWNED') end
redis.call('SET', ARGV[2] .. ':g:' .. ARGV[1] .. ':ready', '1')
local previous = redis.call('GET', KEYS[1])
redis.call('SET', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[2])
return previous or ''
`;

const abortRebuildScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) return 1 end
return 0
`;

const asArray = (value: unknown): readonly unknown[] => {
  if (!Array.isArray(value)) throw new Error('Redis returned an unexpected array reply.');
  return value;
};
const asString = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('Redis returned an unexpected string reply.');
  return value;
};
const hashReply = (value: unknown): Readonly<Record<string, string>> => {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(value)) result[key] = asString(item);
    return result;
  }
  const entries = asArray(value);
  if (entries.length % 2 !== 0) throw new Error('Redis returned an invalid hash reply.');
  const result: Record<string, string> = {};
  for (let index = 0; index < entries.length; index += 2) {
    result[asString(entries[index])] = asString(entries[index + 1]);
  }
  return result;
};

const scanKeys = async (
  client: RedisCommandClient,
  pattern: string,
): Promise<readonly string[]> => {
  let cursor = '0';
  const keys: string[] = [];
  do {
    const reply = asArray(
      await client.sendCommand(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '250']),
    );
    cursor = asString(reply[0]);
    for (const key of asArray(reply[1])) keys.push(asString(key));
  } while (cursor !== '0');
  return keys.sort();
};

const generationPrefix = (generation: string): string => {
  if (!generationPattern.test(generation)) throw new Error('Invalid leaderboard generation.');
  return `${namespace}:g:${generation}`;
};

const asOfMicros = (value: string): string =>
  Math.trunc(new Date(requireTimestamp(value)).getTime() * 1000).toString();

export const createLeaderboardProjectionStore = (
  client: RedisCommandClient,
): LeaderboardProjectionStore => {
  const deleteGeneration = async (generation: string): Promise<void> => {
    const prefix = generationPrefix(generation);
    const keys = await scanKeys(client, `${prefix}:*`);
    for (let index = 0; index < keys.length; index += 100) {
      const batch = keys.slice(index, index + 100);
      if (batch.length > 0) await client.sendCommand(['DEL', ...batch]);
    }
  };
  return {
    abortRebuild: async (generation) => {
      generationPrefix(generation);
      await client.sendCommand([
        'EVAL',
        abortRebuildScript,
        '1',
        buildingGenerationKey,
        generation,
      ]);
      await deleteGeneration(generation);
    },
    apply: async (event) => {
      requireUuid(event.eventId);
      requireUuid(event.openingId);
      const payload = {
        boards: event.boards.map((board) => {
          const validated = requireAggregate(board);
          return { ...validated, asOfMicros: asOfMicros(validated.asOf) };
        }),
        eventId: event.eventId,
        openingId: event.openingId,
      };
      const reply = await client.sendCommand([
        'EVAL',
        applyScript,
        '2',
        activeGenerationKey,
        buildingGenerationKey,
        namespace,
        JSON.stringify(payload),
      ]);
      return typeof reply === 'number' && reply > 0 ? 'applied' : 'duplicate';
    },
    beginRebuild: async () => {
      const generation = `g${randomUUID().replaceAll('-', '')}`;
      await client.sendCommand([
        'EVAL',
        beginRebuildScript,
        '1',
        buildingGenerationKey,
        generation,
      ]);
      return generation;
    },
    completeRebuild: async (generation) => {
      generationPrefix(generation);
      const previous = await client.sendCommand([
        'EVAL',
        completeRebuildScript,
        '2',
        activeGenerationKey,
        buildingGenerationKey,
        generation,
        namespace,
      ]);
      if (typeof previous === 'string' && previous !== '' && previous !== generation) {
        await deleteGeneration(previous);
      }
    },
    deleteGeneration,
    listProjectedScopes: async () => {
      const active = await client.sendCommand(['GET', activeGenerationKey]);
      if (typeof active !== 'string') return [];
      const prefix = generationPrefix(active);
      const keys = await scanKeys(client, `${prefix}:board:*:order`);
      return keys.map((key) => key.slice(`${prefix}:board:`.length, -':order'.length));
    },
    markRebuildEvent: async (generation, eventId, openingId) => {
      await client.sendCommand([
        'SET',
        `${generationPrefix(generation)}:processed:${requireUuid(eventId)}`,
        requireUuid(openingId),
      ]);
    },
    read: async (scope, maximumRows = 100) => {
      if (!Number.isSafeInteger(maximumRows) || maximumRows < 1) {
        throw new Error('Invalid leaderboard read limit.');
      }
      const active = await client.sendCommand(['GET', activeGenerationKey]);
      if (typeof active !== 'string') return undefined;
      const prefix = generationPrefix(active);
      if ((await client.sendCommand(['GET', `${prefix}:ready`])) !== '1') return undefined;
      const boardPrefix = `${prefix}:board:${leaderboardScopeKey(scope)}`;
      const members = asArray(
        await client.sendCommand([
          'ZRANGE',
          `${boardPrefix}:order`,
          '0',
          (maximumRows - 1).toString(),
        ]),
      ).map(asString);
      const rows: LeaderboardRow[] = [];
      for (const [index, member] of members.entries()) {
        const userId = member.slice(-36);
        requireUuid(userId);
        const values = hashReply(
          await client.sendCommand(['HGETALL', `${boardPrefix}:user:${userId}`]),
        );
        rows.push({
          baseRewardWins: requireDecimal(values.baseRewardWins ?? ''),
          points: requireDecimal(values.points ?? ''),
          rank: index + 1,
          scoreReachedAt: requireTimestamp(values.scoreReachedAt ?? ''),
          totalOpenings: requireDecimal(values.totalOpenings ?? ''),
          userId,
          username: requireUsername(values.username ?? ''),
        });
      }
      const meta = hashReply(await client.sendCommand(['HGETALL', `${boardPrefix}:meta`]));
      return {
        asOf: meta.asOf === undefined ? new Date(0).toISOString() : requireTimestamp(meta.asOf),
        rows,
      };
    },
    writeRebuildAggregate: async (generation, aggregate) => {
      generationPrefix(generation);
      const validated = requireAggregate(aggregate);
      await client.sendCommand([
        'EVAL',
        rebuildAggregateScript,
        '0',
        namespace,
        generation,
        JSON.stringify({ ...validated, asOfMicros: asOfMicros(validated.asOf) }),
      ]);
    },
  };
};
