export const verifierErrorCodes = [
  'UNSUPPORTED_ALGORITHM',
  'INVALID_SERVER_SEED',
  'INVALID_CLIENT_SEED',
  'INVALID_SEED_SET_ID',
  'INVALID_NONCE',
  'MALFORMED_MANIFEST',
  'INVALID_PROOF',
  'INVALID_WEIGHT',
  'TOTAL_WEIGHT_MISMATCH',
  'WEIGHT_OVERFLOW',
  'NO_SELECTABLE_REWARD',
] as const;

export type VerifierErrorCode = (typeof verifierErrorCodes)[number];

export class VerifierError extends Error {
  readonly code: VerifierErrorCode;

  constructor(code: VerifierErrorCode) {
    super('The fairness proof input is invalid.');
    this.name = 'VerifierError';
    this.code = code;
  }
}
