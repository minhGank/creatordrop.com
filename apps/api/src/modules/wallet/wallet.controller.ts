import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { WalletsResponse, WalletTestCreditResponse } from '@creatordrop/contracts';

import { ApiError } from '../../http/errors.js';
import type { UserId } from '../creators/creator.js';
import { trustedUserId } from '../creators/creator.schema.js';
import {
  parseEmptyWalletQuery,
  parseTestCreditInput,
  parseWalletCurrency,
  parseWalletIdempotencyKey,
} from './wallet.schema.js';
import type { WalletService } from './wallet.service.js';
import { toPublicWallet } from './wallet.js';

const run = (operation: () => Promise<void>, next: NextFunction): void => {
  void operation().catch(next);
};

const requireActorUserId = (request: Request): UserId => {
  if (request.actor === undefined) {
    throw new Error('Authentication middleware did not attach an actor.');
  }
  return trustedUserId(request.actor.user.id);
};

const requireJson = (request: Request): void => {
  if (!request.is('application/json')) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Request bodies must use application/json.');
  }
};

const parameter = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

export interface WalletControllers {
  readonly grantTestCredits: RequestHandler;
  readonly listWallets: RequestHandler;
}

export const createWalletControllers = (service: WalletService): WalletControllers => ({
  grantTestCredits: (request, response: Response<WalletTestCreditResponse>, next) => {
    run(async () => {
      requireJson(request);
      parseEmptyWalletQuery(request.query);
      const result = await service.grantTestCredits({
        ...parseTestCreditInput(request.body),
        currency: parseWalletCurrency(parameter(request.params.currency)),
        idempotencyKey: parseWalletIdempotencyKey(request.get('idempotency-key')),
        requestId: request.requestId,
        userId: requireActorUserId(request),
      });
      response.status(result.statusCode).json(result.body);
    }, next);
  },

  listWallets: (request, response: Response<WalletsResponse>, next) => {
    run(async () => {
      parseEmptyWalletQuery(request.query);
      const wallets = await service.listWallets(requireActorUserId(request));
      response.status(200).json({ wallets: wallets.map(toPublicWallet) });
    }, next);
  },
});
