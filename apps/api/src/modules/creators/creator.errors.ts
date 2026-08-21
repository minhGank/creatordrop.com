export class CreatorNotFoundError extends Error {
  constructor() {
    super('The creator workspace was not found in the actor scope.');
    this.name = 'CreatorNotFoundError';
  }
}

export class CreatorPermissionDeniedError extends Error {
  constructor() {
    super('The actor role does not permit this creator action.');
    this.name = 'CreatorPermissionDeniedError';
  }
}

export class CreatorIdentityConflictError extends Error {
  constructor() {
    super('The creator handle or custom slug is already in use.');
    this.name = 'CreatorIdentityConflictError';
  }
}

export class CreatorRevisionConflictError extends Error {
  readonly currentRevision: number;

  constructor(currentRevision: number) {
    super('The creator revision is stale.');
    this.name = 'CreatorRevisionConflictError';
    this.currentRevision = currentRevision;
  }
}

export class CreatorMemberConflictError extends Error {
  constructor() {
    super('The user is already a creator member.');
    this.name = 'CreatorMemberConflictError';
  }
}

export class CreatorMemberNotFoundError extends Error {
  constructor() {
    super('The creator member was not found.');
    this.name = 'CreatorMemberNotFoundError';
  }
}

export class CreatorTargetUserNotFoundError extends Error {
  constructor() {
    super('The target active user was not found.');
    this.name = 'CreatorTargetUserNotFoundError';
  }
}

export class CreatorFinalOwnerError extends Error {
  constructor() {
    super('An active creator must retain at least one owner.');
    this.name = 'CreatorFinalOwnerError';
  }
}
