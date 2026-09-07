import { createHash, timingSafeEqual } from 'node:crypto';

import { createVerifierHmacDigestSource } from './crypto.js';
import { VerifierError, type VerifierErrorCode } from './errors.js';
import { sampleVerifierDigests } from './rejection-sampling.js';
import type {
  ProofMismatchCode,
  RecordedRewardSelection,
  RewardSelectionVerification,
  VerifiedRewardSelection,
} from './types.js';

const algorithmVersion = 'hmac-sha256-rejection-v1';
const maximumSignedBigint = 9_223_372_036_854_775_807n;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const hex256Pattern = /^[0-9a-f]{64}$/u;
const nonnegativeDecimalPattern = /^(0|[1-9][0-9]*)$/u;
const positiveDecimalPattern = /^[1-9][0-9]*$/u;

interface ParsedEntry {
  readonly boxVersionRewardId: string;
  readonly position: number;
  readonly rarity?: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
  readonly rarityPolicyVersion?: 'rarity-v1';
  readonly rewardVersionId: string;
  readonly weight: bigint;
  readonly weightText: string;
}

interface ParsedManifest {
  readonly algorithmVersion: typeof algorithmVersion;
  readonly boxId: string;
  readonly boxVersionId: string;
  readonly currency?: string;
  readonly entries: readonly ParsedEntry[];
  readonly maxOpeningsPerUser?: string;
  readonly openingCompatibilityVersion?: 'opening-v2';
  readonly priceMinor?: string;
  readonly totalWeight: bigint;
  readonly totalWeightText: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const objectWithFields = (
  value: unknown,
  fields: readonly string[],
  code: VerifierErrorCode,
): Record<string, unknown> => {
  if (!isObject(value)) throw new VerifierError(code);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    expected.some((field, index) => !Object.hasOwn(value, field) || field !== actual[index])
  ) {
    throw new VerifierError(code);
  }
  return value;
};

const uuid = (value: unknown, code: VerifierErrorCode): string => {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new VerifierError(code);
  return value;
};

const hex256 = (value: unknown, code: VerifierErrorCode): string => {
  if (typeof value !== 'string' || !hex256Pattern.test(value)) throw new VerifierError(code);
  return value;
};

const nonnegativeDecimal = (value: unknown, code: VerifierErrorCode): bigint => {
  if (typeof value !== 'string' || !nonnegativeDecimalPattern.test(value)) {
    throw new VerifierError(code);
  }
  return BigInt(value);
};

const positiveSignedDecimal = (
  value: unknown,
  code: 'INVALID_WEIGHT' | 'MALFORMED_MANIFEST',
): bigint => {
  if (typeof value !== 'string' || !positiveDecimalPattern.test(value)) {
    throw new VerifierError(code);
  }
  const parsed = BigInt(value);
  if (parsed > maximumSignedBigint) {
    throw new VerifierError(code === 'INVALID_WEIGHT' ? 'WEIGHT_OVERFLOW' : code);
  }
  return parsed;
};

const parseManifest = (value: unknown): ParsedManifest => {
  if (isObject(value) && value.openingCompatibilityVersion === 'opening-v2') {
    const manifest = objectWithFields(
      value,
      [
        'algorithmVersion',
        'boxId',
        'boxVersionId',
        'entries',
        'maxOpeningsPerUser',
        'openingCompatibilityVersion',
        'totalWeight',
      ],
      'MALFORMED_MANIFEST',
    );
    if (manifest.algorithmVersion !== algorithmVersion) {
      throw new VerifierError('UNSUPPORTED_ALGORITHM');
    }
    if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
      throw new VerifierError('NO_SELECTABLE_REWARD');
    }
    const rarities = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;
    const entries = Array.from(manifest.entries, (input, expectedPosition): ParsedEntry => {
      const entry = objectWithFields(
        input,
        [
          'boxVersionRewardId',
          'position',
          'rarity',
          'rarityPolicyVersion',
          'rewardVersionId',
          'weight',
        ],
        'MALFORMED_MANIFEST',
      );
      if (
        entry.position !== expectedPosition ||
        typeof entry.rarity !== 'string' ||
        !rarities.includes(entry.rarity as (typeof rarities)[number]) ||
        entry.rarityPolicyVersion !== 'rarity-v1'
      ) {
        throw new VerifierError('MALFORMED_MANIFEST');
      }
      const weight = positiveSignedDecimal(entry.weight, 'INVALID_WEIGHT');
      return {
        boxVersionRewardId: uuid(entry.boxVersionRewardId, 'MALFORMED_MANIFEST'),
        position: expectedPosition,
        rarity: entry.rarity as NonNullable<ParsedEntry['rarity']>,
        rarityPolicyVersion: 'rarity-v1',
        rewardVersionId: uuid(entry.rewardVersionId, 'MALFORMED_MANIFEST'),
        weight,
        weightText: weight.toString(),
      };
    });
    validateParsedEntries(entries);
    const totalWeight = positiveSignedDecimal(manifest.totalWeight, 'INVALID_WEIGHT');
    if (entries.reduce((sum, entry) => sum + entry.weight, 0n) !== totalWeight) {
      throw new VerifierError('TOTAL_WEIGHT_MISMATCH');
    }
    return {
      algorithmVersion,
      boxId: uuid(manifest.boxId, 'MALFORMED_MANIFEST'),
      boxVersionId: uuid(manifest.boxVersionId, 'MALFORMED_MANIFEST'),
      entries,
      maxOpeningsPerUser: positiveSignedDecimal(
        manifest.maxOpeningsPerUser,
        'MALFORMED_MANIFEST',
      ).toString(),
      openingCompatibilityVersion: 'opening-v2',
      totalWeight,
      totalWeightText: totalWeight.toString(),
    };
  }
  const manifest = objectWithFields(
    value,
    [
      'algorithmVersion',
      'boxId',
      'boxVersionId',
      'currency',
      'entries',
      'priceMinor',
      'totalWeight',
    ],
    'MALFORMED_MANIFEST',
  );
  if (manifest.algorithmVersion !== algorithmVersion) {
    throw new VerifierError('UNSUPPORTED_ALGORITHM');
  }
  if (typeof manifest.currency !== 'string' || !/^[A-Z]{3}$/u.test(manifest.currency)) {
    throw new VerifierError('MALFORMED_MANIFEST');
  }
  if (!Array.isArray(manifest.entries)) throw new VerifierError('MALFORMED_MANIFEST');
  if (manifest.entries.length === 0) throw new VerifierError('NO_SELECTABLE_REWARD');

  const entries = Array.from(manifest.entries, (input, expectedPosition): ParsedEntry => {
    const entry = objectWithFields(
      input,
      ['boxVersionRewardId', 'position', 'rewardVersionId', 'weight'],
      'MALFORMED_MANIFEST',
    );
    if (
      typeof entry.position !== 'number' ||
      !Number.isSafeInteger(entry.position) ||
      entry.position !== expectedPosition
    ) {
      throw new VerifierError('MALFORMED_MANIFEST');
    }
    const weight = positiveSignedDecimal(entry.weight, 'INVALID_WEIGHT');
    return {
      boxVersionRewardId: uuid(entry.boxVersionRewardId, 'MALFORMED_MANIFEST'),
      position: expectedPosition,
      rewardVersionId: uuid(entry.rewardVersionId, 'MALFORMED_MANIFEST'),
      weight,
      weightText: weight.toString(),
    };
  });
  validateParsedEntries(entries);

  let sum = 0n;
  for (const entry of entries) {
    sum += entry.weight;
    if (sum > maximumSignedBigint) throw new VerifierError('WEIGHT_OVERFLOW');
  }
  const totalWeight = positiveSignedDecimal(manifest.totalWeight, 'INVALID_WEIGHT');
  if (sum !== totalWeight) throw new VerifierError('TOTAL_WEIGHT_MISMATCH');
  const priceMinor = positiveSignedDecimal(manifest.priceMinor, 'MALFORMED_MANIFEST');

  return {
    algorithmVersion,
    boxId: uuid(manifest.boxId, 'MALFORMED_MANIFEST'),
    boxVersionId: uuid(manifest.boxVersionId, 'MALFORMED_MANIFEST'),
    currency: manifest.currency,
    entries,
    priceMinor: priceMinor.toString(),
    totalWeight,
    totalWeightText: totalWeight.toString(),
  };
};

function validateParsedEntries(entries: readonly ParsedEntry[]): void {
  if (
    new Set(entries.map(({ boxVersionRewardId }) => boxVersionRewardId)).size !== entries.length ||
    new Set(entries.map(({ rewardVersionId }) => rewardVersionId)).size !== entries.length
  ) {
    throw new VerifierError('MALFORMED_MANIFEST');
  }
}

const quote = (value: string): string => JSON.stringify(value);

const canonicalManifest = (manifest: ParsedManifest): string => {
  if (manifest.openingCompatibilityVersion === 'opening-v2') {
    if (manifest.maxOpeningsPerUser === undefined) {
      throw new VerifierError('MALFORMED_MANIFEST');
    }
    const entries = manifest.entries
      .map((entry) => {
        if (entry.rarity === undefined || entry.rarityPolicyVersion === undefined) {
          throw new VerifierError('MALFORMED_MANIFEST');
        }
        return `{"boxVersionRewardId":${quote(entry.boxVersionRewardId)},"position":${entry.position.toString()},"rarity":${quote(entry.rarity)},"rarityPolicyVersion":${quote(entry.rarityPolicyVersion)},"rewardVersionId":${quote(entry.rewardVersionId)},"weight":${quote(entry.weightText)}}`;
      })
      .join(',');
    return `{"algorithmVersion":${quote(manifest.algorithmVersion)},"boxId":${quote(manifest.boxId)},"boxVersionId":${quote(manifest.boxVersionId)},"entries":[${entries}],"maxOpeningsPerUser":${quote(manifest.maxOpeningsPerUser)},"openingCompatibilityVersion":"opening-v2","totalWeight":${quote(manifest.totalWeightText)}}`;
  }
  if (manifest.currency === undefined || manifest.priceMinor === undefined) {
    throw new VerifierError('MALFORMED_MANIFEST');
  }
  const entries = manifest.entries
    .map(
      (entry) =>
        `{"boxVersionRewardId":${quote(entry.boxVersionRewardId)},"position":${entry.position.toString()},"rewardVersionId":${quote(entry.rewardVersionId)},"weight":${quote(entry.weightText)}}`,
    )
    .join(',');
  return `{"algorithmVersion":${quote(manifest.algorithmVersion)},"boxId":${quote(manifest.boxId)},"boxVersionId":${quote(manifest.boxVersionId)},"currency":${quote(manifest.currency)},"entries":[${entries}],"priceMinor":${quote(manifest.priceMinor)},"totalWeight":${quote(manifest.totalWeightText)}}`;
};

const fixedHexEqual = (left: string, right: string): boolean =>
  timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));

const parseRecorded = (value: unknown): RecordedRewardSelection => {
  const recorded = objectWithFields(
    value,
    [
      'acceptedDigestHex',
      'acceptedRound',
      'boxVersionRewardId',
      'position',
      'rewardVersionId',
      'roundDigests',
      'selectionValue',
    ],
    'INVALID_PROOF',
  );
  if (!Array.isArray(recorded.roundDigests)) throw new VerifierError('INVALID_PROOF');
  const roundDigests = recorded.roundDigests.map((value) => {
    const item = objectWithFields(value, ['digestHex', 'round'], 'INVALID_PROOF');
    return {
      digestHex: hex256(item.digestHex, 'INVALID_PROOF'),
      round: nonnegativeDecimal(item.round, 'INVALID_PROOF').toString(),
    };
  });
  if (
    typeof recorded.position !== 'number' ||
    !Number.isSafeInteger(recorded.position) ||
    recorded.position < 0
  ) {
    throw new VerifierError('INVALID_PROOF');
  }
  return {
    acceptedDigestHex: hex256(recorded.acceptedDigestHex, 'INVALID_PROOF'),
    acceptedRound: nonnegativeDecimal(recorded.acceptedRound, 'INVALID_PROOF').toString(),
    boxVersionRewardId: uuid(recorded.boxVersionRewardId, 'INVALID_PROOF'),
    position: recorded.position,
    rewardVersionId: uuid(recorded.rewardVersionId, 'INVALID_PROOF'),
    roundDigests,
    selectionValue: nonnegativeDecimal(recorded.selectionValue, 'INVALID_PROOF').toString(),
  };
};

const sameRoundDigests = (
  expected: RecordedRewardSelection['roundDigests'],
  actual: VerifiedRewardSelection['roundDigests'],
): boolean =>
  expected.length === actual.length &&
  expected.every((item, index) => {
    const actualItem = actual[index];
    if (actualItem === undefined) return false;
    return item.round === actualItem.round && fixedHexEqual(item.digestHex, actualItem.digestHex);
  });

export const verifyRewardSelectionProof = (inputValue: unknown): RewardSelectionVerification => {
  const input = objectWithFields(
    inputValue,
    [
      'algorithmVersion',
      'clientSeed',
      'configurationHash',
      'manifest',
      'nonce',
      'recorded',
      'seedSetId',
      'serverSeedCommitment',
      'serverSeedHex',
    ],
    'INVALID_PROOF',
  );
  if (input.algorithmVersion !== algorithmVersion) {
    throw new VerifierError('UNSUPPORTED_ALGORITHM');
  }
  const clientSeed = hex256(input.clientSeed, 'INVALID_CLIENT_SEED');
  const seedSetId = uuid(input.seedSetId, 'INVALID_SEED_SET_ID');
  const nonce = nonnegativeDecimal(input.nonce, 'INVALID_NONCE').toString();
  const serverSeedHex = hex256(input.serverSeedHex, 'INVALID_SERVER_SEED');
  const expectedCommitment = hex256(input.serverSeedCommitment, 'INVALID_PROOF');
  const expectedManifestHash = hex256(input.configurationHash, 'INVALID_PROOF');
  const recorded = parseRecorded(input.recorded);
  const manifest = parseManifest(input.manifest);

  const serverSeed = Buffer.from(serverSeedHex, 'hex');
  const commitment = createHash('sha256').update(serverSeed).digest('hex');
  const manifestHash = createHash('sha256')
    .update(canonicalManifest(manifest), 'utf8')
    .digest('hex');
  const sample = sampleVerifierDigests(
    manifest.totalWeight,
    createVerifierHmacDigestSource({ clientSeed, nonce, seedSetId, serverSeed }),
  );

  let start = 0n;
  let winner: ParsedEntry | undefined;
  for (const entry of manifest.entries) {
    const end = start + entry.weight;
    if (sample.selectionValue >= start && sample.selectionValue < end) winner = entry;
    start = end;
  }
  if (winner === undefined || start !== manifest.totalWeight) {
    throw new VerifierError('NO_SELECTABLE_REWARD');
  }

  const computed: VerifiedRewardSelection = {
    acceptedDigestHex: sample.acceptedDigestHex,
    acceptedRound: sample.acceptedRound.toString(),
    boxVersionRewardId: winner.boxVersionRewardId,
    manifestHash,
    position: winner.position,
    rewardVersionId: winner.rewardVersionId,
    roundDigests: sample.roundDigests,
    selectionValue: sample.selectionValue.toString(),
    serverSeedCommitment: commitment,
    totalWeight: manifest.totalWeightText,
  };
  const mismatches: ProofMismatchCode[] = [];
  if (!fixedHexEqual(expectedCommitment, commitment)) mismatches.push('SERVER_SEED_COMMITMENT');
  if (!fixedHexEqual(expectedManifestHash, manifestHash)) mismatches.push('MANIFEST_HASH');
  if (!sameRoundDigests(recorded.roundDigests, sample.roundDigests)) {
    mismatches.push('ROUND_DIGESTS');
  }
  if (recorded.acceptedRound !== computed.acceptedRound) mismatches.push('ACCEPTED_ROUND');
  if (!fixedHexEqual(recorded.acceptedDigestHex, computed.acceptedDigestHex)) {
    mismatches.push('ACCEPTED_DIGEST');
  }
  if (recorded.selectionValue !== computed.selectionValue) mismatches.push('SELECTION_VALUE');
  if (recorded.boxVersionRewardId !== computed.boxVersionRewardId) {
    mismatches.push('BOX_VERSION_REWARD');
  }
  if (recorded.rewardVersionId !== computed.rewardVersionId) mismatches.push('REWARD_VERSION');
  if (recorded.position !== computed.position) mismatches.push('POSITION');
  return { computed, mismatches, valid: mismatches.length === 0 };
};
