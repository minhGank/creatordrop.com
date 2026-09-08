import { xpRewardSchema, type XpReward } from '@creatordrop/contracts';
import { validate as isUuid } from 'uuid';

import type { QueryExecutor } from '@creatordrop/database';

import type { RngSeedSetStatus } from './fairness.js';

interface OpeningProofHeaderRow {
  readonly acceptedDigestHex: unknown;
  readonly acceptedRound: unknown;
  readonly algorithmVersion: unknown;
  readonly boxId: unknown;
  readonly boxVersionId: unknown;
  readonly clientSeed: unknown;
  readonly configurationHash: unknown;
  readonly currency: unknown;
  readonly manifestConfigurationHash: unknown;
  readonly nonce: unknown;
  readonly openingCompatibilityVersion: unknown;
  readonly openedAt: unknown;
  readonly openingId: unknown;
  readonly position: unknown;
  readonly maxOpeningsPerUser: unknown;
  readonly priceMinor: unknown;
  readonly revealedServerSeedHex: unknown;
  readonly rewardVersionId: unknown;
  readonly seedAlgorithmVersion: unknown;
  readonly seedCommitment: unknown;
  readonly seedSetId: unknown;
  readonly seedStatus: unknown;
  readonly selectedBoxVersionRewardId: unknown;
  readonly selectionValue: unknown;
  readonly serverSeedCommitment: unknown;
  readonly totalWeight: unknown;
}

interface OpeningProofManifestEntryRow {
  readonly xpAmount: unknown;
  readonly xpPolicyVersion: unknown;
  readonly boxVersionRewardId: unknown;
  readonly position: unknown;
  readonly rarity: unknown;
  readonly rarityPolicyVersion: unknown;
  readonly rewardVersionId: unknown;
  readonly weight: unknown;
}

const proofRarities = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;

const isProofRarity = (
  value: unknown,
): value is Exclude<OpeningProofManifestEntry['rarity'], null> =>
  proofRarities.some((rarity) => rarity === value);

export interface OpeningProofHeader {
  readonly acceptedDigestHex: string;
  readonly acceptedRound: string;
  readonly algorithmVersion: 'hmac-sha256-rejection-v1';
  readonly boxId: string;
  readonly boxVersionId: string;
  readonly clientSeed: string;
  readonly configurationHash: string;
  readonly currency: string | null;
  readonly maxOpeningsPerUser: string | null;
  readonly nonce: string;
  readonly openedAt: string;
  readonly openingId: string;
  readonly openingCompatibilityVersion: 'opening-v1' | 'opening-v2';
  readonly position: number;
  readonly priceMinor: string | null;
  readonly revealedServerSeedHex: string | null;
  readonly rewardVersionId: string;
  readonly seedSetId: string;
  readonly seedStatus: RngSeedSetStatus;
  readonly selectedBoxVersionRewardId: string;
  readonly selectionValue: string;
  readonly serverSeedCommitment: string;
  readonly totalWeight: string;
}

export interface OpeningProofManifestEntry {
  readonly xpReward?: XpReward;
  readonly boxVersionRewardId: string;
  readonly position: number;
  readonly rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | null;
  readonly rarityPolicyVersion: 'rarity-v1' | null;
  readonly rewardVersionId: string;
  readonly weight: string;
}

const canonicalUuid = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !isUuid(value) || value !== value.toLowerCase()) {
    throw new Error(`Database returned an invalid ${label}.`);
  }
  return value;
};

const canonicalDecimal = (value: unknown, label: string, positive = false): string => {
  if (
    typeof value !== 'string' ||
    !(positive ? /^[1-9][0-9]*$/u : /^(?:0|[1-9][0-9]*)$/u).test(value)
  ) {
    throw new Error(`Database returned an invalid ${label}.`);
  }
  return value;
};

const hex256 = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`Database returned an invalid ${label}.`);
  }
  return value;
};

const timestamp = (value: unknown, label: string): string => {
  const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (parsed === null || !Number.isFinite(parsed.getTime())) {
    throw new Error(`Database returned an invalid ${label}.`);
  }
  return parsed.toISOString();
};

const position = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Database returned an invalid reward position.');
  }
  return value;
};

const seedStatus = (value: unknown): RngSeedSetStatus => {
  if (!['active', 'retired', 'revealed', 'compromised'].includes(String(value))) {
    throw new Error('Database returned an invalid seed status.');
  }
  return value as RngSeedSetStatus;
};

export const findOpeningProofHeader = async (
  executor: QueryExecutor,
  publicOpeningId: string,
): Promise<OpeningProofHeader | undefined> => {
  const result = await executor.query<OpeningProofHeaderRow>(
    `select opening.public_id::text as "openingId", opening.created_at as "openedAt",
            opening.box_id::text as "boxId", opening.box_version_id::text as "boxVersionId",
            opening.rng_seed_set_id::text as "seedSetId", opening.nonce::text as nonce,
            opening.client_seed as "clientSeed",
            encode(opening.server_seed_commitment, 'hex') as "serverSeedCommitment",
            opening.rng_algorithm_version as "algorithmVersion",
            encode(opening.rng_digest, 'hex') as "acceptedDigestHex",
            opening.rng_selection::text as "selectionValue",
            opening.rng_selection_round::text as "acceptedRound",
            encode(opening.configuration_hash, 'hex') as "configurationHash",
            opening.selected_box_version_reward_id::text as "selectedBoxVersionRewardId",
            opening.reward_version_id::text as "rewardVersionId",
            selected.position,
            opening.opening_compatibility_version as "openingCompatibilityVersion",
            version.price_minor::text as "priceMinor", version.currency::text as currency,
            version.max_openings_per_user::text as "maxOpeningsPerUser",
            version.total_weight::text as "totalWeight",
            encode(version.configuration_hash, 'hex') as "manifestConfigurationHash",
            seed.status as "seedStatus", seed.rng_algorithm_version as "seedAlgorithmVersion",
            encode(seed.commitment, 'hex') as "seedCommitment",
            case when seed.status = 'revealed'
              then encode(seed.revealed_server_seed, 'hex')
              else null
            end as "revealedServerSeedHex"
       from app.box_opens as opening
       join app.rng_seed_sets as seed
         on seed.id = opening.rng_seed_set_id and seed.user_id = opening.user_id
       join app.box_versions as version
         on version.id = opening.box_version_id and version.box_id = opening.box_id
       join app.box_version_rewards as selected
         on selected.id = opening.selected_box_version_reward_id
        and selected.box_version_id = opening.box_version_id
        and selected.reward_version_id = opening.reward_version_id
      where opening.public_id = $1`,
    [publicOpeningId],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  const algorithmVersion = row.algorithmVersion;
  if (
    algorithmVersion !== 'hmac-sha256-rejection-v1' ||
    row.seedAlgorithmVersion !== algorithmVersion
  ) {
    throw new Error('Opening proof has inconsistent algorithm versions.');
  }
  const configurationHash = hex256(row.configurationHash, 'opening configuration hash');
  if (hex256(row.manifestConfigurationHash, 'manifest configuration hash') !== configurationHash) {
    throw new Error('Opening proof has inconsistent configuration hashes.');
  }
  const serverSeedCommitment = hex256(row.serverSeedCommitment, 'opening seed commitment');
  if (hex256(row.seedCommitment, 'seed-set commitment') !== serverSeedCommitment) {
    throw new Error('Opening proof has inconsistent seed commitments.');
  }
  const status = seedStatus(row.seedStatus);
  const openingCompatibilityVersion = row.openingCompatibilityVersion;
  if (
    openingCompatibilityVersion !== 'opening-v1' &&
    openingCompatibilityVersion !== 'opening-v2'
  ) {
    throw new Error('Opening proof has an invalid opening model.');
  }
  const isVersionTwo = openingCompatibilityVersion === 'opening-v2';
  if (
    isVersionTwo
      ? row.currency !== null || row.priceMinor !== null || row.maxOpeningsPerUser === null
      : row.currency === null || row.priceMinor === null || row.maxOpeningsPerUser !== null
  ) {
    throw new Error('Opening proof has an invalid opening model shape.');
  }
  const revealedServerSeedHex =
    row.revealedServerSeedHex === null
      ? null
      : hex256(row.revealedServerSeedHex, 'revealed server seed');
  if ((status === 'revealed') !== (revealedServerSeedHex !== null)) {
    throw new Error('Opening proof has an invalid reveal state.');
  }
  return {
    acceptedDigestHex: hex256(row.acceptedDigestHex, 'accepted digest'),
    acceptedRound: canonicalDecimal(row.acceptedRound, 'accepted round'),
    algorithmVersion,
    boxId: canonicalUuid(row.boxId, 'box ID'),
    boxVersionId: canonicalUuid(row.boxVersionId, 'box version ID'),
    clientSeed: hex256(row.clientSeed, 'client seed'),
    configurationHash,
    currency: isVersionTwo
      ? null
      : typeof row.currency === 'string' && /^[A-Z]{3}$/u.test(row.currency)
        ? row.currency
        : (() => {
            throw new Error('Database returned an invalid proof currency.');
          })(),
    maxOpeningsPerUser: isVersionTwo
      ? canonicalDecimal(row.maxOpeningsPerUser, 'maximum openings per user', true)
      : null,
    nonce: canonicalDecimal(row.nonce, 'nonce'),
    openedAt: timestamp(row.openedAt, 'opening timestamp'),
    openingId: canonicalUuid(row.openingId, 'public opening ID'),
    openingCompatibilityVersion,
    position: position(row.position),
    priceMinor: isVersionTwo ? null : canonicalDecimal(row.priceMinor, 'price', true),
    revealedServerSeedHex,
    rewardVersionId: canonicalUuid(row.rewardVersionId, 'reward version ID'),
    seedSetId: canonicalUuid(row.seedSetId, 'seed-set ID'),
    seedStatus: status,
    selectedBoxVersionRewardId: canonicalUuid(
      row.selectedBoxVersionRewardId,
      'selected box-version reward ID',
    ),
    selectionValue: canonicalDecimal(row.selectionValue, 'selection value'),
    serverSeedCommitment,
    totalWeight: canonicalDecimal(row.totalWeight, 'total weight', true),
  };
};

export const listOpeningProofManifestEntries = async (
  executor: QueryExecutor,
  boxVersionId: string,
): Promise<readonly OpeningProofManifestEntry[]> => {
  const result = await executor.query<OpeningProofManifestEntryRow>(
    `select e.id::text as "boxVersionRewardId", position, rarity,
            rarity_policy_version as "rarityPolicyVersion",
            reward_version_id::text as "rewardVersionId", weight::text as weight,
            r.xp_amount::text as "xpAmount", r.xp_policy_version as "xpPolicyVersion"
       from app.box_version_rewards e join app.reward_versions r on r.id=e.reward_version_id
      where box_version_id = $1
      order by position`,
    [boxVersionId],
  );
  return result.rows.map((row) => {
    const rarity = row.rarity;
    if (rarity !== null && !isProofRarity(rarity)) {
      throw new Error('Database returned an invalid manifest rarity.');
    }
    const rarityPolicyVersion = row.rarityPolicyVersion;
    if (rarityPolicyVersion !== null && rarityPolicyVersion !== 'rarity-v1') {
      throw new Error('Database returned an invalid manifest rarity policy.');
    }
    if ((rarity === null) !== (rarityPolicyVersion === null)) {
      throw new Error('Database returned an incomplete manifest rarity snapshot.');
    }
    return {
      ...(row.xpAmount == null
        ? {}
        : {
            xpReward: xpRewardSchema.parse({
              amount: row.xpAmount,
              policyVersion: row.xpPolicyVersion,
            }),
          }),
      boxVersionRewardId: canonicalUuid(row.boxVersionRewardId, 'manifest entry ID'),
      position: position(row.position),
      rarity,
      rarityPolicyVersion,
      rewardVersionId: canonicalUuid(row.rewardVersionId, 'manifest reward version ID'),
      weight: canonicalDecimal(row.weight, 'manifest weight', true),
    };
  });
};
