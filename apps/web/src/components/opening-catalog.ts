import type {
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

export const isOpeningV1Catalog = (
  catalog: PublishedBoxVersionResponse,
): catalog is OpeningV1Catalog =>
  catalog.version.openingCompatibilityVersion === 'opening-v1' &&
  !('openingCompatibilityVersion' in catalog.manifest);
