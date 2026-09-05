import type { QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';

import type { Database, QueryExecutor, TransactionExecutor } from '@creatordrop/database';
import { hashPublishedManifest } from '@creatordrop/domain';

import { createFairnessService } from '../src/modules/fairness/fairness.service.js';
import type { RngSeedSetStatus } from '../src/modules/fairness/fairness.js';
import { createNoopLogger } from './support/test-app.js';

const openingId = '019c0000-0000-7000-8000-000000000001';
const boxId = '019c0000-0000-7000-8000-000000000002';
const boxVersionId = '019c0000-0000-7000-8000-000000000003';
const entryId = '019c0000-0000-7000-8000-000000000004';
const rewardVersionId = '019c0000-0000-7000-8000-000000000005';
const seedSetId = '019c0000-0000-7000-8000-000000000006';
const manifest = {
  algorithmVersion: 'hmac-sha256-rejection-v1' as const,
  boxId,
  boxVersionId,
  currency: 'USD',
  entries: [{ boxVersionRewardId: entryId, position: 0, rewardVersionId, weight: '1' }],
  priceMinor: '999',
  totalWeight: '1',
};
const configurationHash = hashPublishedManifest(manifest);

const queryResult = <Row extends QueryResultRow>(rows: readonly Row[]): QueryResult<Row> => ({
  command: 'SELECT',
  fields: [],
  oid: 0,
  rowCount: rows.length,
  rows: [...rows],
});

const databaseFor = (status: RngSeedSetStatus): Database => {
  const query: QueryExecutor['query'] = <Row extends QueryResultRow>(text: string) => {
    const rows = text.includes('from app.box_opens')
      ? [
          {
            acceptedDigestHex: '11'.repeat(32),
            acceptedRound: '0',
            algorithmVersion: 'hmac-sha256-rejection-v1',
            boxId,
            boxVersionId,
            clientSeed: '22'.repeat(32),
            configurationHash,
            currency: 'USD',
            manifestConfigurationHash: configurationHash,
            nonce: '0',
            openedAt: new Date('2026-09-05T00:00:00.000Z'),
            openingId,
            position: 0,
            priceMinor: '999',
            revealedServerSeedHex: status === 'revealed' ? '33'.repeat(32) : null,
            rewardVersionId,
            seedAlgorithmVersion: 'hmac-sha256-rejection-v1',
            seedCommitment: '44'.repeat(32),
            seedSetId,
            seedStatus: status,
            selectedBoxVersionRewardId: entryId,
            selectionValue: '0',
            serverSeedCommitment: '44'.repeat(32),
            totalWeight: '1',
          },
        ]
      : [{ boxVersionRewardId: entryId, position: 0, rewardVersionId, weight: '1' }];
    return Promise.resolve(queryResult(rows as unknown as Row[]));
  };
  const executor = { query } as TransactionExecutor;
  return {
    close: () => Promise.resolve(),
    query,
    transaction: async (callback, options) => {
      expect(options).toEqual({ isolationLevel: 'repeatable-read', readOnly: true });
      return callback(executor);
    },
  };
};

const serviceFor = (status: RngSeedSetStatus) =>
  createFairnessService({
    database: databaseFor(status),
    keyProvider: {
      getActiveEncryptionKey: () => Promise.reject(new Error('not used')),
      getEncryptionKey: () => Promise.reject(new Error('not used')),
    },
    logger: createNoopLogger(),
    policy: { maxAgeMs: 60_000, maxOpenings: 1n },
  });

describe('opening fairness proof service', () => {
  it.each([
    ['active', 'pending_reveal'],
    ['retired', 'pending_reveal'],
    ['compromised', 'unverifiable'],
  ] as const)('maps %s history to %s without exposing a server seed', async (status, expected) => {
    const proof = await serviceFor(status).getOpeningProof(openingId);
    expect(proof.verificationStatus).toBe(expected);
    expect(proof).not.toHaveProperty('serverSeedHex');
    expect(proof).toMatchObject({ configurationHash, manifest, openingId });
  });

  it('includes the revealed seed only when proof material is ready', async () => {
    const proof = await serviceFor('revealed').getOpeningProof(openingId);
    expect(proof.verificationStatus).toBe('ready');
    expect(proof.serverSeedHex).toBe('33'.repeat(32));
  });
});
