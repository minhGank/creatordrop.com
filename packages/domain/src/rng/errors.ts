export const rngErrorCodes = [
  'UNSUPPORTED_ALGORITHM',
  'INVALID_SERVER_SEED',
  'INVALID_CLIENT_SEED',
  'INVALID_SEED_SET_ID',
  'INVALID_NONCE',
  'INVALID_DIGEST',
  'MALFORMED_MANIFEST',
  'MANIFEST_HASH_MISMATCH',
  'INVALID_WEIGHT',
  'TOTAL_WEIGHT_MISMATCH',
  'WEIGHT_OVERFLOW',
  'NO_SELECTABLE_REWARD',
] as const;

export type RngErrorCode = (typeof rngErrorCodes)[number];

const messages: Readonly<Record<RngErrorCode, string>> = {
  INVALID_CLIENT_SEED: 'The client seed is invalid.',
  INVALID_DIGEST: 'The digest source returned an invalid digest.',
  INVALID_NONCE: 'The nonce is invalid.',
  INVALID_SEED_SET_ID: 'The seed-set identifier is invalid.',
  INVALID_SERVER_SEED: 'The server seed is invalid.',
  INVALID_WEIGHT: 'A probability weight is invalid.',
  MALFORMED_MANIFEST: 'The published manifest is malformed.',
  MANIFEST_HASH_MISMATCH: 'The published manifest hash does not match.',
  NO_SELECTABLE_REWARD: 'The manifest has no selectable reward.',
  TOTAL_WEIGHT_MISMATCH: 'The manifest total weight does not match its entries.',
  UNSUPPORTED_ALGORITHM: 'The RNG algorithm version is unsupported.',
  WEIGHT_OVERFLOW: 'The probability weight total exceeds supported storage.',
};

export class RngError extends Error {
  readonly code: RngErrorCode;

  constructor(code: RngErrorCode) {
    super(messages[code]);
    this.name = 'RngError';
    this.code = code;
  }
}
