import { randomUUID } from 'node:crypto';

import { parseMigrationEnvironment } from '@creatordrop/config';
import { createDatabasePool } from '@creatordrop/database';

import { assertLocalSupabaseMigrationTarget } from './local-supabase-migration-target.mjs';

const [userId, creatorId, boxId, quantity, sourceType, sourceIdentity, reason] =
  process.argv.slice(2);

const fail = (message) => {
  throw new Error(message);
};

if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') {
  fail('Opening entitlement grants require explicit NODE_ENV=development or test.');
}

const environment = parseMigrationEnvironment(process.env);
assertLocalSupabaseMigrationTarget(environment.connectionString);
if (
  userId === undefined ||
  creatorId === undefined ||
  boxId === undefined ||
  quantity === undefined ||
  sourceType === undefined ||
  sourceIdentity === undefined ||
  reason === undefined
) {
  fail(
    'Usage: npm run grant:entitlement:dev -- <userId> <creatorId> <boxId> <quantity> <sourceType> <sourceIdentity> <reason>',
  );
}

const database = createDatabasePool({
  applicationName: 'creatordrop-development-entitlement-grant',
  connectionString: environment.connectionString,
  connectionTimeoutMs: 5_000,
  idleTimeoutMs: 5_000,
  maxConnections: 1,
  onUnexpectedPoolError: (error) => process.stderr.write(`Database error: ${error.name}\n`),
});

try {
  const grant = await database.query(
    `select id::text, replayed
       from app_private.grant_opening_entitlement($1, $2, $3, $4, $5, $6, $7, null, $8)`,
    [randomUUID(), userId, creatorId, boxId, quantity, sourceType, sourceIdentity, reason],
  );
  const state = await database.query(
    `select box_id::text as "boxId", granted::text, consumed::text, remaining::text
       from app_private.read_opening_entitlement_state($1, $2)`,
    [userId, boxId],
  );
  process.stdout.write(`${JSON.stringify({ grant: grant.rows[0], state: state.rows[0] })}\n`);
} finally {
  await database.close();
}
