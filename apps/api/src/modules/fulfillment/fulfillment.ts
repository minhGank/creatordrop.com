import type {
  FulfillmentAddressContract,
  FulfillmentContract,
  FulfillmentState,
  FulfillmentType,
} from '@creatordrop/contracts';

export type { FulfillmentAddressContract, FulfillmentContract, FulfillmentState, FulfillmentType };

export type FulfillmentEncryptionDomain = 'address' | 'digital_secret';

export interface ProtectedFulfillmentData {
  readonly authenticationTag: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly domain: FulfillmentEncryptionDomain;
  readonly expiresAt: string | null;
  readonly fulfillmentId: string;
  readonly iv: Uint8Array;
  readonly keyIdentity: string;
  readonly keyVersion: string;
}

export interface FulfillmentEncryptionContext {
  readonly creatorId: string;
  readonly domain: FulfillmentEncryptionDomain;
  readonly fulfillmentId: string;
  readonly keyVersion: string;
  readonly userId: string;
}
