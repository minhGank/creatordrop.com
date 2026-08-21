import {
  boxStatuses,
  boxVersionStates,
  inventoryModes,
  rewardStatuses,
  rewardTypes,
  rewardVersionStates,
} from '@creatordrop/contracts';
import type {
  BoxStatus,
  BoxVersionState,
  InventoryMode,
  RewardStatus,
  RewardType,
  RewardVersionState,
} from '@creatordrop/contracts';

import type { CreatorId, CreatorRole, UserId } from '../creators/creator.js';

export {
  boxStatuses,
  boxVersionStates,
  inventoryModes,
  rewardStatuses,
  rewardTypes,
  rewardVersionStates,
};
export type {
  BoxStatus,
  BoxVersionState,
  InventoryMode,
  RewardStatus,
  RewardType,
  RewardVersionState,
};

declare const boxIdBrand: unique symbol;
declare const boxVersionIdBrand: unique symbol;
declare const boxVersionRewardIdBrand: unique symbol;
declare const rewardIdBrand: unique symbol;
declare const rewardVersionIdBrand: unique symbol;

export type BoxId = string & { readonly [boxIdBrand]: 'BoxId' };
export type BoxVersionId = string & { readonly [boxVersionIdBrand]: 'BoxVersionId' };
export type BoxVersionRewardId = string & {
  readonly [boxVersionRewardIdBrand]: 'BoxVersionRewardId';
};
export type RewardId = string & { readonly [rewardIdBrand]: 'RewardId' };
export type RewardVersionId = string & { readonly [rewardVersionIdBrand]: 'RewardVersionId' };
export type MoneyMinor = bigint & { readonly __brand: 'MoneyMinor' };
export type ProbabilityWeight = bigint & { readonly __brand: 'ProbabilityWeight' };
export type InventoryQuantity = bigint & { readonly __brand: 'InventoryQuantity' };

export interface CatalogScope {
  readonly actorUserId: UserId;
  readonly creatorId: CreatorId;
}

export interface BoxVersion {
  readonly configurationHash: string | null;
  readonly createdAt: string;
  readonly currency: string;
  readonly description: string;
  readonly id: BoxVersionId;
  readonly imageUrl: string | null;
  readonly name: string;
  readonly priceMinor: string;
  readonly publishedAt: string | null;
  readonly rngAlgorithmVersion: string | null;
  readonly state: BoxVersionState;
  readonly totalWeight: string | null;
  readonly updatedAt: string;
  readonly versionNumber: number;
}

export interface Box {
  readonly createdAt: string;
  readonly creatorId: CreatorId;
  readonly currentPublishedVersionId: BoxVersionId | null;
  readonly draft: BoxVersion | null;
  readonly id: BoxId;
  readonly revision: number;
  readonly role: CreatorRole;
  readonly status: BoxStatus;
  readonly updatedAt: string;
}

export interface RewardVersion {
  readonly createdAt: string;
  readonly declaredValueCurrency: string | null;
  readonly declaredValueMinor: string | null;
  readonly description: string;
  readonly id: RewardVersionId;
  readonly imageUrl: string | null;
  readonly inventoryMode: InventoryMode;
  readonly inventoryQuantity: string | null;
  readonly name: string;
  readonly publishedAt: string | null;
  readonly rewardType: RewardType;
  readonly state: RewardVersionState;
  readonly updatedAt: string;
  readonly versionNumber: number;
}

export interface Reward {
  readonly createdAt: string;
  readonly creatorId: CreatorId;
  readonly draft: RewardVersion | null;
  readonly id: RewardId;
  readonly revision: number;
  readonly role: CreatorRole;
  readonly status: RewardStatus;
  readonly updatedAt: string;
}

export interface DraftRewardEntry {
  readonly id: BoxVersionRewardId;
  readonly position: number;
  readonly rewardVersion: RewardVersion;
  readonly weight: string;
}

export interface PublishedManifestEntry {
  readonly boxVersionRewardId: string;
  readonly position: number;
  readonly rewardVersionId: string;
  readonly weight: string;
}

export interface PublishedManifest {
  readonly algorithmVersion: 'hmac-sha256-rejection-v1';
  readonly boxId: string;
  readonly boxVersionId: string;
  readonly currency: string;
  readonly entries: readonly PublishedManifestEntry[];
  readonly priceMinor: string;
  readonly totalWeight: string;
}

export interface PublishedBoxVersion extends BoxVersion {
  readonly configurationHash: string;
  readonly manifest: PublishedManifest;
  readonly publishedAt: string;
  readonly rngAlgorithmVersion: 'hmac-sha256-rejection-v1';
  readonly state: 'published';
  readonly totalWeight: string;
}
