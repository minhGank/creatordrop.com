import type { ErrorRequestHandler, RequestHandler } from 'express';

import type { ApiErrorResponse } from '@creatordrop/contracts';
import type { Logger } from '@creatordrop/observability';

import {
  CatalogDraftConflictError,
  CatalogImmutableError,
  CatalogPermissionDeniedError,
  CatalogPublicationError,
  CatalogResourceNotFoundError,
  CatalogRevisionConflictError,
} from '../modules/catalog/catalog.errors.js';
import {
  CreatorFinalOwnerError,
  CreatorIdentityConflictError,
  CreatorMemberConflictError,
  CreatorMemberNotFoundError,
  CreatorNotFoundError,
  CreatorPermissionDeniedError,
  CreatorRevisionConflictError,
  CreatorTargetUserNotFoundError,
} from '../modules/creators/creator.errors.js';
import {
  FairnessAlreadyInitializedError,
  FairnessClientSeedMismatchError,
  FairnessNotInitializedError,
  FairnessRevisionConflictError,
  SeedRevealNotAllowedError,
  SeedEncryptionKeyUnavailableError,
  SeedReplacementKeyUnsafeError,
  SeedRotationRequiredError,
  SeedRotationIdempotencyConflictError,
  SeedSetCompromisedError,
  SeedSetNotFoundError,
  SeedSetUnavailableError,
} from '../modules/fairness/fairness.errors.js';
import {
  FulfillmentDataUnavailableError,
  FulfillmentKeyUnavailableError,
  FulfillmentNotFoundError,
  FulfillmentPermissionDeniedError,
  FulfillmentRevisionConflictError,
  FulfillmentTransitionError,
  InventoryRestockError,
} from '../modules/fulfillment/fulfillment.errors.js';
import {
  BoxNotOpenableError,
  InventoryUnavailableError,
  OpeningCurrencyUnavailableError,
  OpeningRetryableError,
} from '../modules/openings/opening.errors.js';
import {
  AccountFundingRestrictedError,
  IdempotencyKeyReusedError,
  InsufficientBalanceError,
  LedgerTransactionNotFoundError,
  LedgerTransactionNotReversibleError,
  TestCreditsUnavailableError,
  WalletAmountOverflowError,
  WalletCurrencyNotEnabledError,
  WalletNotFoundError,
} from '../modules/wallet/wallet.errors.js';
import {
  FundingAmountOutOfRangeError,
  FundingEventRetryRequiredError,
  FundingProviderUnavailableError,
  FundingUnavailableError,
  FundingWebhookSignatureError,
} from '../modules/payments/payment.errors.js';
import { ApiError } from './errors.js';

const hasErrorType = (value: unknown, expectedType: string): boolean =>
  typeof value === 'object' && value !== null && 'type' in value && value.type === expectedType;

const databaseErrorAttributes = (error: unknown): Readonly<Record<string, string>> => {
  if (typeof error !== 'object' || error === null) return {};
  const attributes: Record<string, string> = {};
  if ('code' in error && typeof error.code === 'string') attributes.databaseCode = error.code;
  if ('constraint' in error && typeof error.constraint === 'string') {
    attributes.databaseConstraint = error.constraint;
  }
  return attributes;
};

const normalizeError = (error: unknown): ApiError => {
  if (error instanceof ApiError) {
    return error;
  }

  if (hasErrorType(error, 'entity.too.large')) {
    return new ApiError(413, 'REQUEST_BODY_TOO_LARGE', 'The request body exceeds the size limit.');
  }

  if (hasErrorType(error, 'entity.parse.failed')) {
    return new ApiError(400, 'MALFORMED_JSON', 'The request body is not valid JSON.');
  }

  if (error instanceof CreatorNotFoundError) {
    return new ApiError(404, 'CREATOR_NOT_FOUND', 'The creator workspace was not found.');
  }

  if (error instanceof CreatorPermissionDeniedError) {
    return new ApiError(403, 'CREATOR_FORBIDDEN', 'The creator action is not permitted.');
  }

  if (error instanceof CreatorIdentityConflictError) {
    return new ApiError(
      409,
      'CREATOR_IDENTITY_CONFLICT',
      'The creator handle or custom slug is already in use.',
    );
  }

  if (error instanceof CreatorRevisionConflictError) {
    return new ApiError(409, 'CREATOR_REVISION_CONFLICT', 'The creator revision is stale.', {
      currentRevision: error.currentRevision,
    });
  }

  if (error instanceof CreatorMemberConflictError) {
    return new ApiError(409, 'CREATOR_MEMBER_CONFLICT', 'The user is already a creator member.');
  }

  if (error instanceof CreatorMemberNotFoundError) {
    return new ApiError(404, 'CREATOR_MEMBER_NOT_FOUND', 'The creator member was not found.');
  }

  if (error instanceof CreatorTargetUserNotFoundError) {
    return new ApiError(404, 'USER_NOT_FOUND', 'The target active user was not found.');
  }

  if (error instanceof CreatorFinalOwnerError) {
    return new ApiError(
      409,
      'FINAL_OWNER_REQUIRED',
      'An active creator must retain at least one owner.',
    );
  }

  if (error instanceof CatalogResourceNotFoundError) {
    return new ApiError(404, 'CATALOG_NOT_FOUND', 'The catalog resource was not found.');
  }

  if (error instanceof CatalogPermissionDeniedError) {
    return new ApiError(403, 'CATALOG_FORBIDDEN', 'The catalog action is not permitted.');
  }

  if (error instanceof CatalogRevisionConflictError) {
    return new ApiError(409, 'CATALOG_REVISION_CONFLICT', 'The catalog revision is stale.', {
      currentRevision: error.currentRevision,
    });
  }

  if (error instanceof CatalogDraftConflictError) {
    return new ApiError(409, 'CATALOG_DRAFT_CONFLICT', error.message);
  }

  if (error instanceof CatalogPublicationError) {
    return new ApiError(422, `CATALOG_PUBLICATION_${error.reason}`, error.message);
  }

  if (error instanceof CatalogImmutableError) {
    return new ApiError(409, 'CATALOG_IMMUTABLE', 'Published catalog configuration is immutable.');
  }

  if (error instanceof FairnessNotInitializedError) {
    return new ApiError(
      404,
      'FAIRNESS_NOT_INITIALIZED',
      'Fairness state has not been initialized.',
    );
  }

  if (error instanceof FairnessAlreadyInitializedError) {
    return new ApiError(
      409,
      'FAIRNESS_ALREADY_INITIALIZED',
      'Fairness state is already initialized with a different client seed.',
    );
  }

  if (error instanceof FairnessRevisionConflictError) {
    return new ApiError(409, 'FAIRNESS_REVISION_CONFLICT', 'The fairness revision is stale.', {
      currentRevision: error.currentRevision,
    });
  }

  if (error instanceof FairnessClientSeedMismatchError) {
    return new ApiError(409, 'CLIENT_SEED_MISMATCH', 'The client seed is no longer current.');
  }

  if (error instanceof BoxNotOpenableError) {
    return new ApiError(409, 'BOX_NOT_OPENABLE', 'The box is not currently available to open.');
  }

  if (error instanceof InventoryUnavailableError) {
    return new ApiError(409, 'INVENTORY_UNAVAILABLE', 'The selected reward is out of stock.');
  }

  if (error instanceof OpeningCurrencyUnavailableError) {
    return new ApiError(422, 'OPENING_CURRENCY_NOT_ENABLED', 'The box currency is not enabled.');
  }

  if (error instanceof OpeningRetryableError) {
    return new ApiError(
      503,
      'OPENING_RETRY_REQUIRED',
      'The opening attempt rolled back and may be retried with the same idempotency key.',
    );
  }

  if (error instanceof SeedRotationRequiredError) {
    return new ApiError(
      409,
      'SEED_ROTATION_REQUIRED',
      'The active server seed must be rotated before it can be used again.',
    );
  }

  if (error instanceof SeedSetUnavailableError) {
    return new ApiError(409, 'SEED_SET_UNAVAILABLE', 'No active server seed is available.');
  }

  if (error instanceof SeedSetNotFoundError) {
    return new ApiError(404, 'SEED_SET_NOT_FOUND', 'The seed set was not found.');
  }

  if (error instanceof SeedRevealNotAllowedError) {
    return new ApiError(409, 'SEED_REVEAL_NOT_ALLOWED', 'The seed set is not eligible for reveal.');
  }

  if (error instanceof SeedEncryptionKeyUnavailableError) {
    return new ApiError(
      503,
      'RNG_KEY_UNAVAILABLE',
      'The required server-seed encryption key is temporarily unavailable.',
    );
  }

  if (error instanceof SeedReplacementKeyUnsafeError) {
    return new ApiError(
      503,
      'RNG_REPLACEMENT_KEY_UNSAFE',
      'A trusted replacement server-seed key is required.',
    );
  }

  if (error instanceof SeedRotationIdempotencyConflictError) {
    return new ApiError(
      409,
      'RNG_ROTATION_IDEMPOTENCY_CONFLICT',
      'The idempotency key was already used for a different seed transition.',
    );
  }

  if (error instanceof SeedSetCompromisedError) {
    return new ApiError(500, 'SEED_SET_COMPROMISED', 'Seed-set integrity verification failed.');
  }

  if (error instanceof WalletNotFoundError) {
    return new ApiError(404, 'WALLET_NOT_FOUND', 'The wallet was not found.');
  }

  if (error instanceof FulfillmentNotFoundError) {
    return new ApiError(404, 'FULFILLMENT_NOT_FOUND', 'The fulfillment was not found.');
  }
  if (error instanceof FulfillmentPermissionDeniedError) {
    return new ApiError(403, 'FULFILLMENT_FORBIDDEN', 'The fulfillment action is not permitted.');
  }
  if (error instanceof FulfillmentRevisionConflictError) {
    return new ApiError(409, 'FULFILLMENT_REVISION_CONFLICT', 'The fulfillment revision is stale.');
  }
  if (error instanceof FulfillmentTransitionError) {
    return new ApiError(
      409,
      'FULFILLMENT_TRANSITION_INVALID',
      'The fulfillment transition is invalid.',
    );
  }
  if (error instanceof FulfillmentDataUnavailableError) {
    return new ApiError(
      409,
      'FULFILLMENT_DATA_UNAVAILABLE',
      'Protected fulfillment data is unavailable.',
    );
  }
  if (error instanceof FulfillmentKeyUnavailableError) {
    return new ApiError(
      503,
      'FULFILLMENT_KEY_UNAVAILABLE',
      'The required fulfillment key is unavailable.',
    );
  }
  if (error instanceof InventoryRestockError) {
    return new ApiError(
      409,
      'INVENTORY_RESTOCK_INVALID',
      'The inventory pool cannot be restocked.',
    );
  }

  if (error instanceof AccountFundingRestrictedError) {
    return new ApiError(
      409,
      'ACCOUNT_FUNDING_RESTRICTED',
      'The account is restricted by an unresolved funding deficit.',
    );
  }

  if (error instanceof FundingUnavailableError) {
    return new ApiError(404, 'FUNDING_UNAVAILABLE', 'Stripe wallet funding is unavailable.');
  }

  if (error instanceof FundingAmountOutOfRangeError) {
    return new ApiError(
      422,
      'FUNDING_AMOUNT_OUT_OF_RANGE',
      'USD funding must be between 500 and 50000 minor units.',
    );
  }

  if (error instanceof FundingWebhookSignatureError) {
    return new ApiError(400, 'STRIPE_SIGNATURE_INVALID', 'The Stripe signature is invalid.');
  }

  if (error instanceof FundingProviderUnavailableError) {
    return new ApiError(503, 'FUNDING_PROVIDER_UNAVAILABLE', 'Stripe is temporarily unavailable.');
  }

  if (error instanceof FundingEventRetryRequiredError) {
    return new ApiError(
      503,
      'STRIPE_EVENT_RETRY_REQUIRED',
      'The verified Stripe event must be retried.',
    );
  }

  if (error instanceof WalletCurrencyNotEnabledError) {
    return new ApiError(
      422,
      'WALLET_CURRENCY_NOT_ENABLED',
      'The requested wallet currency is not enabled.',
    );
  }

  if (error instanceof TestCreditsUnavailableError) {
    return new ApiError(404, 'TEST_CREDITS_UNAVAILABLE', 'Test credit grants are unavailable.');
  }

  if (error instanceof InsufficientBalanceError) {
    return new ApiError(422, 'INSUFFICIENT_BALANCE', 'The wallet has insufficient settled funds.');
  }

  if (error instanceof WalletAmountOverflowError) {
    return new ApiError(
      422,
      'WALLET_AMOUNT_OVERFLOW',
      'The wallet amount exceeds supported storage.',
    );
  }

  if (error instanceof IdempotencyKeyReusedError) {
    return new ApiError(
      409,
      'IDEMPOTENCY_KEY_REUSED',
      'The idempotency key was already used for a different request.',
    );
  }

  if (error instanceof LedgerTransactionNotFoundError) {
    return new ApiError(
      404,
      'LEDGER_TRANSACTION_NOT_FOUND',
      'The ledger transaction was not found.',
    );
  }

  if (error instanceof LedgerTransactionNotReversibleError) {
    return new ApiError(
      409,
      'LEDGER_TRANSACTION_NOT_REVERSIBLE',
      'The ledger transaction cannot be reversed independently.',
    );
  }

  return new ApiError(500, 'INTERNAL_ERROR', 'An unexpected error occurred.');
};

export const notFoundHandler: RequestHandler = (_request, _response, next) => {
  next(new ApiError(404, 'NOT_FOUND', 'The requested resource was not found.'));
};

export const createErrorHandler =
  (logger: Logger): ErrorRequestHandler =>
  (error: unknown, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }

    const apiError = normalizeError(error);
    const attributes = {
      errorCode: apiError.code,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      ...databaseErrorAttributes(error),
      method: request.method,
      path: request.path,
      requestId: request.requestId,
      statusCode: apiError.status,
    };

    if (apiError.status >= 500) {
      logger.error('request.failed', attributes);
    } else {
      logger.info('request.rejected', attributes);
    }

    const body: ApiErrorResponse = {
      error: {
        code: apiError.code,
        details: apiError.details,
        message: apiError.message,
        requestId: request.requestId,
      },
    };

    response.status(apiError.status).json(body);
  };
