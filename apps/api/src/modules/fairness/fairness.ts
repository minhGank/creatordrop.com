import type { UserId } from '../creators/creator.js';

export const rngSeedSetStatuses = ['active', 'retired', 'revealed', 'compromised'] as const;
export type RngSeedSetStatus = (typeof rngSeedSetStatuses)[number];

export type RngSeedSetId = string & { readonly __brand: 'RngSeedSetId' };
export type RngRotationId = string & { readonly __brand: 'RngRotationId' };
export type ClientSeed = string & { readonly __brand: 'ClientSeed' };
export type Nonce = bigint & { readonly __brand: 'Nonce' };

export interface FairnessProfile {
  readonly clientSeed: ClientSeed | null;
  readonly createdAt: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly userId: UserId;
}

export interface PublicSeedSet {
  readonly algorithmVersion: 'hmac-sha256-rejection-v1';
  readonly commitment: string;
  readonly compromisedAt: string | null;
  readonly createdAt: string;
  readonly id: RngSeedSetId;
  readonly maxNonceExclusive: string;
  readonly nextNonce: string;
  readonly retiredAt: string | null;
  readonly revealedAt: string | null;
  readonly revealedServerSeed: string | null;
  readonly rotateAfter: string;
  readonly status: RngSeedSetStatus;
}

export interface CurrentFairnessState {
  readonly activeSeedSet: PublicSeedSet;
  readonly clientSeed: ClientSeed | null;
  readonly revision: number;
  readonly rotationPolicy: {
    readonly maxAgeMs: number;
    readonly maxOpenings: string;
  };
}

export interface EncryptedSeedSet extends PublicSeedSet {
  readonly authenticationTag: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly encryptionIv: Uint8Array;
  readonly encryptionKeyIdentity: string | null;
  readonly encryptionKeyVersion: string;
  readonly retirementReason: string | null;
  readonly userId: UserId;
}

export interface NonceAllocation {
  readonly algorithmVersion: 'hmac-sha256-rejection-v1';
  readonly clientSeed: ClientSeed;
  readonly nonce: Nonce;
  readonly seedSetId: RngSeedSetId;
  readonly serverSeedCommitment: string;
}

export interface SeedRotationResult {
  readonly newSeedSet: PublicSeedSet;
  readonly previousSeedSetId: RngSeedSetId;
  readonly replayed: boolean;
}

export const toPublicSeedSet = (seedSet: PublicSeedSet): PublicSeedSet => {
  if (
    (seedSet.status === 'revealed' && seedSet.revealedServerSeed === null) ||
    (seedSet.status !== 'revealed' && seedSet.revealedServerSeed !== null)
  ) {
    throw new Error('RNG seed-set public state is inconsistent.');
  }
  return {
    algorithmVersion: seedSet.algorithmVersion,
    commitment: seedSet.commitment,
    compromisedAt: seedSet.compromisedAt,
    createdAt: seedSet.createdAt,
    id: seedSet.id,
    maxNonceExclusive: seedSet.maxNonceExclusive,
    nextNonce: seedSet.nextNonce,
    retiredAt: seedSet.retiredAt,
    revealedAt: seedSet.revealedAt,
    revealedServerSeed: seedSet.status === 'revealed' ? seedSet.revealedServerSeed : null,
    rotateAfter: seedSet.rotateAfter,
    status: seedSet.status,
  };
};
