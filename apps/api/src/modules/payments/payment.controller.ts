import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { WalletFundingIntentResponse } from '@creatordrop/contracts';

import { ApiError } from '../../http/errors.js';
import type { UserId } from '../creators/creator.js';
import { trustedUserId } from '../creators/creator.schema.js';
import { parseWalletCurrency } from '../wallet/wallet.schema.js';
import {
  parseFundingAmount,
  parseFundingIdempotencyKey,
  parseStripeSignature,
} from './payment.schema.js';
import type { PaymentService } from './payment.service.js';

const run = (operation: () => Promise<void>, next: NextFunction): void => {
  void operation().catch(next);
};

const requireActorUserId = (request: Request): UserId => {
  if (request.actor === undefined) throw new Error('Authenticated payment actor is missing.');
  return trustedUserId(request.actor.user.id);
};

const requireJson = (request: Request): void => {
  if (!request.is('application/json')) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Request bodies must use application/json.');
  }
};

const parameter = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

export interface PaymentControllers {
  readonly createFundingIntent: RequestHandler;
  readonly stripeWebhook: RequestHandler;
}

export const createPaymentControllers = (service: PaymentService): PaymentControllers => ({
  createFundingIntent: (request, response: Response<WalletFundingIntentResponse>, next) => {
    run(async () => {
      requireJson(request);
      if (Object.keys(request.query).length > 0) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown query parameters are not allowed.');
      }
      const result = await service.createFundingIntent({
        amountMinor: parseFundingAmount(request.body),
        currency: parseWalletCurrency(parameter(request.params.currency)),
        idempotencyKey: parseFundingIdempotencyKey(request.get('idempotency-key')),
        requestId: request.requestId,
        userId: requireActorUserId(request),
      });
      response.status(201).json({ fundingIntent: result });
    }, next);
  },

  stripeWebhook: (request, response, next) => {
    run(async () => {
      if (!Buffer.isBuffer(request.body)) {
        throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Stripe webhooks require JSON bytes.');
      }
      await service.processStripeWebhook(
        request.body,
        parseStripeSignature(request.get('stripe-signature')),
        request.requestId,
      );
      response.status(200).json({ received: true });
    }, next);
  },
});
