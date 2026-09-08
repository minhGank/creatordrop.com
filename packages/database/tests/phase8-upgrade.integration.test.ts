import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { afterAll, describe, expect, it } from 'vitest';

import { parseDatabaseEnvironment, parseMigrationEnvironment } from '@creatordrop/config';

import { createDatabasePool, type Database } from '../src/index.js';

const localMigrationUrl = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const migrationEnvironment = parseMigrationEnvironment({
  DATABASE_MIGRATION_URL: process.env.DATABASE_MIGRATION_URL ?? localMigrationUrl,
});
const phase8Migrations = [
  '20260819000000_foundation.sql',
  '20260820000000_users.sql',
  '20260820180000_creator_tenancy.sql',
  '20260821132759_catalog.sql',
  '20260822150000_rng_seed_lifecycle.sql',
  '20260823093143_phase7_rng_lifecycle_hardening.sql',
  '20260823192330_phase7_rng_key_identity_semantics.sql',
  '20260823220000_phase7_rng_key_registry.sql',
  '20260823230000_phase7_rng_lifecycle_user_lock.sql',
  '20260824154215_phase8_wallet_ledger_idempotency.sql',
] as const;
const phase9And10Migrations = [
  '20260824180000_phase9_atomic_box_opening.sql',
  '20260826134113_phase9_opening_high_remediation.sql',
  '20260830024628_phase10_outbox_realtime_delivery.sql',
] as const;
const phase11Migrations = [
  '20260830120000_phase11_stripe_wallet_funding.sql',
  '20260831120000_phase11_financial_integrity_remediation.sql',
] as const;
const phase12Migrations = [
  '20260831170000_phase12_fulfillment.sql',
  '20260901090000_phase12_security_remediation.sql',
  '20260901130000_phase12_actor_binding_key_lifecycle.sql',
] as const;
const phase13Migrations = [
  '20260901180000_phase13_leaderboards.sql',
  '20260902120000_phase13_high_remediation.sql',
] as const;
const phase15Migrations = [
  '20260905065856_phase15_rarity_and_fairness_proof.sql',
  '20260906194037_phase15_fairness_confirmation_binding.sql',
  '20260907185800_r1a_opening_v2_entitlements.sql',
  '20260907225003_r1b_opening_v2_consumption.sql',
] as const;

const migrationSql = (fileName: string): Promise<string> =>
  readFile(new URL(`../../../infra/supabase/migrations/${fileName}`, import.meta.url), 'utf8');

const databaseUrl = (databaseName: string): string => {
  const url = new URL(migrationEnvironment.connectionString);
  url.pathname = `/${databaseName}`;
  url.searchParams.delete('options');
  return url.toString();
};

const createPool = (connectionString: string, applicationName: string): Database =>
  createDatabasePool({
    ...parseDatabaseEnvironment({
      DATABASE_APPLICATION_NAME: applicationName,
      DATABASE_CONNECTION_TIMEOUT_MS: '5000',
      DATABASE_IDLE_TIMEOUT_MS: '1000',
      DATABASE_POOL_MAX: '2',
      DATABASE_URL: connectionString,
    }),
    onUnexpectedPoolError: (error) => {
      throw error;
    },
  });

describe('Phase 8 to current forward migration', { concurrent: false }, () => {
  const admin = createPool(migrationEnvironment.connectionString, 'phase8-phase9-upgrade-admin');
  const databasesToDrop = new Set<string>();

  afterAll(async () => {
    for (const name of databasesToDrop) {
      await admin.query(`drop database "${name}" with (force)`);
    }
    await admin.close();
  });

  it('grandfathers published versions without rewriting or inferring a base reward', async () => {
    const name = `creatordrop_phase8_upgrade_${randomUUID().replaceAll('-', '')}`;
    if (!/^[a-z0-9_]+$/u.test(name)) throw new Error('Generated an unsafe database name.');
    await admin.query(`create database "${name}"`);
    databasesToDrop.add(name);
    const database = createPool(databaseUrl(name), name);
    try {
      for (const fileName of phase8Migrations) await database.query(await migrationSql(fileName));

      const identifiers = {
        box: randomUUID(),
        creator: randomUUID(),
        entry: randomUUID(),
        fundingAccount: randomUUID(),
        fundingEntry: randomUUID(),
        idempotency: randomUUID(),
        ledgerTransaction: randomUUID(),
        opening: randomUUID(),
        openingPublic: randomUUID(),
        reward: randomUUID(),
        rewardVersion: randomUUID(),
        rewardWin: randomUUID(),
        seedSet: randomUUID(),
        user: randomUUID(),
        version: randomUUID(),
        wallet: randomUUID(),
        walletAccount: randomUUID(),
        walletEntry: randomUUID(),
        fulfillment: randomUUID(),
      };
      await database.query(
        `insert into app.users (id, auth_provider, auth_subject, username)
         values ($1, 'synthetic-phase8-upgrade', $1::uuid::text, $2)`,
        [identifiers.user, `p8_${identifiers.user.replaceAll('-', '')}`],
      );
      await database.transaction(async (transaction) => {
        await transaction.query(
          `insert into app.creators (id, handle, custom_slug, display_name)
           values ($1, $2, $3, 'Legacy Creator')`,
          [
            identifiers.creator,
            `p8_${identifiers.creator.replaceAll('-', '').slice(0, 12)}`,
            `p8-${identifiers.creator.replaceAll('-', '').slice(0, 12)}`,
          ],
        );
        await transaction.query(
          `insert into app.creator_memberships (creator_id, user_id, role)
           values ($1, $2, 'owner')`,
          [identifiers.creator, identifiers.user],
        );
      });
      await database.query(`insert into app.boxes (id, creator_id) values ($1, $2)`, [
        identifiers.box,
        identifiers.creator,
      ]);
      await database.query(`insert into app.rewards (id, creator_id) values ($1, $2)`, [
        identifiers.reward,
        identifiers.creator,
      ]);
      await database.query(
        `insert into app.reward_versions (
           id, reward_id, version_number, name, description, reward_type,
           inventory_mode, inventory_quantity, created_by_user_id
         ) values ($1, $2, 1, 'Legacy reward', '', 'digital', 'finite', 5, $3)`,
        [identifiers.rewardVersion, identifiers.reward, identifiers.user],
      );
      await database.query(
        `insert into app.box_versions (
           id, box_id, version_number, name, description, price_minor, currency,
           created_by_user_id
         ) values ($1, $2, 1, 'Legacy box', '', 1000, 'USD', $3)`,
        [identifiers.version, identifiers.box, identifiers.user],
      );
      await database.query(
        `insert into app.box_version_rewards (
           id, box_version_id, reward_version_id, position, weight
         ) values ($1, $2, $3, 0, 1)`,
        [identifiers.entry, identifiers.version, identifiers.rewardVersion],
      );
      await database.query(
        `update app.reward_versions
            set state = 'published', published_at = statement_timestamp()
          where id = $1`,
        [identifiers.rewardVersion],
      );
      await database.query(
        `update app.box_versions
            set state = 'published', total_weight = 1,
                configuration_hash = decode(repeat('ab', 32), 'hex'),
                rng_algorithm_version = 'hmac-sha256-rejection-v1',
                published_at = statement_timestamp()
          where id = $1`,
        [identifiers.version],
      );
      await database.query(
        `update app.boxes
            set current_published_version_id = $2, status = 'active'
          where id = $1`,
        [identifiers.box, identifiers.version],
      );
      await database.transaction(async (transaction) => {
        await transaction.query(
          `insert into app.idempotency_records (
             id, actor_user_id, operation, idempotency_key, request_fingerprint
           ) values ($1, $2, 'wallet.test_credit', 'phase8-upgrade-credit',
                     decode(repeat('12', 32), 'hex'))`,
          [identifiers.idempotency, identifiers.user],
        );
        await transaction.query(
          `insert into app.ledger_accounts (id, account_type, owner_user_id, currency)
           values ($1, 'user_wallet', $3, 'USD'),
                  ($2, 'system_test_funding', null, 'USD')`,
          [identifiers.walletAccount, identifiers.fundingAccount, identifiers.user],
        );
        await transaction.query(
          `insert into app.wallets (id, user_id, currency, ledger_account_id)
           values ($1, $2, 'USD', $3)`,
          [identifiers.wallet, identifiers.user, identifiers.walletAccount],
        );
        await transaction.query(
          `insert into app.ledger_transactions (
             id, kind, actor_user_id, currency, business_reference_type,
             business_reference_id, idempotency_record_id, description
           ) values (
             $1, 'test_credit_grant', $2, 'USD', 'test_credit_grant', $3, $3,
             'Phase 8 upgrade fixture'
           )`,
          [identifiers.ledgerTransaction, identifiers.user, identifiers.idempotency],
        );
        await transaction.query(
          `insert into app.ledger_entries (
             id, ledger_transaction_id, ledger_account_id, amount_minor, currency, sequence
           ) values
             ($1, $3, $4, 500, 'USD', 0),
             ($2, $3, $5, -500, 'USD', 1)`,
          [
            identifiers.walletEntry,
            identifiers.fundingEntry,
            identifiers.ledgerTransaction,
            identifiers.walletAccount,
            identifiers.fundingAccount,
          ],
        );
        await transaction.query(`select app.apply_wallet_balance($1, 500)`, [identifiers.wallet]);
        await transaction.query(`select app.finalize_ledger_transaction($1)`, [
          identifiers.ledgerTransaction,
        ]);
        await transaction.query(
          `select app.complete_idempotency_record($1, 201, '{}'::jsonb,
                                                  'ledger_transaction', $2)`,
          [identifiers.idempotency, identifiers.ledgerTransaction],
        );
      });

      const before = await database.query<{
        readonly boxXmin: string;
        readonly entryXmin: string;
        readonly priceMinor: string;
        readonly rewardVersionId: string;
        readonly weight: string;
      }>(
        `select version.xmin::text as "boxXmin", entry.xmin::text as "entryXmin",
                version.price_minor::text as "priceMinor",
                entry.reward_version_id::text as "rewardVersionId",
                entry.weight::text as weight
           from app.box_versions as version
           join app.box_version_rewards as entry on entry.box_version_id = version.id
          where version.id = $1`,
        [identifiers.version],
      );
      const beforeRow = before.rows[0];
      if (beforeRow === undefined) throw new Error('Legacy catalog fixture was not found.');
      const financialBefore = await database.query<{
        readonly balance: string;
        readonly idempotencyStatus: string;
        readonly ledgerStatus: string;
        readonly revision: string;
        readonly total: string;
      }>(
        `select wallet.available_balance_minor::text as balance,
                wallet.revision::text as revision,
                ledger.status as "ledgerStatus",
                record.status as "idempotencyStatus",
                (select sum(amount_minor)::text from app.ledger_entries
                  where ledger_transaction_id = ledger.id) as total
           from app.wallets as wallet
           join app.ledger_transactions as ledger on ledger.id = $2
           join app.idempotency_records as record on record.id = $3
          where wallet.id = $1`,
        [identifiers.wallet, identifiers.ledgerTransaction, identifiers.idempotency],
      );
      expect(financialBefore.rows).toEqual([
        {
          balance: '500',
          idempotencyStatus: 'completed',
          ledgerStatus: 'posted',
          revision: '2',
          total: '0',
        },
      ]);

      for (const fileName of [...phase9And10Migrations, ...phase11Migrations]) {
        await database.query(await migrationSql(fileName));
      }

      // This fixture isolates the forward migration's rewrite behavior. PostgreSQL's
      // replica mode is used only to construct already-committed immutable Phase 9
      // history without recreating the opening coordinator in this database-package test.
      await database.query(`set session_replication_role = replica`);
      try {
        await database.query(
          `insert into app.box_opens (
             id, public_id, user_id, creator_id, box_id, box_version_id,
             selected_box_version_reward_id, reward_version_id, inventory_pool_id,
             rng_seed_set_id, nonce, client_seed, server_seed_commitment,
             rng_algorithm_version, rng_digest, rng_selection, rng_selection_round,
             configuration_hash, gross_price_minor, currency, platform_fee_bps,
             platform_fee_minor, creator_share_minor, earnings_available_at,
             points_policy_version, base_points, bonus_points, points_awarded,
             sale_ledger_transaction_id, allocation_ledger_transaction_id,
             idempotency_record_id
           ) values (
             $1, $2, $3, $4, $5, $6, $7, $8, $8, $9, 0, 'phase8-upgrade',
             decode(repeat('31', 32), 'hex'), 'hmac-sha256-rejection-v1',
             decode(repeat('32', 32), 'hex'), 0, 0, decode(repeat('ab', 32), 'hex'),
             1000, 'USD', 2000, 200, 800,
             statement_timestamp() + interval '14 days',
             'leaderboard-v1', 5, 0, 5, $10, $10, $11
           )`,
          [
            identifiers.opening,
            identifiers.openingPublic,
            identifiers.user,
            identifiers.creator,
            identifiers.box,
            identifiers.version,
            identifiers.entry,
            identifiers.rewardVersion,
            identifiers.seedSet,
            identifiers.ledgerTransaction,
            identifiers.idempotency,
          ],
        );
        await database.query(
          `insert into app.reward_wins (
             id, opening_id, user_id, creator_id, reward_version_id
           ) values ($1, $2, $3, $4, $5)`,
          [
            identifiers.rewardWin,
            identifiers.opening,
            identifiers.user,
            identifiers.creator,
            identifiers.rewardVersion,
          ],
        );
        await database.query(
          `insert into app.fulfillment_obligations (id, opening_id, reward_win_id, status)
           values ($1, $2, $3, 'pending_fulfillment')`,
          [identifiers.fulfillment, identifiers.opening, identifiers.rewardWin],
        );
      } finally {
        await database.query(`set session_replication_role = origin`);
      }
      const historyBefore = await database.query<{
        readonly openingXmin: string;
        readonly winXmin: string;
      }>(
        `select opening.xmin::text as "openingXmin", win.xmin::text as "winXmin"
           from app.box_opens as opening
           join app.reward_wins as win on win.opening_id = opening.id
          where opening.id = $1`,
        [identifiers.opening],
      );

      for (const fileName of phase12Migrations) await database.query(await migrationSql(fileName));
      for (const fileName of phase13Migrations) await database.query(await migrationSql(fileName));
      for (const fileName of phase15Migrations) await database.query(await migrationSql(fileName));

      const after = await database.query<{
        readonly baseCount: string;
        readonly boxXmin: string;
        readonly compatibility: string | null;
        readonly entryXmin: string;
        readonly maxOpeningsPerUser: string | null;
        readonly priceMinor: string;
        readonly rarity: string | null;
        readonly rarityPolicyVersion: string | null;
        readonly rewardVersionId: string;
        readonly weight: string;
      }>(
        `select version.xmin::text as "boxXmin", entry.xmin::text as "entryXmin",
                version.price_minor::text as "priceMinor",
                version.max_openings_per_user::text as "maxOpeningsPerUser",
                entry.reward_version_id::text as "rewardVersionId",
                entry.weight::text as weight,
                entry.rarity,
                entry.rarity_policy_version as "rarityPolicyVersion",
                version.opening_compatibility_version as compatibility,
                (select count(*)::text from app.box_version_base_rewards as base
                  where base.box_version_id = version.id) as "baseCount"
           from app.box_versions as version
           join app.box_version_rewards as entry on entry.box_version_id = version.id
          where version.id = $1`,
        [identifiers.version],
      );
      expect(after.rows).toEqual([
        {
          ...beforeRow,
          baseCount: '0',
          compatibility: null,
          maxOpeningsPerUser: null,
          rarity: null,
          rarityPolicyVersion: null,
        },
      ]);
      const inventoryAfter = await database.query<{
        readonly available: string;
        readonly initial: string;
        readonly poolId: string;
        readonly rewardVersionPoolId: string;
      }>(
        `select pool.id::text as "poolId",
                reward_version.inventory_pool_id::text as "rewardVersionPoolId",
                pool.initial_quantity::text as initial,
                pool.available_quantity::text as available
           from app.reward_versions as reward_version
           join app.inventory_pools as pool on pool.id = reward_version.inventory_pool_id
          where reward_version.id = $1`,
        [identifiers.rewardVersion],
      );
      expect(inventoryAfter.rows).toEqual([
        {
          available: '5',
          initial: '5',
          poolId: identifiers.rewardVersion,
          rewardVersionPoolId: identifiers.rewardVersion,
        },
      ]);
      const financialAfter = await database.query<{
        readonly balance: string;
        readonly idempotencyStatus: string;
        readonly ledgerStatus: string;
        readonly revision: string;
        readonly total: string;
      }>(
        `select wallet.available_balance_minor::text as balance,
                wallet.revision::text as revision,
                ledger.status as "ledgerStatus",
                record.status as "idempotencyStatus",
                (select sum(amount_minor)::text from app.ledger_entries
                  where ledger_transaction_id = ledger.id) as total
           from app.wallets as wallet
           join app.ledger_transactions as ledger on ledger.id = $2
           join app.idempotency_records as record on record.id = $3
          where wallet.id = $1`,
        [identifiers.wallet, identifiers.ledgerTransaction, identifiers.idempotency],
      );
      expect(financialAfter.rows).toEqual(financialBefore.rows);
      const historyAfter = await database.query<{
        readonly currentState: string;
        readonly fulfillmentType: string;
        readonly openingModel: string;
        readonly openingXmin: string;
        readonly originStatus: string;
        readonly winXmin: string;
      }>(
        `select opening.xmin::text as "openingXmin", win.xmin::text as "winXmin",
                opening.opening_compatibility_version as "openingModel",
                obligation.status as "originStatus",
                obligation.fulfillment_type as "fulfillmentType",
                obligation.current_state as "currentState"
           from app.box_opens as opening
           join app.reward_wins as win on win.opening_id = opening.id
           join app.fulfillment_obligations as obligation on obligation.opening_id = opening.id
          where opening.id = $1`,
        [identifiers.opening],
      );
      expect(historyAfter.rows).toEqual([
        {
          ...historyBefore.rows[0],
          currentState: 'ready_for_delivery',
          fulfillmentType: 'digital',
          openingModel: 'opening-v1',
          originStatus: 'pending_fulfillment',
        },
      ]);
      expect(
        (
          await database.query<{
            readonly activeCount: string;
            readonly domain: string;
            readonly identityMatchesMaterial: boolean;
            readonly version: string;
          }>(
            `select actor_key.version,
                    (select count(*)::text
                       from app_private.fulfillment_actor_binding_keys
                      where status = 'active') as "activeCount",
                    actor_key.key_identity = extensions.digest(actor_key.key_material, 'sha256')
                      as "identityMatchesMaterial",
                    identity.encryption_domain as domain
               from app_private.fulfillment_actor_binding_keys as actor_key
               join app_private.encryption_key_domain_identities as identity
                 on identity.key_identity = actor_key.key_identity
              where actor_key.status = 'active'`,
          )
        ).rows,
      ).toEqual([
        {
          activeCount: '1',
          domain: 'actor_binding',
          identityMatchesMaterial: true,
          version: 'local-fulfillment-actor-v1',
        },
      ]);
      await expect(
        database.query(
          `update app.box_versions
              set opening_compatibility_version = 'opening-v1'
            where id = $1`,
          [identifiers.version],
        ),
      ).rejects.toThrow(/Published catalog versions are immutable/iu);
      expect(
        (
          await database.query<{
            readonly achievements: string | null;
            readonly projectionQueue: string | null;
            readonly seasons: string | null;
          }>(
            `select to_regclass('app.leaderboard_seasons')::text as seasons,
                    to_regclass('app.user_achievements')::text as achievements,
                    to_regclass('app.leaderboard_projection_events')::text as "projectionQueue"`,
          )
        ).rows,
      ).toEqual([
        {
          achievements: 'app.user_achievements',
          projectionQueue: 'app.leaderboard_projection_events',
          seasons: 'app.leaderboard_seasons',
        },
      ]);
    } finally {
      await database.close();
      await admin.query(`drop database "${name}"`);
      databasesToDrop.delete(name);
    }
  });

  it('applies the remediated Phase 11 schema over a Phase 10 database', async () => {
    const name = `creatordrop_phase10_upgrade_${randomUUID().replaceAll('-', '')}`;
    if (!/^[a-z0-9_]+$/u.test(name)) throw new Error('Generated an unsafe database name.');
    await admin.query(`create database "${name}"`);
    databasesToDrop.add(name);
    const database = createPool(databaseUrl(name), name);
    try {
      for (const fileName of [...phase8Migrations, ...phase9And10Migrations]) {
        await database.query(await migrationSql(fileName));
      }
      const before = await database.query<{ readonly outbox: string | null }>(
        `select to_regclass('app.event_outbox')::text as outbox`,
      );
      expect(before.rows).toEqual([{ outbox: 'app.event_outbox' }]);

      for (const fileName of phase11Migrations) await database.query(await migrationSql(fileName));

      const after = await database.query<{
        readonly fundingIntents: string | null;
        readonly oldWalletFunction: string | null;
        readonly outbox: string | null;
        readonly scopedWalletFunction: string | null;
      }>(
        `select to_regclass('app.event_outbox')::text as outbox,
                to_regclass('app.funding_intents')::text as "fundingIntents",
                to_regprocedure(
                  'app.apply_provider_adjustment_wallet_balance(uuid,bigint)'
                )::text as "oldWalletFunction",
                to_regprocedure(
                  'app.apply_provider_adjustment_wallet_balance(uuid,uuid,uuid,bigint)'
                )::text as "scopedWalletFunction"`,
      );
      expect(after.rows).toEqual([
        {
          fundingIntents: 'app.funding_intents',
          oldWalletFunction: null,
          outbox: 'app.event_outbox',
          scopedWalletFunction:
            'app.apply_provider_adjustment_wallet_balance(uuid,uuid,uuid,bigint)',
        },
      ]);
    } finally {
      await database.close();
      await admin.query(`drop database "${name}"`);
      databasesToDrop.delete(name);
    }
  });
});
