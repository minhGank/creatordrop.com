import { describe, expect, it } from 'vitest';

import type { QueryExecutor } from '@creatordrop/database';

import { revealSeedSet } from '../src/modules/fairness/fairness.repository.js';
import type { RngSeedSetId } from '../src/modules/fairness/fairness.js';

const seedSetId = '019c0000-0000-7000-8000-000000000020' as RngSeedSetId;
const timestamp = '2026-08-23T12:00:00.000Z';

const revealedRow = (serverSeed: Uint8Array) => ({
  algorithmVersion: 'hmac-sha256-rejection-v1',
  authenticationTag: new Uint8Array(16),
  ciphertext: new Uint8Array(32),
  commitment: '01'.repeat(32),
  compromisedAt: null,
  createdAt: new Date('2026-08-22T12:00:00.000Z'),
  encryptionIv: new Uint8Array(12),
  encryptionKeyIdentity: '02'.repeat(32),
  encryptionKeyVersion: 'synthetic-v1',
  id: seedSetId,
  maxNonceExclusive: '1000',
  nextNonce: '0',
  retirementReason: 'user_request',
  retiredAt: new Date('2026-08-23T11:00:00.000Z'),
  revealedAt: new Date(timestamp),
  revealedServerSeed: serverSeed,
  rotateAfter: new Date('2026-08-23T11:00:00.000Z'),
  status: 'revealed',
  userId: '019c0000-0000-7000-8000-000000000001',
});

describe('fairness repository secret ownership', () => {
  it.each(['success', 'failure'] as const)(
    'wipes the repository-owned plaintext parameter after %s',
    async (outcome) => {
      const serverSeed = new Uint8Array(32).fill(7);
      let databaseParameter: Uint8Array | undefined;
      const executor = {
        query: (_text: string, values: readonly unknown[] = []) => {
          const parameter = values[1];
          if (!(parameter instanceof Uint8Array)) {
            return Promise.reject(
              new Error('Expected a byte-valued plaintext database parameter.'),
            );
          }
          databaseParameter = parameter;
          if (outcome === 'failure') return Promise.reject(new Error('synthetic database failure'));
          return Promise.resolve({
            command: 'UPDATE',
            fields: [],
            oid: 0,
            rowCount: 1,
            rows: [revealedRow(serverSeed)],
          });
        },
      } as unknown as QueryExecutor;

      if (outcome === 'failure') {
        await expect(revealSeedSet(executor, seedSetId, serverSeed, timestamp)).rejects.toThrow(
          'synthetic database failure',
        );
      } else {
        await expect(
          revealSeedSet(executor, seedSetId, serverSeed, timestamp),
        ).resolves.toMatchObject({
          id: seedSetId,
          revealedServerSeed: '07'.repeat(32),
          status: 'revealed',
        });
      }

      const wipedParameter = databaseParameter;
      if (wipedParameter === undefined) throw new Error('Expected a captured database parameter.');
      expect([...wipedParameter]).toEqual([...new Uint8Array(32)]);
      expect(serverSeed).toEqual(new Uint8Array(32).fill(7));
    },
  );
});
