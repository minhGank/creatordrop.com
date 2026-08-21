import { describe, expect, it } from 'vitest';

import {
  parseAddCreatorMemberInput,
  parseCreateCreatorInput,
  parseExpectedRevision,
  parseUpdateCreatorInput,
} from '../src/modules/creators/creator.schema.js';

describe('creator request validation', () => {
  it('parses the allowlisted creator fields', () => {
    expect(
      parseCreateCreatorInput({
        customSlug: 'synthetic-creator',
        displayName: '  Synthetic Creator  ',
        handle: 'synthetic_creator',
      }),
    ).toEqual({
      customSlug: 'synthetic-creator',
      displayName: 'Synthetic Creator',
      handle: 'synthetic_creator',
    });
  });

  it.each([
    { customSlug: 'valid-slug', displayName: 'Valid', handle: 'UPPERCASE' },
    { customSlug: 'invalid_slug', displayName: 'Valid', handle: 'valid_handle' },
    { customSlug: 'valid-slug', displayName: '', handle: 'valid_handle' },
    {
      customSlug: 'valid-slug',
      displayName: 'Valid',
      handle: 'valid_handle',
      ownerUserId: '019c0000-0000-7000-8000-000000000099',
    },
  ])('rejects an invalid or unknown creator field: %o', (body) => {
    expect(() => parseCreateCreatorInput(body)).toThrow();
  });

  it('allows only displayName in Phase 4 creator updates', () => {
    expect(parseUpdateCreatorInput({ displayName: 'Updated' })).toEqual({
      displayName: 'Updated',
    });
    expect(() => parseUpdateCreatorInput({ displayName: 'Updated', handle: 'changed' })).toThrow();
  });

  it('requires a valid direct target user and creator role', () => {
    expect(
      parseAddCreatorMemberInput({
        role: 'editor',
        userId: '019c0000-0000-7000-8000-000000000002',
      }),
    ).toEqual({
      role: 'editor',
      userId: '019c0000-0000-7000-8000-000000000002',
    });
    expect(() => parseAddCreatorMemberInput({ role: 'admin', userId: 'not-a-uuid' })).toThrow();
  });

  it('parses only one quoted positive If-Match revision', () => {
    expect(parseExpectedRevision('"7"')).toBe(7);
    expect(() => parseExpectedRevision(undefined)).toThrow();
    expect(() => parseExpectedRevision('7')).toThrow();
    expect(() => parseExpectedRevision('"1", "2"')).toThrow();
  });
});
