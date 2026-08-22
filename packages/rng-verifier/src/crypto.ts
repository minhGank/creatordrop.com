import { createHmac } from 'node:crypto';

export type VerifierDigestSource = (round: bigint) => Uint8Array;

export const buildVerifierHmacMessage = (
  seedSetId: string,
  clientSeed: string,
  nonce: string,
  round: bigint,
): string => `creatordrop:rng:v1|${seedSetId}|${clientSeed}|${nonce}|${round.toString()}`;

export const createVerifierHmacDigestSource =
  (input: {
    readonly clientSeed: string;
    readonly nonce: string;
    readonly seedSetId: string;
    readonly serverSeed: Uint8Array;
  }): VerifierDigestSource =>
  (round) =>
    Uint8Array.from(
      createHmac('sha256', input.serverSeed)
        .update(
          buildVerifierHmacMessage(input.seedSetId, input.clientSeed, input.nonce, round),
          'utf8',
        )
        .digest(),
    );
