export { VerifierError, verifierErrorCodes, type VerifierErrorCode } from './errors.js';
export {
  proofMismatchCodes,
  type ProofMismatchCode,
  type RecordedRewardSelection,
  type RewardSelectionProofInput,
  type RewardSelectionVerification,
  type VerifiedRewardSelection,
} from './types.js';
export { verifyRewardSelectionProof } from './verifier.js';
