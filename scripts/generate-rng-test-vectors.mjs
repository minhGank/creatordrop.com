import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const algorithmVersion = 'hmac-sha256-rejection-v1';
const unsigned256Range = 1n << 256n;
const vectorUrl = new URL('../test-vectors/rng/hmac-sha256-rejection-v1.json', import.meta.url);
const primitiveVectorUrl = new URL(
  '../test-vectors/rng/hmac-sha256-rejection-v1-primitives.json',
  import.meta.url,
);

const sha256 = (value) => createHash('sha256').update(value).digest();
const hex = (value) => Buffer.from(value).toString('hex');
const uuid = (vector, kind, entry = 0) =>
  `${vector.toString(16).padStart(8, '0')}-${kind.toString(16).padStart(4, '0')}-7000-8000-${entry.toString(16).padStart(12, '0')}`;
const quote = (value) => JSON.stringify(value);
const digestHex = (value) => value.toString(16).padStart(64, '0');

const canonicalizeManifest = (manifest) => {
  const entries = manifest.entries
    .map(
      (entry) =>
        `{"boxVersionRewardId":${quote(entry.boxVersionRewardId)},"position":${entry.position},"rewardVersionId":${quote(entry.rewardVersionId)},"weight":${quote(entry.weight)}}`,
    )
    .join(',');
  return `{"algorithmVersion":${quote(manifest.algorithmVersion)},"boxId":${quote(manifest.boxId)},"boxVersionId":${quote(manifest.boxVersionId)},"currency":${quote(manifest.currency)},"entries":[${entries}],"priceMinor":${quote(manifest.priceMinor)},"totalWeight":${quote(manifest.totalWeight)}}`;
};

const configurations = [
  ['1'],
  ['5', '20', '75'],
  ['1', '1'],
  ['9223372036854775805', '1', '1'],
  ['5', '100', '395'],
  ['3', '7', '11', '13'],
  ['1000', '1'],
  ['9', '90', '900'],
  ['2', '3', '5', '7', '11'],
  ['79', '20', '1'],
];
const nonces = [
  '0',
  '1',
  '7',
  '42',
  '99',
  '1000',
  '65535',
  '4294967296',
  '9007199254740993',
  '9223372036854775807',
];

const vectors = configurations.map((weights, zeroBasedIndex) => {
  const index = zeroBasedIndex + 1;
  const serverSeed = sha256(`CreatorDrop synthetic server seed vector ${index.toString()}`);
  const clientSeed = hex(sha256(`CreatorDrop synthetic client seed vector ${index.toString()}`));
  const seedSetId = uuid(index, 1);
  const totalWeight = weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
  const manifest = {
    algorithmVersion,
    boxId: uuid(index, 2),
    boxVersionId: uuid(index, 3),
    currency: index % 2 === 0 ? 'CAD' : 'USD',
    entries: weights.map((weight, position) => ({
      boxVersionRewardId: uuid(index, 4, position + 1),
      position,
      rewardVersionId: uuid(index, 5, position + 1),
      weight,
    })),
    priceMinor: (1000n + BigInt(index)).toString(),
    totalWeight: totalWeight.toString(),
  };
  const manifestHash = createHash('sha256')
    .update(canonicalizeManifest(manifest), 'utf8')
    .digest('hex');
  const limit = (unsigned256Range / totalWeight) * totalWeight;
  const roundDigests = [];
  let round = 0n;
  let acceptedDigestHex;
  let selectionValue;
  for (;;) {
    const message = `creatordrop:rng:v1|${seedSetId}|${clientSeed}|${nonces[zeroBasedIndex]}|${round.toString()}`;
    const digestHex = createHmac('sha256', serverSeed).update(message, 'utf8').digest('hex');
    roundDigests.push({ digestHex, round: round.toString() });
    const candidate = BigInt(`0x${digestHex}`);
    if (candidate < limit) {
      acceptedDigestHex = digestHex;
      selectionValue = candidate % totalWeight;
      break;
    }
    round += 1n;
  }
  let start = 0n;
  const winner = manifest.entries.find((entry) => {
    const end = start + BigInt(entry.weight);
    const selected = selectionValue >= start && selectionValue < end;
    start = end;
    return selected;
  });
  if (winner === undefined || acceptedDigestHex === undefined || selectionValue === undefined) {
    throw new Error('Reference vector generation did not select a reward.');
  }
  return {
    acceptedDigestHex,
    acceptedRound: round.toString(),
    clientSeed,
    manifest,
    manifestHash,
    name: `synthetic-vector-${index.toString().padStart(2, '0')}`,
    nonce: nonces[zeroBasedIndex],
    roundDigests,
    seedSetId,
    selectionValue: selectionValue.toString(),
    serverSeedCommitment: hex(sha256(serverSeed)),
    serverSeedHex: hex(serverSeed),
    winningEntry: winner,
  };
});

const createRejectionCase = (name, totalWeightInput, candidates) => {
  const totalWeight = BigInt(totalWeightInput);
  const limit = (unsigned256Range / totalWeight) * totalWeight;
  const digests = candidates.map((candidate, round) => ({
    digestHex: digestHex(candidate),
    round: round.toString(),
  }));
  const acceptedIndex = candidates.findIndex((candidate) => candidate < limit);
  if (acceptedIndex < 0) throw new Error('Reference rejection case has no accepted digest.');
  const acceptedCandidate = candidates[acceptedIndex];
  if (acceptedCandidate === undefined) {
    throw new Error('Reference rejection case did not retain its accepted digest.');
  }
  return {
    acceptedDigestHex: digestHex(acceptedCandidate),
    acceptedRound: acceptedIndex.toString(),
    digests,
    limit: limit.toString(),
    name,
    selectionValue: (acceptedCandidate % totalWeight).toString(),
    totalWeight: totalWeight.toString(),
  };
};

const hmacSource = vectors[0];
if (hmacSource === undefined) throw new Error('Expected a source vector for the HMAC fixture.');
const hmacRound = 10n;
const hmacMessage = `creatordrop:rng:v1|${hmacSource.seedSetId}|${hmacSource.clientSeed}|${hmacSource.nonce}|${hmacRound.toString()}`;
const primitiveDocument = {
  algorithmVersion,
  description:
    'Language-neutral primitive fixtures for nonzero-round HMAC and crafted rejection boundaries.',
  generator: 'scripts/generate-rng-test-vectors.mjs',
  hmacCases: [
    {
      clientSeed: hmacSource.clientSeed,
      digestHex: createHmac('sha256', Buffer.from(hmacSource.serverSeedHex, 'hex'))
        .update(hmacMessage, 'utf8')
        .digest('hex'),
      message: hmacMessage,
      name: 'nonzero-round-10',
      nonce: hmacSource.nonce,
      round: hmacRound.toString(),
      seedSetId: hmacSource.seedSetId,
      serverSeedHex: hmacSource.serverSeedHex,
    },
  ],
  rejectionCases: [
    (() => {
      const weight = 10n;
      const limit = (unsigned256Range / weight) * weight;
      return createRejectionCase('limit-minus-one', weight, [limit - 1n]);
    })(),
    (() => {
      const weight = 10n;
      const limit = (unsigned256Range / weight) * weight;
      return createRejectionCase('limit-limit-plus-one-then-seven', weight, [
        limit,
        limit + 1n,
        7n,
      ]);
    })(),
  ],
  schemaVersion: 1,
};

const document = {
  algorithmVersion,
  description:
    'Synthetic language-neutral CreatorDrop Phase 6 vectors. These values are public test fixtures, not active secrets.',
  generator: 'scripts/generate-rng-test-vectors.mjs',
  schemaVersion: 1,
  vectors,
};
const output = `${JSON.stringify(document, null, 2)}\n`;
const primitiveOutput = `${JSON.stringify(primitiveDocument, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const [existing, existingPrimitives] = await Promise.all([
    readFile(vectorUrl, 'utf8'),
    readFile(primitiveVectorUrl, 'utf8'),
  ]);
  if (existing !== output || existingPrimitives !== primitiveOutput) {
    throw new Error('RNG test vectors are not reproducible.');
  }
  process.stdout.write(
    `Validated ${vectors.length.toString()} RNG vectors and ${primitiveDocument.rejectionCases.length.toString()} rejection fixtures.\n`,
  );
} else if (process.argv.includes('--primitives')) {
  process.stdout.write(primitiveOutput);
} else {
  process.stdout.write(output);
}
