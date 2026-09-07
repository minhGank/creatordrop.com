import { describe, expect, it } from 'vitest';

import { CatalogPublicationError } from '../src/modules/catalog/catalog.errors.js';
import {
  canonicalizePublishedManifest,
  createPublishedManifest,
  createOpeningV2PublishedManifest,
  hashPublishedManifest,
} from '../src/modules/catalog/catalog.manifest.js';
import {
  parseBoxDraftInput,
  parseBoxId,
  parseBoxVersionId,
  parseBoxVersionRewardId,
  parseDraftRewardConfiguration,
  parseRewardVersionId,
} from '../src/modules/catalog/catalog.schema.js';

describe('published catalog manifest', () => {
  it('canonicalizes the fixed RFC 8785 shape and produces a stable SHA-256 hash', () => {
    const price = parseBoxDraftInput({
      currency: 'USD',
      description: '',
      imageUrl: null,
      name: 'Box',
      priceMinor: '1000',
    }).priceMinor;
    if (price === null) throw new Error('Expected a legacy catalog price.');
    const weight = parseDraftRewardConfiguration({
      entries: [
        {
          isBaseReward: true,
          rewardVersionId: '019c0000-0000-7000-8000-000000000040',
          weight: '5',
        },
      ],
    }).entries[0]?.weight;
    if (weight === undefined) throw new Error('Expected one parsed weight.');
    const manifest = createPublishedManifest({
      boxId: parseBoxId('019c0000-0000-7000-8000-000000000010'),
      boxVersionId: parseBoxVersionId('019c0000-0000-7000-8000-000000000020'),
      currency: 'USD',
      entries: [
        {
          id: parseBoxVersionRewardId('019c0000-0000-7000-8000-000000000030'),
          position: 0,
          rewardVersionId: parseRewardVersionId('019c0000-0000-7000-8000-000000000040'),
          weight,
        },
      ],
      priceMinor: price,
    });

    expect(canonicalizePublishedManifest(manifest)).toBe(
      '{"algorithmVersion":"hmac-sha256-rejection-v1","boxId":"019c0000-0000-7000-8000-000000000010","boxVersionId":"019c0000-0000-7000-8000-000000000020","currency":"USD","entries":[{"boxVersionRewardId":"019c0000-0000-7000-8000-000000000030","position":0,"rewardVersionId":"019c0000-0000-7000-8000-000000000040","weight":"5"}],"priceMinor":"1000","totalWeight":"5"}',
    );
    expect(hashPublishedManifest(manifest)).toBe(
      'cfad026a524004200ee9a3b63e7cb8f1b5da563421e9ea7e1dd7d4cac92e8a97',
    );
  });

  it('rejects signed-bigint weight overflow', () => {
    const input = parseDraftRewardConfiguration({
      entries: [
        {
          isBaseReward: true,
          rewardVersionId: '019c0000-0000-7000-8000-000000000040',
          weight: '9223372036854775807',
        },
        {
          isBaseReward: false,
          rewardVersionId: '019c0000-0000-7000-8000-000000000041',
          weight: '1',
        },
      ],
    });
    expect(() =>
      createPublishedManifest({
        boxId: parseBoxId('019c0000-0000-7000-8000-000000000010'),
        boxVersionId: parseBoxVersionId('019c0000-0000-7000-8000-000000000020'),
        currency: 'USD',
        entries: input.entries.map((entry, position) => ({
          id: parseBoxVersionRewardId(`019c0000-0000-7000-8000-00000000003${position.toString()}`),
          position,
          rewardVersionId: entry.rewardVersionId,
          weight: entry.weight,
        })),
        priceMinor: (() => {
          const price = parseBoxDraftInput({
            currency: 'USD',
            description: '',
            name: 'Box',
            priceMinor: '1000',
          }).priceMinor;
          if (price === null) throw new Error('Expected a legacy catalog price.');
          return price;
        })(),
      }),
    ).toThrow(CatalogPublicationError);
  });

  it('creates a deterministic non-financial opening-v2 manifest', () => {
    const entry = {
      id: parseBoxVersionRewardId('019c0000-0000-7000-8000-000000000030'),
      position: 0,
      rarity: 'common' as const,
      rewardVersionId: parseRewardVersionId('019c0000-0000-7000-8000-000000000040'),
      weight: 5n as ReturnType<typeof parseDraftRewardConfiguration>['entries'][number]['weight'],
    };
    const manifest = createOpeningV2PublishedManifest({
      boxId: parseBoxId('019c0000-0000-7000-8000-000000000010'),
      boxVersionId: parseBoxVersionId('019c0000-0000-7000-8000-000000000020'),
      entries: [entry],
      maxOpeningsPerUser: 3n,
    });
    expect(manifest).not.toHaveProperty('priceMinor');
    expect(manifest).not.toHaveProperty('currency');
    expect(manifest.maxOpeningsPerUser).toBe('3');
    expect(canonicalizePublishedManifest(manifest)).toContain(
      '"openingCompatibilityVersion":"opening-v2"',
    );
  });
});
