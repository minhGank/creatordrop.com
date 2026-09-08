import type {
  OpeningV2PublishedManifestContract,
  PublishedBoxVersionResponse,
  PublishedManifestContract,
} from '@creatordrop/contracts';

export type OpeningV1Catalog = PublishedBoxVersionResponse & {
  readonly manifest: PublishedManifestContract;
  readonly version: PublishedBoxVersionResponse['version'] & {
    readonly currency: string;
    readonly maxOpeningsPerUser: null;
    readonly openingCompatibilityVersion: 'opening-v1';
    readonly priceMinor: string;
  };
};

export type OpeningV2Catalog = PublishedBoxVersionResponse & {
  readonly manifest: OpeningV2PublishedManifestContract;
  readonly version: PublishedBoxVersionResponse['version'] & {
    readonly currency: null;
    readonly maxOpeningsPerUser: string;
    readonly openingCompatibilityVersion: 'opening-v2';
    readonly priceMinor: null;
  };
};

export type OpeningCatalog = OpeningV1Catalog | OpeningV2Catalog;

export const isOpeningV1Catalog = (
  catalog: PublishedBoxVersionResponse,
): catalog is OpeningV1Catalog =>
  catalog.version.openingCompatibilityVersion === 'opening-v1' &&
  !('openingCompatibilityVersion' in catalog.manifest);

export const isOpeningV2Catalog = (
  catalog: PublishedBoxVersionResponse,
): catalog is OpeningV2Catalog =>
  catalog.version.openingCompatibilityVersion === 'opening-v2' &&
  'openingCompatibilityVersion' in catalog.manifest;
