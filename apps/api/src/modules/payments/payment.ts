import type { Currency, PositiveMoneyMinor } from '@creatordrop/domain';

import type { UserId } from '../creators/creator.js';
import type { LedgerAccountId, LedgerTransactionId, WalletId } from '../wallet/wallet.js';

declare const fundingAdjustmentIdBrand: unique symbol;
declare const fundingDeficitIdBrand: unique symbol;
declare const fundingIntentIdBrand: unique symbol;
declare const fundingSettlementIdBrand: unique symbol;
declare const providerEventIdBrand: unique symbol;

export type FundingAdjustmentId = string & {
  readonly [fundingAdjustmentIdBrand]: 'FundingAdjustmentId';
};
export type FundingDeficitId = string & { readonly [fundingDeficitIdBrand]: 'FundingDeficitId' };
export type FundingIntentId = string & { readonly [fundingIntentIdBrand]: 'FundingIntentId' };
export type FundingSettlementId = string & {
  readonly [fundingSettlementIdBrand]: 'FundingSettlementId';
};
export type ProviderEventId = string & { readonly [providerEventIdBrand]: 'ProviderEventId' };

export type FundingIntentStatus =
  | 'canceled'
  | 'disputed'
  | 'failed'
  | 'partially_reversed'
  | 'provider_pending'
  | 'reconciliation_required'
  | 'requires_payment'
  | 'reversed'
  | 'settled';

export interface FundingIntent {
  readonly clientIdempotencyKey: string;
  readonly currency: Currency;
  readonly id: FundingIntentId;
  readonly lastProviderEventCreatedAt: string | null;
  readonly providerPaymentIntentId: string | null;
  readonly publicId: string;
  readonly requestFingerprint: string;
  readonly requestedAmountMinor: PositiveMoneyMinor;
  readonly status: FundingIntentStatus;
  readonly userId: UserId;
  readonly walletId: WalletId;
}

export interface FundingSettlement {
  readonly currency: Currency;
  readonly fundingIntentId: FundingIntentId;
  readonly id: FundingSettlementId;
  readonly ledgerTransactionId: LedgerTransactionId;
  readonly providerPaymentIntentId: string;
  readonly settledAmountMinor: PositiveMoneyMinor;
}

export interface ProviderEventRecord {
  readonly attemptCount: number;
  readonly fundingIntentId: FundingIntentId | null;
  readonly id: ProviderEventId;
  readonly payloadSha256: string;
  readonly status: 'processed' | 'processing' | 'retryable';
}

export interface FundingAdjustmentPosting {
  readonly deficitLedgerAccountId: LedgerAccountId | null;
  readonly deficitMinor: bigint;
  readonly ledgerTransactionId: LedgerTransactionId;
  readonly walletRecoveredMinor: bigint;
}
