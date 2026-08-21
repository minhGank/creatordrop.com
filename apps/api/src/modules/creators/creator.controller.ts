import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type {
  CreatorMemberResponse,
  CreatorMembersResponse,
  CreatorWorkspaceMembershipsResponse,
  CreatorWorkspaceResponse,
} from '@creatordrop/contracts';

import { ApiError } from '../../http/errors.js';
import {
  parseAddCreatorMemberInput,
  parseCreateCreatorInput,
  parseCreatorId,
  parseExpectedRevision,
  parseUpdateCreatorInput,
  parseUpdateCreatorMemberInput,
  parseUserId,
  trustedUserId,
} from './creator.schema.js';
import type { CreatorService } from './creator.service.js';
import type { CreatorScope, UserId } from './creator.js';

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

const singleParameter = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

const createScope = (request: Request): CreatorScope => ({
  actorUserId: requireActorUserId(request),
  creatorId: parseCreatorId(singleParameter(request.params.creatorId)),
});

const run = (operation: () => Promise<void>, next: NextFunction): void => {
  void operation().catch(next);
};

export interface CreatorControllers {
  readonly addMember: RequestHandler;
  readonly createCreator: RequestHandler;
  readonly getCreator: RequestHandler;
  readonly listMembers: RequestHandler;
  readonly listMyWorkspaces: RequestHandler;
  readonly removeMember: RequestHandler;
  readonly updateCreator: RequestHandler;
  readonly updateMember: RequestHandler;
}

export const createCreatorControllers = (service: CreatorService): CreatorControllers => ({
  createCreator: (request, response: Response<CreatorWorkspaceResponse>, next) => {
    run(async () => {
      requireJson(request);
      const input = parseCreateCreatorInput(request.body);
      const creator = await service.createCreator({
        ...input,
        actorUserId: requireActorUserId(request),
        requestId: request.requestId,
      });
      response.setHeader('ETag', `"${creator.revision.toString()}"`);
      response.status(201).json({ creator });
    }, next);
  },

  getCreator: (request, response: Response<CreatorWorkspaceResponse>, next) => {
    run(async () => {
      const creator = await service.getCreator(createScope(request));
      response.setHeader('ETag', `"${creator.revision.toString()}"`);
      response.status(200).json({ creator });
    }, next);
  },

  updateCreator: (request, response: Response<CreatorWorkspaceResponse>, next) => {
    run(async () => {
      requireJson(request);
      const input = parseUpdateCreatorInput(request.body);
      const scope = createScope(request);
      const creator = await service.updateCreator({
        ...input,
        ...scope,
        expectedRevision: parseExpectedRevision(request.get('if-match')),
        requestId: request.requestId,
      });
      response.setHeader('ETag', `"${creator.revision.toString()}"`);
      response.status(200).json({ creator });
    }, next);
  },

  listMyWorkspaces: (request, response: Response<CreatorWorkspaceMembershipsResponse>, next) => {
    run(async () => {
      const memberships = await service.listMyWorkspaces(requireActorUserId(request));
      response.status(200).json({ memberships });
    }, next);
  },

  listMembers: (request, response: Response<CreatorMembersResponse>, next) => {
    run(async () => {
      const members = await service.listMembers(createScope(request));
      response.status(200).json({ members });
    }, next);
  },

  addMember: (request, response: Response<CreatorMemberResponse>, next) => {
    run(async () => {
      requireJson(request);
      const input = parseAddCreatorMemberInput(request.body);
      const scope = createScope(request);
      const member = await service.addMember({
        actorUserId: scope.actorUserId,
        creatorId: scope.creatorId,
        requestId: request.requestId,
        role: input.role,
        targetUserId: input.userId,
      });
      response.status(201).json({ member });
    }, next);
  },

  updateMember: (request, response: Response<CreatorMemberResponse>, next) => {
    run(async () => {
      requireJson(request);
      const input = parseUpdateCreatorMemberInput(request.body);
      const scope = createScope(request);
      const member = await service.updateMember({
        actorUserId: scope.actorUserId,
        creatorId: scope.creatorId,
        requestId: request.requestId,
        role: input.role,
        targetUserId: parseUserId(singleParameter(request.params.userId)),
      });
      response.status(200).json({ member });
    }, next);
  },

  removeMember: (request, response, next) => {
    run(async () => {
      const scope = createScope(request);
      await service.removeMember({
        actorUserId: scope.actorUserId,
        creatorId: scope.creatorId,
        requestId: request.requestId,
        targetUserId: parseUserId(singleParameter(request.params.userId)),
      });
      response.status(204).end();
    }, next);
  },
});
