import type { XpReward, OpeningProgression } from './progression.js';
export * from './progression.js';
export const serviceStates = ['ok', 'ready'] as const;

export type ServiceState = (typeof serviceStates)[number];

export interface ServiceStatusResponse {
  readonly service: 'api';
  readonly status: ServiceState;
}

export const userStatuses = ['active', 'suspended', 'closed'] as const;

export type UserStatus = (typeof userStatuses)[number];

export interface AuthSessionResponse {
  readonly user: {
    readonly id: string;
    readonly status: UserStatus;
    readonly username: string;
  };
}

export interface ApiErrorResponse {
  readonly error: {
    readonly code: string;
    readonly details: Readonly<Record<string, unknown>>;
    readonly message: string;
    readonly requestId: string;
  };
}

export const creatorRoles = ['owner', 'manager', 'editor', 'viewer'] as const;
export type CreatorRole = (typeof creatorRoles)[number];

export const creatorStatuses = ['active', 'suspended', 'closed'] as const;
export type CreatorStatus = (typeof creatorStatuses)[number];

export interface CreatorContract {
  readonly createdAt: string;
  readonly customSlug: string;
  readonly displayName: string;
  readonly handle: string;
  readonly id: string;
  readonly revision: number;
  readonly status: CreatorStatus;
  readonly updatedAt: string;
}

export interface CreatorWorkspaceResponse {
  readonly creator: CreatorContract & { readonly role: CreatorRole };
}

export interface CreatorWorkspaceMembershipsResponse {
  readonly memberships: readonly {
    readonly creator: CreatorContract;
    readonly joinedAt: string;
    readonly role: CreatorRole;
  }[];
}

export interface CreatorMemberContract {
  readonly createdAt: string;
  readonly role: CreatorRole;
  readonly updatedAt: string;
  readonly user: {
    readonly id: string;
    readonly username: string;
  };
}

export interface CreatorMembersResponse {
  readonly members: readonly CreatorMemberContract[];
}

export interface CreatorMemberResponse {
  readonly member: CreatorMemberContract;
}

export const boxStatuses = ['draft', 'active', 'paused', 'archived'] as const;
export type BoxStatus = (typeof boxStatuses)[number];

export const boxVersionStates = ['draft', 'published', 'retired'] as const;
export type BoxVersionState = (typeof boxVersionStates)[number];

export const rewardStatuses = ['active', 'archived'] as const;
export type RewardStatus = (typeof rewardStatuses)[number];

export const rewardVersionStates = ['draft', 'published', 'retired'] as const;
export type RewardVersionState = (typeof rewardVersionStates)[number];

export const rewardTypes = ['digital', 'physical', 'experience', 'xp'] as const;
export type RewardType = (typeof rewardTypes)[number];

export const inventoryModes = ['unlimited', 'finite'] as const;
export type InventoryMode = (typeof inventoryModes)[number];

export const inventoryStockoutPolicies = ['pause_box', 'backorder'] as const;
export type InventoryStockoutPolicy = (typeof inventoryStockoutPolicies)[number];

export const rewardRarities = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;
export type RewardRarity = (typeof rewardRarities)[number];
export const rarityPolicyVersions = ['rarity-v1'] as const;
export type RarityPolicyVersion = (typeof rarityPolicyVersions)[number];

interface BoxVersionContractBase {
  readonly configurationHash: string | null;
  readonly createdAt: string;
  readonly description: string;
  readonly id: string;
  readonly imageUrl: string | null;
  readonly name: string;
  readonly publishedAt: string | null;
  readonly rngAlgorithmVersion: string | null;
  readonly state: BoxVersionState;
  readonly totalWeight: string | null;
  readonly updatedAt: string;
  readonly versionNumber: number;
}

export interface LegacyBoxVersionContract extends BoxVersionContractBase {
  readonly currency: string;
  readonly maxOpeningsPerUser: null;
  readonly openingCompatibilityVersion: 'opening-v1' | null;
  readonly priceMinor: string;
}

export interface OpeningV2BoxVersionContract extends BoxVersionContractBase {
  readonly currency: null;
  readonly maxOpeningsPerUser: string;
  readonly openingCompatibilityVersion: 'opening-v2';
  readonly priceMinor: null;
}

export type BoxVersionContract = LegacyBoxVersionContract | OpeningV2BoxVersionContract;

export interface BoxContract {
  readonly createdAt: string;
  readonly creatorId: string;
  readonly currentPublishedVersionId: string | null;
  readonly draft: BoxVersionContract | null;
  readonly id: string;
  readonly revision: number;
  readonly role: CreatorRole;
  readonly status: BoxStatus;
  readonly updatedAt: string;
}

export interface RewardVersionContract {
  readonly xpReward?: XpReward | undefined;
  readonly createdAt: string;
  readonly declaredValueCurrency: string | null;
  readonly declaredValueMinor: string | null;
  readonly description: string;
  readonly id: string;
  readonly imageUrl: string | null;
  readonly inventoryMode: InventoryMode;
  readonly inventoryQuantity: string | null;
  readonly inventoryStockoutPolicy: InventoryStockoutPolicy | null;
  readonly name: string;
  readonly publishedAt: string | null;
  readonly rewardType: RewardType;
  readonly state: RewardVersionState;
  readonly updatedAt: string;
  readonly versionNumber: number;
}

export interface RewardContract {
  readonly createdAt: string;
  readonly creatorId: string;
  readonly draft: RewardVersionContract | null;
  readonly id: string;
  readonly revision: number;
  readonly role: CreatorRole;
  readonly status: RewardStatus;
  readonly updatedAt: string;
}

export interface BoxResponse {
  readonly box: BoxContract;
}

export interface BoxesResponse {
  readonly boxes: readonly BoxContract[];
}

export interface RewardResponse {
  readonly reward: RewardContract;
}

export interface RewardsResponse {
  readonly rewards: readonly RewardContract[];
}

export interface BoxVersionResponse {
  readonly version: BoxVersionContract;
}

export interface BoxVersionsResponse {
  readonly versions: readonly BoxVersionContract[];
}

export interface RewardVersionsResponse {
  readonly versions: readonly RewardVersionContract[];
}

export interface BoxDraftRewardContract {
  readonly id: string;
  readonly isBaseReward: boolean;
  readonly position: number;
  readonly rarity: RewardRarity | null;
  readonly rarityPolicyVersion: RarityPolicyVersion | null;
  readonly rewardVersion: RewardVersionContract;
  readonly weight: string;
}

export interface BoxDraftRewardsResponse {
  readonly entries: readonly BoxDraftRewardContract[];
}

export interface PublishedManifestContract {
  readonly algorithmVersion: 'hmac-sha256-rejection-v1';
  readonly boxId: string;
  readonly boxVersionId: string;
  readonly currency: string;
  readonly entries: readonly {
    readonly boxVersionRewardId: string;
    readonly position: number;
    readonly rewardVersionId: string;
    readonly weight: string;
  }[];
  readonly priceMinor: string;
  readonly totalWeight: string;
}

export interface OpeningV2PublishedManifestContract {
  readonly algorithmVersion: 'hmac-sha256-rejection-v1';
  readonly boxId: string;
  readonly boxVersionId: string;
  readonly entries: readonly {
    readonly boxVersionRewardId: string;
    readonly position: number;
    readonly rarity: RewardRarity;
    readonly rarityPolicyVersion: 'rarity-v1';
    readonly xpReward?: XpReward | undefined;
    readonly rewardVersionId: string;
    readonly weight: string;
  }[];
  readonly maxOpeningsPerUser: string;
  readonly openingCompatibilityVersion: 'opening-v2';
  readonly totalWeight: string;
}

export type VersionedPublishedManifestContract =
  PublishedManifestContract | OpeningV2PublishedManifestContract;

export interface PublishedBoxVersionResponse {
  readonly configurationHash: string;
  readonly entries: readonly BoxDraftRewardContract[];
  readonly manifest: VersionedPublishedManifestContract;
  readonly version: BoxVersionContract;
}

export interface PublicCreatorSummaryContract {
  readonly customSlug: string;
  readonly displayName: string;
  readonly handle: string;
}

interface PublicBoxSummaryBase {
  readonly configurationHash: string;
  readonly currentPublishedVersionId: string;
  readonly description: string;
  readonly id: string;
  readonly imageUrl: string | null;
  readonly name: string;
  readonly publishedAt: string;
  readonly versionNumber: number;
}

export type PublicBoxSummaryContract =
  | (PublicBoxSummaryBase & {
      readonly availability: 'legacy' | 'openable';
      readonly currency: string;
      readonly maxOpeningsPerUser: null;
      readonly openingCompatibilityVersion: 'opening-v1' | null;
      readonly priceMinor: string;
    })
  | (PublicBoxSummaryBase & {
      readonly availability: 'opening-v2';
      readonly currency: null;
      readonly maxOpeningsPerUser: string;
      readonly openingCompatibilityVersion: 'opening-v2';
      readonly priceMinor: null;
    });

export interface PublicCreatorsResponse {
  readonly creators: readonly PublicCreatorSummaryContract[];
  readonly nextCursor: string | null;
}

export interface PublicCreatorResponse {
  readonly creator: PublicCreatorSummaryContract;
}

export interface PublicCreatorBoxResponse {
  readonly box: PublishedBoxVersionResponse;
  readonly creator: PublicCreatorSummaryContract;
}

export interface PublicCreatorBoxesResponse {
  readonly boxes: readonly PublicBoxSummaryContract[];
  readonly nextCursor: string | null;
}

export interface PublicLeaderboardEntryContract {
  readonly baseRewardWins: string;
  readonly points: string;
  readonly rank: number;
  readonly scoreReachedAt: string;
  readonly totalOpenings: string;
  readonly user: {
    readonly username: string;
  };
}

export interface PublicLeaderboardSeasonContract {
  readonly endsAt: string;
  readonly finalizedAt: string | null;
  readonly id: string;
  readonly name: string;
  readonly ordinal: number;
  readonly startsAt: string;
  readonly status: 'active' | 'finalized' | 'scheduled';
}

export interface PublicLeaderboardResponse {
  readonly asOf: string;
  readonly entries: readonly PublicLeaderboardEntryContract[];
  readonly season: PublicLeaderboardSeasonContract | null;
  readonly source: 'postgres' | 'redis';
}

export interface PublicAchievementContract {
  readonly achievementType: 'creator_season_champion' | 'global_season_champion';
  readonly awardedAt: string;
  readonly creatorId: string | null;
  readonly season: {
    readonly id: string;
    readonly name: string;
  };
}

export interface PublicAchievementsResponse {
  readonly achievements: readonly PublicAchievementContract[];
  readonly user: {
    readonly username: string;
  };
}

export const rngSeedSetStatuses = ['active', 'retired', 'revealed', 'compromised'] as const;
export type RngSeedSetStatus = (typeof rngSeedSetStatuses)[number];

export interface PublicRngSeedSetContract {
  readonly algorithmVersion: 'hmac-sha256-rejection-v1';
  readonly commitment: string;
  readonly compromisedAt: string | null;
  readonly createdAt: string;
  readonly id: string;
  readonly maxNonceExclusive: string;
  readonly nextNonce: string;
  readonly retiredAt: string | null;
  readonly revealedAt: string | null;
  readonly revealedServerSeed: string | null;
  readonly rotateAfter: string;
  readonly status: RngSeedSetStatus;
}

export interface CurrentFairnessResponse {
  readonly fairness: {
    readonly activeSeedSet: PublicRngSeedSetContract;
    readonly clientSeed: string | null;
    readonly revision: number;
    readonly rotationPolicy: {
      readonly maxAgeMs: number;
      readonly maxOpenings: string;
    };
  };
}

export interface PublicRngSeedSetResponse {
  readonly seedSet: PublicRngSeedSetContract;
}

export interface RngSeedRotationResponse {
  readonly newSeedSet: PublicRngSeedSetContract;
  readonly previousSeedSetId: string;
  readonly replayed: boolean;
}

export interface WalletContract {
  readonly balanceMinor: string;
  readonly currency: string;
  readonly id: string;
  readonly revision: string;
}

export interface WalletsResponse {
  readonly wallets: readonly WalletContract[];
}

export interface WalletTestCreditResponse {
  readonly wallet: WalletContract;
}

export interface WalletFundingIntentResponse {
  readonly fundingIntent: {
    readonly amountMinor: string;
    readonly clientSecret: string;
    readonly currency: 'USD';
    readonly fundingIntentId: string;
  };
}

interface BoxOpeningFairnessContract {
  readonly clientSeed: string;
  readonly commitment: string;
  readonly configurationHash: string;
  readonly nonce: string;
  readonly seedSetId: string;
}

interface BoxOpeningRewardContract {
  readonly id: string;
  readonly imageUrl: string | null;
  readonly name: string;
  readonly rarity: RewardRarity | null;
  readonly rarityPolicyVersion: RarityPolicyVersion | null;
  readonly rewardVersionId: string;
}

export interface OpeningV2EntitlementStateContract {
  readonly universalEntriesAvailable?: string | undefined;
  readonly source?: 'creator' | 'universal' | null | undefined;
  readonly available: boolean;
  readonly boxId: string;
  readonly consumed: string;
  readonly granted: string;
  readonly limitReached: boolean;
  readonly maxOpeningsPerUser: string;
  readonly remaining: string;
  readonly successfulOpenings: string;
}

export interface OpeningV2EntitlementStateResponse {
  readonly entitlement: OpeningV2EntitlementStateContract;
}

interface PaidBoxOpeningContract {
  readonly boxId: string;
  readonly boxVersionId: string;
  readonly cost: {
    readonly currency: string;
    readonly priceMinor: string;
  };
  readonly fairness: BoxOpeningFairnessContract;
  readonly fulfillmentStatus: 'awaiting_restock' | 'pending_fulfillment';
  readonly id: string;
  readonly pointsAwarded: 5 | 20;
  readonly reward: BoxOpeningRewardContract;
  readonly wallet: WalletContract;
}

interface EntitlementBoxOpeningContract {
  readonly progression?: OpeningProgression | undefined;
  readonly boxId: string;
  readonly boxVersionId: string;
  readonly entitlement: {
    readonly source?: 'creator' | 'universal' | undefined;
    readonly universalEntriesRemaining?: string | undefined;
    readonly maxOpeningsPerUser: string;
    readonly remaining: string;
    readonly successfulOpenings: string;
  };
  readonly fairness: BoxOpeningFairnessContract;
  readonly fulfillmentStatus: 'awaiting_restock' | 'pending_fulfillment' | 'not_required';
  readonly id: string;
  readonly openingCompatibilityVersion: 'opening-v2';
  readonly reward: Omit<BoxOpeningRewardContract, 'rarity' | 'rarityPolicyVersion'> & {
    readonly rarity: RewardRarity;
    readonly rarityPolicyVersion: 'rarity-v1';
    readonly xpReward?: XpReward | undefined;
  };
}

export interface BoxOpeningResponse {
  readonly opening: PaidBoxOpeningContract | EntitlementBoxOpeningContract;
}

export interface OpeningFairnessProofResponse {
  readonly proof: {
    readonly algorithmVersion: 'hmac-sha256-rejection-v1';
    readonly clientSeed: string;
    readonly configurationHash: string;
    readonly manifest: VersionedPublishedManifestContract;
    readonly nonce: string;
    readonly openedAt: string;
    readonly openingId: string;
    readonly recorded: {
      readonly acceptedDigestHex: string;
      readonly acceptedRound: string;
      readonly boxVersionRewardId: string;
      readonly position: number;
      readonly rewardVersionId: string;
      readonly selectionValue: string;
    };
    readonly seedSetId: string;
    readonly serverSeedCommitment: string;
    readonly serverSeedHex?: string;
    readonly specificationId: 'creatordrop-rng-hmac-sha256-rejection-v1';
    readonly verificationStatus: 'pending_reveal' | 'ready' | 'unverifiable';
  };
}

export const fulfillmentTypes = ['physical', 'digital', 'experience'] as const;
export type FulfillmentType = (typeof fulfillmentTypes)[number];

export const fulfillmentStates = [
  'awaiting_restock',
  'awaiting_address',
  'ready_to_ship',
  'shipped',
  'delivered',
  'ready_for_delivery',
  'coordination_required',
  'fulfilled',
] as const;
export type FulfillmentState = (typeof fulfillmentStates)[number];

export interface FulfillmentEventContract {
  readonly action: string;
  readonly actorType: 'system' | 'user' | 'creator';
  readonly createdAt: string;
  readonly fromState: FulfillmentState | null;
  readonly id: string;
  readonly revision: number;
  readonly toState: FulfillmentState;
}

export interface FulfillmentContract {
  readonly createdAt: string;
  readonly creatorId: string;
  readonly deliveryData: {
    readonly available: boolean;
    readonly expiresAt: string | null;
    readonly redactedAt: string | null;
  };
  readonly deliveredAt: string | null;
  readonly events: readonly FulfillmentEventContract[];
  readonly fulfilledAt: string | null;
  readonly fulfillmentType: FulfillmentType;
  readonly id: string;
  readonly openingId: string;
  readonly revision: number;
  readonly reward: {
    readonly imageUrl: string | null;
    readonly name: string;
    readonly rewardId: string;
    readonly rewardVersionId: string;
  };
  readonly shippedAt: string | null;
  readonly state: FulfillmentState;
  readonly updatedAt: string;
}

export interface FulfillmentResponse {
  readonly fulfillment: FulfillmentContract;
  readonly replayed?: boolean;
}

export interface FulfillmentsResponse {
  readonly fulfillments: readonly FulfillmentContract[];
}

export interface FulfillmentAddressContract {
  readonly addressLine1: string;
  readonly addressLine2: string | null;
  readonly city: string;
  readonly country: string;
  readonly postalCode: string;
  readonly recipientName: string;
  readonly region: string;
}

export interface FulfillmentDeliveryDataResponse {
  readonly address?: FulfillmentAddressContract;
  readonly digitalSecret?: string;
  readonly expiresAt: string | null;
  readonly fulfillmentId: string;
}

export interface InventoryRestockResponse {
  readonly inventoryPool: {
    readonly availableQuantity: string;
    readonly id: string;
    readonly initialQuantity: string;
  };
  readonly restockEvent: {
    readonly createdAt: string;
    readonly id: string;
    readonly quantityAdded: string;
  };
  readonly replayed: boolean;
}

export * from './realtime.js';
export * from './entry.js';
export * from './usage.js';
