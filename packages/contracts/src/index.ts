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

export const rewardTypes = ['digital', 'physical', 'experience'] as const;
export type RewardType = (typeof rewardTypes)[number];

export const inventoryModes = ['unlimited', 'finite'] as const;
export type InventoryMode = (typeof inventoryModes)[number];

export const inventoryStockoutPolicies = ['pause_box', 'backorder'] as const;
export type InventoryStockoutPolicy = (typeof inventoryStockoutPolicies)[number];

export interface BoxVersionContract {
  readonly configurationHash: string | null;
  readonly createdAt: string;
  readonly currency: string;
  readonly description: string;
  readonly id: string;
  readonly imageUrl: string | null;
  readonly name: string;
  readonly openingCompatibilityVersion: 'opening-v1' | null;
  readonly priceMinor: string;
  readonly publishedAt: string | null;
  readonly rngAlgorithmVersion: string | null;
  readonly state: BoxVersionState;
  readonly totalWeight: string | null;
  readonly updatedAt: string;
  readonly versionNumber: number;
}

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

export interface PublishedBoxVersionResponse {
  readonly configurationHash: string;
  readonly entries: readonly BoxDraftRewardContract[];
  readonly manifest: PublishedManifestContract;
  readonly version: BoxVersionContract;
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
    readonly clientSeed: string;
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

export interface BoxOpeningResponse {
  readonly opening: {
    readonly boxId: string;
    readonly boxVersionId: string;
    readonly cost: {
      readonly currency: string;
      readonly priceMinor: string;
    };
    readonly fairness: {
      readonly clientSeed: string;
      readonly commitment: string;
      readonly configurationHash: string;
      readonly nonce: string;
      readonly seedSetId: string;
    };
    readonly fulfillmentStatus: 'awaiting_restock' | 'pending_fulfillment';
    readonly id: string;
    readonly pointsAwarded: 5 | 20;
    readonly reward: {
      readonly id: string;
      readonly imageUrl: string | null;
      readonly name: string;
      readonly rewardVersionId: string;
    };
    readonly wallet: WalletContract;
  };
}
