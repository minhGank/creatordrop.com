import type {
  AuthSessionResponse,
  BoxOpeningResponse,
  CurrentFairnessResponse,
  OpeningFairnessProofResponse,
  PublishedBoxVersionResponse,
  PublicCreatorBoxesResponse,
  PublicCreatorResponse,
  PublicCreatorsResponse,
} from '@creatordrop/contracts';

export const creatorFixture = {
  customSlug: 'creator-one',
  displayName: 'Creator One',
  handle: 'creator_one',
} as const;

export const publicCreatorResponseFixture: PublicCreatorResponse = {
  creator: creatorFixture,
};

export const publicCreatorsResponseFixture: PublicCreatorsResponse = {
  creators: [creatorFixture],
  nextCursor: null,
};

export const publicCreatorBoxesResponseFixture: PublicCreatorBoxesResponse = {
  boxes: [
    {
      availability: 'opening-v2',
      configurationHash: '9'.repeat(64),
      currency: null,
      currentPublishedVersionId: '00000000-0000-4000-8000-000000000504',
      description: 'A free-entry Drop.',
      id: '00000000-0000-4000-8000-000000000503',
      imageUrl: null,
      maxOpeningsPerUser: '3',
      name: 'Free Drop',
      openingCompatibilityVersion: 'opening-v2',
      priceMinor: null,
      publishedAt: '2026-09-07T00:00:00.000Z',
      versionNumber: 1,
    },
  ],
  nextCursor: null,
};

export const authSessionResponseFixture: AuthSessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    status: 'active',
    username: 'public-fan',
  },
};

const firstEntryId = '00000000-0000-4000-8000-000000000201';
const secondEntryId = '00000000-0000-4000-8000-000000000202';
const firstRewardVersionId = '00000000-0000-4000-8000-000000000301';
const secondRewardVersionId = '00000000-0000-4000-8000-000000000302';

const rewardVersion = (
  id: string,
  name: string,
  description: string,
): PublishedBoxVersionResponse['entries'][number]['rewardVersion'] => ({
  createdAt: '2026-09-02T11:00:00.000Z',
  declaredValueCurrency: 'USD',
  declaredValueMinor: '2500',
  description,
  id,
  imageUrl: null,
  inventoryMode: 'unlimited',
  inventoryQuantity: null,
  inventoryStockoutPolicy: null,
  name,
  publishedAt: '2026-09-02T12:00:00.000Z',
  rewardType: 'digital',
  state: 'published',
  updatedAt: '2026-09-02T12:00:00.000Z',
  versionNumber: 1,
});

export const publishedBoxFixture: PublishedBoxVersionResponse = {
  configurationHash: 'a'.repeat(64),
  entries: [
    {
      id: firstEntryId,
      isBaseReward: false,
      position: 0,
      rarity: null,
      rarityPolicyVersion: null,
      rewardVersion: rewardVersion(firstRewardVersionId, 'Rare reward', 'One tiny exact weight.'),
      weight: '1',
    },
    {
      id: secondEntryId,
      isBaseReward: true,
      position: 1,
      rarity: 'common',
      rarityPolicyVersion: 'rarity-v1',
      rewardVersion: rewardVersion(
        secondRewardVersionId,
        'Base reward',
        'The explicitly designated base reward.',
      ),
      weight: '999999999',
    },
  ],
  manifest: {
    algorithmVersion: 'hmac-sha256-rejection-v1',
    boxId: '00000000-0000-4000-8000-000000000101',
    boxVersionId: '00000000-0000-4000-8000-000000000102',
    currency: 'USD',
    entries: [
      {
        boxVersionRewardId: firstEntryId,
        position: 0,
        rewardVersionId: firstRewardVersionId,
        weight: '1',
      },
      {
        boxVersionRewardId: secondEntryId,
        position: 1,
        rewardVersionId: secondRewardVersionId,
        weight: '999999999',
      },
    ],
    priceMinor: '999',
    totalWeight: '1000000000',
  },
  version: {
    configurationHash: 'a'.repeat(64),
    createdAt: '2026-09-02T11:00:00.000Z',
    currency: 'USD',
    description: 'A published box with exact integer weights.',
    id: '00000000-0000-4000-8000-000000000102',
    imageUrl: null,
    maxOpeningsPerUser: null,
    name: 'First Drop',
    openingCompatibilityVersion: 'opening-v1',
    priceMinor: '999',
    publishedAt: '2026-09-02T12:00:00.000Z',
    rngAlgorithmVersion: 'hmac-sha256-rejection-v1',
    state: 'published',
    totalWeight: '1000000000',
    updatedAt: '2026-09-02T12:00:00.000Z',
    versionNumber: 2,
  },
};

const currentClientSeedFixture = 'c'.repeat(64);

export const currentFairnessFixture: CurrentFairnessResponse = {
  fairness: {
    activeSeedSet: {
      algorithmVersion: 'hmac-sha256-rejection-v1',
      commitment: 'b'.repeat(64),
      compromisedAt: null,
      createdAt: '2026-09-05T00:00:00.000Z',
      id: '00000000-0000-4000-8000-000000000401',
      maxNonceExclusive: '1000',
      nextNonce: '0',
      retiredAt: null,
      revealedAt: null,
      revealedServerSeed: null,
      rotateAfter: '2026-09-06T00:00:00.000Z',
      status: 'active',
    },
    clientSeed: currentClientSeedFixture,
    revision: 1,
    rotationPolicy: { maxAgeMs: 86_400_000, maxOpenings: '1000' },
  },
};

export const boxOpeningFixture: BoxOpeningResponse = {
  opening: {
    boxId: publishedBoxFixture.manifest.boxId,
    boxVersionId: publishedBoxFixture.manifest.boxVersionId,
    cost: { currency: 'USD', priceMinor: '999' },
    fairness: {
      clientSeed: currentClientSeedFixture,
      commitment: currentFairnessFixture.fairness.activeSeedSet.commitment,
      configurationHash: publishedBoxFixture.configurationHash,
      nonce: '0',
      seedSetId: currentFairnessFixture.fairness.activeSeedSet.id,
    },
    fulfillmentStatus: 'pending_fulfillment',
    id: '00000000-0000-4000-8000-000000000402',
    pointsAwarded: 20,
    reward: {
      id: '00000000-0000-4000-8000-000000000403',
      imageUrl: null,
      name: publishedBoxFixture.entries[1]?.rewardVersion.name ?? 'Base reward',
      rarity: 'common',
      rarityPolicyVersion: 'rarity-v1',
      rewardVersionId: secondRewardVersionId,
    },
    wallet: {
      balanceMinor: '9001',
      currency: 'USD',
      id: '00000000-0000-4000-8000-000000000404',
      revision: '2',
    },
  },
};

export const openingV2BoxFixture: PublishedBoxVersionResponse = {
  configurationHash: '9'.repeat(64),
  entries: [
    {
      id: '00000000-0000-4000-8000-000000000501',
      isBaseReward: false,
      position: 0,
      rarity: 'common',
      rarityPolicyVersion: 'rarity-v1',
      rewardVersion: rewardVersion(
        '00000000-0000-4000-8000-000000000502',
        'Free Drop reward',
        'An entitlement-backed reward.',
      ),
      weight: '1',
    },
  ],
  manifest: {
    algorithmVersion: 'hmac-sha256-rejection-v1',
    boxId: '00000000-0000-4000-8000-000000000503',
    boxVersionId: '00000000-0000-4000-8000-000000000504',
    entries: [
      {
        boxVersionRewardId: '00000000-0000-4000-8000-000000000501',
        position: 0,
        rarity: 'common',
        rarityPolicyVersion: 'rarity-v1',
        rewardVersionId: '00000000-0000-4000-8000-000000000502',
        weight: '1',
      },
    ],
    maxOpeningsPerUser: '3',
    openingCompatibilityVersion: 'opening-v2',
    totalWeight: '1',
  },
  version: {
    configurationHash: '9'.repeat(64),
    createdAt: '2026-09-07T00:00:00.000Z',
    currency: null,
    description: 'A free-entry opening-v2 fixture.',
    id: '00000000-0000-4000-8000-000000000504',
    imageUrl: null,
    maxOpeningsPerUser: '3',
    name: 'Free Drop',
    openingCompatibilityVersion: 'opening-v2',
    priceMinor: null,
    publishedAt: '2026-09-07T00:00:00.000Z',
    rngAlgorithmVersion: 'hmac-sha256-rejection-v1',
    state: 'published',
    totalWeight: '1',
    updatedAt: '2026-09-07T00:00:00.000Z',
    versionNumber: 1,
  },
};

export const openingV2ResponseFixture: BoxOpeningResponse = {
  opening: {
    boxId: openingV2BoxFixture.manifest.boxId,
    boxVersionId: openingV2BoxFixture.manifest.boxVersionId,
    entitlement: { maxOpeningsPerUser: '3', remaining: '1', successfulOpenings: '1' },
    fairness: {
      clientSeed: currentClientSeedFixture,
      commitment: currentFairnessFixture.fairness.activeSeedSet.commitment,
      configurationHash: openingV2BoxFixture.configurationHash,
      nonce: '0',
      seedSetId: currentFairnessFixture.fairness.activeSeedSet.id,
    },
    fulfillmentStatus: 'pending_fulfillment',
    id: '00000000-0000-4000-8000-000000000505',
    openingCompatibilityVersion: 'opening-v2',
    reward: {
      id: '00000000-0000-4000-8000-000000000506',
      imageUrl: null,
      name: 'Free Drop reward',
      rarity: 'common',
      rarityPolicyVersion: 'rarity-v1',
      rewardVersionId: '00000000-0000-4000-8000-000000000502',
    },
  },
};

export const pendingOpeningV2ProofFixture: OpeningFairnessProofResponse = {
  proof: {
    algorithmVersion: 'hmac-sha256-rejection-v1',
    clientSeed: currentClientSeedFixture,
    configurationHash: openingV2BoxFixture.configurationHash,
    manifest: openingV2BoxFixture.manifest,
    nonce: '0',
    openedAt: '2026-09-07T00:01:00.000Z',
    openingId: openingV2ResponseFixture.opening.id,
    recorded: {
      acceptedDigestHex: 'd'.repeat(64),
      acceptedRound: '0',
      boxVersionRewardId: '00000000-0000-4000-8000-000000000501',
      position: 0,
      rewardVersionId: '00000000-0000-4000-8000-000000000502',
      selectionValue: '0',
    },
    seedSetId: currentFairnessFixture.fairness.activeSeedSet.id,
    serverSeedCommitment: currentFairnessFixture.fairness.activeSeedSet.commitment,
    specificationId: 'creatordrop-rng-hmac-sha256-rejection-v1',
    verificationStatus: 'pending_reveal',
  },
};

export const pendingOpeningProofFixture: OpeningFairnessProofResponse = {
  proof: {
    algorithmVersion: 'hmac-sha256-rejection-v1',
    clientSeed: currentClientSeedFixture,
    configurationHash: publishedBoxFixture.configurationHash,
    manifest: publishedBoxFixture.manifest,
    nonce: '0',
    openedAt: '2026-09-05T00:01:00.000Z',
    openingId: boxOpeningFixture.opening.id,
    recorded: {
      acceptedDigestHex: 'd'.repeat(64),
      acceptedRound: '0',
      boxVersionRewardId: secondEntryId,
      position: 1,
      rewardVersionId: secondRewardVersionId,
      selectionValue: '999',
    },
    seedSetId: currentFairnessFixture.fairness.activeSeedSet.id,
    serverSeedCommitment: currentFairnessFixture.fairness.activeSeedSet.commitment,
    specificationId: 'creatordrop-rng-hmac-sha256-rejection-v1',
    verificationStatus: 'pending_reveal',
  },
};
