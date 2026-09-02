import type {
  AuthSessionResponse,
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
      availability: 'openable',
      configurationHash: 'a'.repeat(64),
      currency: 'USD',
      currentPublishedVersionId: '00000000-0000-4000-8000-000000000102',
      description: 'A published box.',
      id: '00000000-0000-4000-8000-000000000101',
      imageUrl: null,
      name: 'First Drop',
      openingCompatibilityVersion: 'opening-v1',
      priceMinor: '999',
      publishedAt: '2026-09-02T12:00:00.000Z',
      versionNumber: 2,
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
      rewardVersion: rewardVersion(firstRewardVersionId, 'Rare reward', 'One tiny exact weight.'),
      weight: '1',
    },
    {
      id: secondEntryId,
      isBaseReward: true,
      position: 1,
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
