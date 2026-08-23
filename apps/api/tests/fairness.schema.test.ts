import { describe, expect, it } from 'vitest';

import {
  parseClientSeedInput,
  parseEmptyRotationInput,
  parseFairnessRevision,
  parseRotationIdempotencyKey,
  parseSeedSetId,
} from '../src/modules/fairness/fairness.schema.js';

describe('fairness request validation', () => {
  it('accepts only an exact canonical client seed body', () => {
    const clientSeed = 'ab'.repeat(32);
    expect(parseClientSeedInput({ clientSeed })).toEqual({ clientSeed });
    for (const invalid of [
      {},
      { clientSeed, extra: true },
      { clientSeed: 'AB'.repeat(32) },
      { clientSeed: 'ab'.repeat(31) },
      { clientSeed: 1 },
      null,
    ]) {
      expect(() => parseClientSeedInput(invalid)).toThrow();
    }
  });

  it('requires quoted optimistic revisions', () => {
    expect(parseFairnessRevision('"12"')).toBe(12);
    for (const invalid of [undefined, '12', '"0"', '"01"', '"1.5"']) {
      expect(() => parseFairnessRevision(invalid)).toThrow();
    }
  });

  it('validates rotation idempotency keys and canonicalizes UUID parameters', () => {
    expect(parseRotationIdempotencyKey('rotate_123')).toBe('rotate_123');
    expect(() => parseRotationIdempotencyKey('short')).toThrow();
    expect(parseSeedSetId('019C0000-0000-7000-8000-000000000020')).toBe(
      '019c0000-0000-7000-8000-000000000020',
    );
  });

  it('accepts only empty rotation inputs', () => {
    expect(() => parseEmptyRotationInput(undefined, {})).not.toThrow();
    expect(() => parseEmptyRotationInput({}, {})).not.toThrow();
    expect(() => parseEmptyRotationInput({ reason: 'key_compromise' }, {})).toThrow();
    expect(() => parseEmptyRotationInput({}, { reason: 'policy_change' })).toThrow();
  });
});
