import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type {
  FulfillmentDeliveryDataResponse,
  FulfillmentResponse,
  FulfillmentsResponse,
  InventoryRestockResponse,
} from '@creatordrop/contracts';

import { ApiError } from '../../http/errors.js';
import { parseCreatorId, trustedUserId } from '../creators/creator.schema.js';
import {
  parseAccessPurpose,
  parseActionKey,
  parseAddress,
  parseCreatorAction,
  parseEmptyBody,
  parseExpectedRevision,
  parseFulfillmentId,
  parseInventoryPoolId,
  parseRestock,
} from './fulfillment.schema.js';
import type { FulfillmentService } from './fulfillment.service.js';

const run = (operation: () => Promise<void>, next: NextFunction): void => {
  void operation().catch(next);
};

const parameter = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

const actor = (request: Request): string => {
  if (request.actor === undefined) throw new Error('Authenticated fulfillment actor is missing.');
  return trustedUserId(request.actor.user.id);
};

const json = (request: Request): void => {
  if (!request.is('application/json')) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Request bodies must use application/json.');
  }
};

const command = (request: Request) => ({
  actionKey: parseActionKey(request.get('idempotency-key')),
  actorUserId: actor(request),
  expectedRevision: parseExpectedRevision(request.get('if-match')),
  fulfillmentId: parseFulfillmentId(parameter(request.params.fulfillmentId)),
  requestId: request.requestId,
});

const etag = (response: Response, revision: number): void => {
  response.setHeader('ETag', `"${revision.toString()}"`);
};

export interface FulfillmentControllers {
  readonly creatorAction: RequestHandler;
  readonly getCreatorDeliveryData: RequestHandler;
  readonly getCreatorFulfillment: RequestHandler;
  readonly getUserDeliveryData: RequestHandler;
  readonly getUserFulfillment: RequestHandler;
  readonly listCreatorFulfillments: RequestHandler;
  readonly listUserFulfillments: RequestHandler;
  readonly redactCreatorDeliveryData: RequestHandler;
  readonly redactUserDeliveryData: RequestHandler;
  readonly restock: RequestHandler;
  readonly submitAddress: RequestHandler;
}

export const createFulfillmentControllers = (
  service: FulfillmentService,
): FulfillmentControllers => ({
  listUserFulfillments: (request, response: Response<FulfillmentsResponse>, next) => {
    run(async () => {
      response
        .status(200)
        .json({ fulfillments: await service.listUserFulfillments(actor(request)) });
    }, next);
  },
  getUserFulfillment: (request, response: Response<FulfillmentResponse>, next) => {
    run(async () => {
      const fulfillment = await service.getUserFulfillment(
        actor(request),
        parseFulfillmentId(parameter(request.params.fulfillmentId)),
      );
      etag(response, fulfillment.revision);
      response.status(200).json({ fulfillment });
    }, next);
  },
  submitAddress: (request, response: Response<FulfillmentResponse>, next) => {
    run(async () => {
      json(request);
      const result = await service.submitAddress({
        ...command(request),
        address: parseAddress(request.body),
      });
      etag(response, result.fulfillment.revision);
      response.status(200).json(result);
    }, next);
  },
  getUserDeliveryData: (request, response: Response<FulfillmentDeliveryDataResponse>, next) => {
    run(async () => {
      response
        .status(200)
        .json(
          await service.getUserDeliveryData(
            actor(request),
            parseFulfillmentId(parameter(request.params.fulfillmentId)),
          ),
        );
    }, next);
  },
  redactUserDeliveryData: (request, response: Response<FulfillmentResponse>, next) => {
    run(async () => {
      json(request);
      parseEmptyBody(request.body);
      const result = await service.redactUserDeliveryData(command(request));
      etag(response, result.fulfillment.revision);
      response.status(200).json(result);
    }, next);
  },
  listCreatorFulfillments: (request, response: Response<FulfillmentsResponse>, next) => {
    run(async () => {
      response.status(200).json({
        fulfillments: await service.listCreatorFulfillments(
          actor(request),
          parseCreatorId(parameter(request.params.creatorId)),
        ),
      });
    }, next);
  },
  getCreatorFulfillment: (request, response: Response<FulfillmentResponse>, next) => {
    run(async () => {
      const fulfillment = await service.getCreatorFulfillment({
        actorUserId: actor(request),
        creatorId: parseCreatorId(parameter(request.params.creatorId)),
        fulfillmentId: parseFulfillmentId(parameter(request.params.fulfillmentId)),
      });
      etag(response, fulfillment.revision);
      response.status(200).json({ fulfillment });
    }, next);
  },
  creatorAction: (request, response: Response<FulfillmentResponse>, next) => {
    run(async () => {
      json(request);
      const result = await service.applyCreatorAction({
        ...command(request),
        action: parseCreatorAction(request.body),
        creatorId: parseCreatorId(parameter(request.params.creatorId)),
      });
      etag(response, result.fulfillment.revision);
      response.status(200).json(result);
    }, next);
  },
  getCreatorDeliveryData: (request, response: Response<FulfillmentDeliveryDataResponse>, next) => {
    run(async () => {
      json(request);
      response.status(200).json(
        await service.getCreatorDeliveryData({
          actorUserId: actor(request),
          creatorId: parseCreatorId(parameter(request.params.creatorId)),
          fulfillmentId: parseFulfillmentId(parameter(request.params.fulfillmentId)),
          purpose: parseAccessPurpose(request.body),
        }),
      );
    }, next);
  },
  redactCreatorDeliveryData: (request, response: Response<FulfillmentResponse>, next) => {
    run(async () => {
      json(request);
      parseEmptyBody(request.body);
      const result = await service.redactCreatorDeliveryData({
        ...command(request),
        creatorId: parseCreatorId(parameter(request.params.creatorId)),
      });
      etag(response, result.fulfillment.revision);
      response.status(200).json(result);
    }, next);
  },
  restock: (request, response: Response<InventoryRestockResponse>, next) => {
    run(async () => {
      json(request);
      const result = await service.restock({
        ...parseRestock(request.body),
        actionKey: parseActionKey(request.get('idempotency-key')),
        actorUserId: actor(request),
        creatorId: parseCreatorId(parameter(request.params.creatorId)),
        poolId: parseInventoryPoolId(parameter(request.params.poolId)),
        requestId: request.requestId,
      });
      response.status(result.replayed ? 200 : 201).json(result);
    }, next);
  },
});
