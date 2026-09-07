import { VerifierError } from './errors.js';
import type { ProofMismatchCode } from './types.js';

const algorithmVersion = 'hmac-sha256-rejection-v1';
const specificationId = 'creatordrop-rng-hmac-sha256-rejection-v1';
const maximumSignedBigint = 9_223_372_036_854_775_807n;
const unsigned256Range = 1n << 256n;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const hex256Pattern = /^[0-9a-f]{64}$/u;
const nonnegativeDecimalPattern = /^(?:0|[1-9][0-9]*)$/u;
const positiveDecimalPattern = /^[1-9][0-9]*$/u;

interface BrowserSubtleCrypto {
  digest(algorithm: string, data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>;
  importKey(
    format: 'raw',
    keyData: Uint8Array<ArrayBuffer>,
    algorithm: { readonly hash: string; readonly name: string },
    extractable: boolean,
    keyUsages: readonly ['sign'],
  ): Promise<unknown>;
  sign(algorithm: string, key: unknown, data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>;
}

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

export type PersistedProofMismatchCode = Exclude<ProofMismatchCode, 'ROUND_DIGESTS'>;

export interface PersistedRewardSelectionVerification {
  readonly computed: {
    readonly acceptedDigestHex: string;
    readonly acceptedRound: string;
    readonly boxVersionRewardId: string;
    readonly manifestHash: string;
    readonly position: number;
    readonly rewardVersionId: string;
    readonly selectionValue: string;
    readonly serverSeedCommitment: string;
    readonly totalWeight: string;
  };
  readonly mismatches: readonly PersistedProofMismatchCode[];
  readonly valid: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const objectWithFields = (value: unknown, fields: readonly string[]): Record<string, unknown> => {
  if (!isObject(value)) throw new VerifierError('INVALID_PROOF');
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    expected.some((field, index) => field !== actual[index] || !Object.hasOwn(value, field))
  ) {
    throw new VerifierError('INVALID_PROOF');
  }
  return value;
};

const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !uuidPattern.test(value)) {
    throw new VerifierError('INVALID_PROOF');
  }
  return value;
};

const hex256 = (
  value: unknown,
  code: 'INVALID_CLIENT_SEED' | 'INVALID_PROOF' | 'INVALID_SERVER_SEED',
): string => {
  if (typeof value !== 'string' || !hex256Pattern.test(value)) throw new VerifierError(code);
  return value;
};

const decimal = (value: unknown, positive: boolean): bigint => {
  if (
    typeof value !== 'string' ||
    !(positive ? positiveDecimalPattern : nonnegativeDecimalPattern).test(value)
  ) {
    throw new VerifierError('INVALID_PROOF');
  }
  return BigInt(value);
};

const parseManifest = (value: unknown): ParsedManifest => {
  if (isObject(value) && value.openingCompatibilityVersion === 'opening-v2') {
    const manifest = objectWithFields(value, [
      'algorithmVersion',
      'boxId',
      'boxVersionId',
      'entries',
      'maxOpeningsPerUser',
      'openingCompatibilityVersion',
      'totalWeight',
    ]);
    if (manifest.algorithmVersion !== algorithmVersion) {
      throw new VerifierError('UNSUPPORTED_ALGORITHM');
    }
    if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
      throw new VerifierError('MALFORMED_MANIFEST');
    }
    const rarities = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;
    const entries = Array.from(manifest.entries, (value, expectedPosition): ParsedEntry => {
      const entry = objectWithFields(value, [
        'boxVersionRewardId',
        'position',
        'rarity',
        'rarityPolicyVersion',
        'rewardVersionId',
        'weight',
      ]);
      if (
        entry.position !== expectedPosition ||
        typeof entry.rarity !== 'string' ||
        !rarities.includes(entry.rarity as (typeof rarities)[number]) ||
        entry.rarityPolicyVersion !== 'rarity-v1'
      ) {
        throw new VerifierError('MALFORMED_MANIFEST');
      }
      const weight = decimal(entry.weight, true);
      if (weight > maximumSignedBigint) throw new VerifierError('WEIGHT_OVERFLOW');
      return {
        boxVersionRewardId: uuid(entry.boxVersionRewardId),
        position: expectedPosition,
        rarity: entry.rarity as NonNullable<ParsedEntry['rarity']>,
        rarityPolicyVersion: 'rarity-v1',
        rewardVersionId: uuid(entry.rewardVersionId),
        weight,
        weightText: weight.toString(),
      };
    });
    validateParsedEntries(entries);
    let computedTotal = 0n;
    for (const entry of entries) {
      computedTotal += entry.weight;
      if (computedTotal > maximumSignedBigint) throw new VerifierError('WEIGHT_OVERFLOW');
    }
    const totalWeight = decimal(manifest.totalWeight, true);
    if (computedTotal !== totalWeight) throw new VerifierError('TOTAL_WEIGHT_MISMATCH');
    const maxOpeningsPerUser = decimal(manifest.maxOpeningsPerUser, true);
    if (maxOpeningsPerUser > maximumSignedBigint) throw new VerifierError('MALFORMED_MANIFEST');
    return {
      algorithmVersion,
      boxId: uuid(manifest.boxId),
      boxVersionId: uuid(manifest.boxVersionId),
      entries,
      maxOpeningsPerUser: maxOpeningsPerUser.toString(),
      openingCompatibilityVersion: 'opening-v2',
      totalWeight,
      totalWeightText: totalWeight.toString(),
    };
  }
  const manifest = objectWithFields(value, [
    'algorithmVersion',
    'boxId',
    'boxVersionId',
    'currency',
    'entries',
    'priceMinor',
    'totalWeight',
  ]);
  if (manifest.algorithmVersion !== algorithmVersion) {
    throw new VerifierError('UNSUPPORTED_ALGORITHM');
  }
  if (typeof manifest.currency !== 'string' || !/^[A-Z]{3}$/u.test(manifest.currency)) {
    throw new VerifierError('MALFORMED_MANIFEST');
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    throw new VerifierError('MALFORMED_MANIFEST');
  }
  const entries = Array.from(manifest.entries, (value, expectedPosition): ParsedEntry => {
    const entry = objectWithFields(value, [
      'boxVersionRewardId',
      'position',
      'rewardVersionId',
      'weight',
    ]);
    if (entry.position !== expectedPosition) throw new VerifierError('MALFORMED_MANIFEST');
    const weight = decimal(entry.weight, true);
    if (weight > maximumSignedBigint) throw new VerifierError('WEIGHT_OVERFLOW');
    return {
      boxVersionRewardId: uuid(entry.boxVersionRewardId),
      position: expectedPosition,
      rewardVersionId: uuid(entry.rewardVersionId),
      weight,
      weightText: weight.toString(),
    };
  });
  validateParsedEntries(entries);
  let computedTotal = 0n;
  for (const entry of entries) {
    computedTotal += entry.weight;
    if (computedTotal > maximumSignedBigint) throw new VerifierError('WEIGHT_OVERFLOW');
  }
  const totalWeight = decimal(manifest.totalWeight, true);
  const priceMinor = decimal(manifest.priceMinor, true);
  if (computedTotal !== totalWeight) throw new VerifierError('TOTAL_WEIGHT_MISMATCH');
  return {
    algorithmVersion,
    boxId: uuid(manifest.boxId),
    boxVersionId: uuid(manifest.boxVersionId),
    currency: manifest.currency,
    entries,
    priceMinor: priceMinor.toString(),
    totalWeight,
    totalWeightText: totalWeight.toString(),
  };
};

function validateParsedEntries(entries: readonly ParsedEntry[]): void {
  if (
    new Set(entries.map((entry) => entry.boxVersionRewardId)).size !== entries.length ||
    new Set(entries.map((entry) => entry.rewardVersionId)).size !== entries.length
  ) {
    throw new VerifierError('MALFORMED_MANIFEST');
  }
}

const canonicalManifest = (manifest: ParsedManifest): string => {
  const quote = (value: string): string => JSON.stringify(value);
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

const hexToBytes = (hex: string): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

const bytesToHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('');

const bytesToBigint = (bytes: ArrayBuffer): bigint => BigInt(`0x${bytesToHex(bytes)}`);

const equalHex = (left: string, right: string): boolean => {
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0 && left.length === right.length;
};

const configuredSubtle = (override: BrowserSubtleCrypto | undefined): BrowserSubtleCrypto => {
  if (override !== undefined) return override;
  const candidate = (globalThis as { readonly crypto?: { readonly subtle?: unknown } }).crypto
    ?.subtle;
  if (candidate === undefined) throw new VerifierError('INVALID_PROOF');
  return candidate as BrowserSubtleCrypto;
};

export const verifyPersistedRewardSelectionProof = async (
  inputValue: unknown,
  subtleOverride?: BrowserSubtleCrypto,
): Promise<PersistedRewardSelectionVerification> => {
  const input = objectWithFields(inputValue, [
    'algorithmVersion',
    'clientSeed',
    'configurationHash',
    'manifest',
    'nonce',
    'openedAt',
    'openingId',
    'recorded',
    'seedSetId',
    'serverSeedCommitment',
    'serverSeedHex',
    'specificationId',
    'verificationStatus',
  ]);
  if (input.algorithmVersion !== algorithmVersion || input.specificationId !== specificationId) {
    throw new VerifierError('UNSUPPORTED_ALGORITHM');
  }
  if (input.verificationStatus !== 'ready') throw new VerifierError('INVALID_PROOF');
  uuid(input.openingId);
  if (typeof input.openedAt !== 'string' || !Number.isFinite(Date.parse(input.openedAt))) {
    throw new VerifierError('INVALID_PROOF');
  }
  const serverSeedHex = hex256(input.serverSeedHex, 'INVALID_SERVER_SEED');
  const clientSeed = hex256(input.clientSeed, 'INVALID_CLIENT_SEED');
  const seedSetId = uuid(input.seedSetId);
  const nonce = decimal(input.nonce, false).toString();
  const expectedCommitment = hex256(input.serverSeedCommitment, 'INVALID_PROOF');
  const expectedManifestHash = hex256(input.configurationHash, 'INVALID_PROOF');
  const manifest = parseManifest(input.manifest);
  const recorded = objectWithFields(input.recorded, [
    'acceptedDigestHex',
    'acceptedRound',
    'boxVersionRewardId',
    'position',
    'rewardVersionId',
    'selectionValue',
  ]);
  const recordedDigest = hex256(recorded.acceptedDigestHex, 'INVALID_PROOF');
  const recordedRound = decimal(recorded.acceptedRound, false).toString();
  const recordedSelection = decimal(recorded.selectionValue, false).toString();
  const recordedBoxVersionRewardId = uuid(recorded.boxVersionRewardId);
  const recordedRewardVersionId = uuid(recorded.rewardVersionId);
  if (
    typeof recorded.position !== 'number' ||
    !Number.isSafeInteger(recorded.position) ||
    recorded.position < 0
  ) {
    throw new VerifierError('INVALID_PROOF');
  }

  const subtle = configuredSubtle(subtleOverride);
  const encoder = new TextEncoder();
  const serverSeed = hexToBytes(serverSeedHex);
  const commitment = bytesToHex(await subtle.digest('SHA-256', serverSeed));
  const manifestHash = bytesToHex(
    await subtle.digest('SHA-256', encoder.encode(canonicalManifest(manifest))),
  );
  const hmacKey = await subtle.importKey(
    'raw',
    serverSeed,
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign'],
  );
  const limit = unsigned256Range - (unsigned256Range % manifest.totalWeight);
  const sample = await (async () => {
    for (let round = 0n; ; round += 1n) {
      const digest = await subtle.sign(
        'HMAC',
        hmacKey,
        encoder.encode(
          `creatordrop:rng:v1|${seedSetId}|${clientSeed}|${nonce}|${round.toString()}`,
        ),
      );
      const candidate = bytesToBigint(digest);
      if (candidate < limit) {
        return {
          digestHex: bytesToHex(digest),
          round,
          selectionValue: candidate % manifest.totalWeight,
        };
      }
    }
  })();

  let cursor = 0n;
  let winner: ParsedEntry | undefined;
  for (const entry of manifest.entries) {
    const end = cursor + entry.weight;
    if (sample.selectionValue >= cursor && sample.selectionValue < end) winner = entry;
    cursor = end;
  }
  if (winner === undefined) throw new VerifierError('NO_SELECTABLE_REWARD');

  const computed = {
    acceptedDigestHex: sample.digestHex,
    acceptedRound: sample.round.toString(),
    boxVersionRewardId: winner.boxVersionRewardId,
    manifestHash,
    position: winner.position,
    rewardVersionId: winner.rewardVersionId,
    selectionValue: sample.selectionValue.toString(),
    serverSeedCommitment: commitment,
    totalWeight: manifest.totalWeightText,
  };
  const mismatches: PersistedProofMismatchCode[] = [];
  if (!equalHex(expectedCommitment, commitment)) mismatches.push('SERVER_SEED_COMMITMENT');
  if (!equalHex(expectedManifestHash, manifestHash)) mismatches.push('MANIFEST_HASH');
  if (recordedRound !== computed.acceptedRound) mismatches.push('ACCEPTED_ROUND');
  if (!equalHex(recordedDigest, computed.acceptedDigestHex)) mismatches.push('ACCEPTED_DIGEST');
  if (recordedSelection !== computed.selectionValue) mismatches.push('SELECTION_VALUE');
  if (recordedBoxVersionRewardId !== computed.boxVersionRewardId) {
    mismatches.push('BOX_VERSION_REWARD');
  }
  if (recordedRewardVersionId !== computed.rewardVersionId) mismatches.push('REWARD_VERSION');
  if (recorded.position !== computed.position) mismatches.push('POSITION');
  return { computed, mismatches, valid: mismatches.length === 0 };
};
