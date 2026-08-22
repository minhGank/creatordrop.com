import { describe, expect, it } from 'vitest';

import {
  parseBoxDraftInput,
  parseBoxId,
  parseBoxVersionId,
  parseDraftRewardConfiguration,
  parseExpectedCatalogRevision,
  parseRewardDraftInput,
} from '../src/modules/catalog/catalog.schema.js';

describe('catalog request validation', () => {
  it('normalizes valid UUID route parameters to canonical lowercase text', () => {
    expect(parseBoxId('019C0000-0000-7000-8000-000000000010')).toBe(
      '019c0000-0000-7000-8000-000000000010',
    );
    expect(parseBoxVersionId('019C0000-0000-7000-8000-000000000020')).toBe(
      '019c0000-0000-7000-8000-000000000020',
    );
  });

  it('parses decimal-string money without floating point', () => {
    const input = parseBoxDraftInput({
      currency: 'USD',
      description: '  Description  ',
      imageUrl: 'https://example.test/box.png',
      name: '  Mystery Box  ',
      priceMinor: '1000',
    });
    expect(input.priceMinor).toBe(1000n);
    expect(input.name).toBe('Mystery Box');
    expect(input.description).toBe('Description');
  });

  it.each(['0', '-1', '1.5', 1000, '01', '9223372036854775808'])(
    'rejects invalid priceMinor %j',
    (priceMinor) => {
      expect(() =>
        parseBoxDraftInput({
          currency: 'USD',
          description: '',
          name: 'Box',
          priceMinor,
        }),
      ).toThrow();
    },
  );

  it('supports unlimited and finite inventory with paired declared values', () => {
    expect(
      parseRewardDraftInput({
        declaredValueCurrency: null,
        declaredValueMinor: null,
        description: '',
        inventoryMode: 'unlimited',
        inventoryQuantity: null,
        name: 'Digital Reward',
        rewardType: 'digital',
      }).inventoryQuantity,
    ).toBeNull();
    expect(
      parseRewardDraftInput({
        declaredValueCurrency: 'USD',
        declaredValueMinor: '2500',
        description: '',
        inventoryMode: 'finite',
        inventoryQuantity: '0',
        name: 'Physical Reward',
        rewardType: 'physical',
      }).inventoryQuantity,
    ).toBe(0n);
  });

  it.each([
    { inventoryMode: 'unlimited', inventoryQuantity: '1' },
    { inventoryMode: 'finite', inventoryQuantity: '-1' },
    { inventoryMode: 'finite', inventoryQuantity: 3 },
  ])('rejects invalid inventory configuration: %o', (inventory) => {
    expect(() =>
      parseRewardDraftInput({
        description: '',
        name: 'Reward',
        rewardType: 'digital',
        ...inventory,
      }),
    ).toThrow();
  });

  it('rejects zero, negative, duplicate, and non-string draft weights', () => {
    for (const weight of ['0', '-1', '1.5', 1]) {
      expect(() =>
        parseDraftRewardConfiguration({
          entries: [{ rewardVersionId: '019c0000-0000-7000-8000-000000000040', weight }],
        }),
      ).toThrow();
    }
    expect(() =>
      parseDraftRewardConfiguration({
        entries: [
          { rewardVersionId: '019c0000-0000-7000-8000-000000000040', weight: '1' },
          { rewardVersionId: '019c0000-0000-7000-8000-000000000040', weight: '2' },
        ],
      }),
    ).toThrow();
  });

  it('requires quoted optimistic revisions', () => {
    expect(parseExpectedCatalogRevision('"7"')).toBe(7);
    expect(() => parseExpectedCatalogRevision(undefined)).toThrow();
    expect(() => parseExpectedCatalogRevision('7')).toThrow();
  });
});
