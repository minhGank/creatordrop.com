import type { Currency, MoneyMinor } from '@creatordrop/domain';

import type { UserId } from '../creators/creator.js';

declare const idempotencyRecordIdBrand: unique symbol;
declare const ledgerAccountIdBrand: unique symbol;
declare const ledgerEntryIdBrand: unique symbol;
declare const ledgerTransactionIdBrand: unique symbol;
declare const walletIdBrand: unique symbol;

export type IdempotencyRecordId = string & {
  readonly [idempotencyRecordIdBrand]: 'IdempotencyRecordId';
};
export type LedgerAccountId = string & { readonly [ledgerAccountIdBrand]: 'LedgerAccountId' };
export type LedgerEntryId = string & { readonly [ledgerEntryIdBrand]: 'LedgerEntryId' };
export type LedgerTransactionId = string & {
  readonly [ledgerTransactionIdBrand]: 'LedgerTransactionId';
};
export type WalletId = string & { readonly [walletIdBrand]: 'WalletId' };

export type LedgerTransactionKind =
  | 'box_open_allocation'
  | 'box_open_sale'
  | 'provider_funding_credit'
  | 'provider_funding_dispute'
  | 'provider_funding_refund'
  | 'reversal'
  | 'test_credit_grant'
  | 'wallet_credit'
  | 'wallet_debit';

export type LedgerAccountType =
  | 'box_sales_clearing'
  | 'creator_pending_earnings'
  | 'platform_fee'
  | 'provider_funding_clearing'
  | 'system_test_funding'
  | 'user_funding_deficit'
  | 'user_wallet';

export interface Wallet {
  readonly availableBalanceMinor: MoneyMinor;
  readonly createdAt: string;
  readonly currency: Currency;
  readonly id: WalletId;
  readonly ledgerAccountId: LedgerAccountId;
  readonly revision: bigint;
  readonly updatedAt: string;
  readonly userId: UserId;
}

export interface LedgerAccount {
  readonly accountType: LedgerAccountType;
  readonly currency: Currency;
  readonly id: LedgerAccountId;
  readonly ownerCreatorId: string | null;
  readonly ownerUserId: UserId | null;
}

export interface LedgerEntry {
  readonly amountMinor: MoneyMinor;
  readonly currency: Currency;
  readonly id: LedgerEntryId;
  readonly ledgerAccountId: LedgerAccountId;
  readonly sequence: number;
}

export interface LedgerTransaction {
  readonly actorUserId: UserId;
  readonly businessReferenceId: string;
  readonly businessReferenceType: string;
  readonly currency: Currency;
  readonly id: LedgerTransactionId;
  readonly idempotencyRecordId: IdempotencyRecordId | null;
  readonly kind: LedgerTransactionKind;
  readonly reversesLedgerTransactionId: LedgerTransactionId | null;
  readonly status: 'pending' | 'posted';
}

export interface LedgerTransactionWithEntries {
  readonly entries: readonly LedgerEntry[];
  readonly transaction: LedgerTransaction;
}

export interface IdempotencyRecord {
  readonly actorUserId: UserId;
  readonly fingerprint: string;
  readonly httpStatus: number | null;
  readonly id: IdempotencyRecordId;
  readonly operation: string;
  readonly resourceId: string | null;
  readonly resourceType: string | null;
  readonly responseBody: unknown;
  readonly status: 'completed' | 'processing';
}

export const toPublicWallet = (wallet: Wallet) => ({
  balanceMinor: wallet.availableBalanceMinor.toString(),
  currency: wallet.currency,
  id: wallet.id,
  revision: wallet.revision.toString(),
});
