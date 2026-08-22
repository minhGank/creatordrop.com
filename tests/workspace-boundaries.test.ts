import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

type DependencyField =
  'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies';

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const createBoundaryFixture = async (input: {
  readonly dependencyField?: DependencyField;
  readonly generatorSource?: string;
  readonly verifierSource?: string;
}): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'creatordrop-boundary-'));
  temporaryRoots.push(root);
  await Promise.all([
    mkdir(join(root, 'packages/domain/src'), { recursive: true }),
    mkdir(join(root, 'packages/rng-verifier/src'), { recursive: true }),
    mkdir(join(root, 'scripts'), { recursive: true }),
  ]);
  await writeJson(join(root, 'package.json'), {
    private: true,
    workspaces: ['packages/domain', 'packages/rng-verifier'],
  });
  await writeJson(join(root, 'packages/domain/package.json'), {
    name: '@creatordrop/domain',
    private: true,
    version: '0.0.0',
  });
  const verifierManifest: Record<string, unknown> = {
    name: '@creatordrop/rng-verifier',
    private: true,
    version: '0.0.0',
  };
  if (input.dependencyField !== undefined) {
    verifierManifest[input.dependencyField] = { '@creatordrop/domain': '*' };
  }
  await writeJson(join(root, 'packages/rng-verifier/package.json'), verifierManifest);
  await Promise.all([
    writeFile(join(root, 'packages/domain/src/index.ts'), 'export {};\n', 'utf8'),
    writeFile(
      join(root, 'packages/rng-verifier/src/index.ts'),
      input.verifierSource ?? 'export {};\n',
      'utf8',
    ),
    writeFile(
      join(root, 'scripts/generate-rng-test-vectors.mjs'),
      input.generatorSource ?? "import 'node:crypto';\n",
      'utf8',
    ),
  ]);
  return root;
};

const runBoundaryCheck = async (root?: string) =>
  execFileAsync('node', [
    'scripts/check-workspace-boundaries.mjs',
    ...(root === undefined ? [] : ['--root', root]),
  ]);

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe('workspace boundaries', () => {
  it('accepts the declared dependency direction and protected source graph', async () => {
    const { stderr, stdout } = await runBoundaryCheck();

    expect(stderr).toBe('');
    expect(stdout).toMatch(/^Validated \d+ workspace boundaries\.\n$/u);
  });

  it.each<DependencyField>([
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ])('rejects verifier production-domain declarations in %s', async (dependencyField) => {
    const root = await createBoundaryFixture({ dependencyField });
    await expect(runBoundaryCheck(root)).rejects.toThrow(
      /must not depend on the production domain/iu,
    );
  });

  it.each([
    ['normal package import', "import '@creatordrop/domain';\n"],
    ['deep package import', "import '@creatordrop/domain/rng/private';\n"],
    ['dynamic package import', "await import('@creatordrop/domain');\n"],
    ['relative cross-workspace import', "import '../../domain/src/index.js';\n"],
  ])('rejects verifier %s', async (_name, verifierSource) => {
    const root = await createBoundaryFixture({ verifierSource });
    await expect(runBoundaryCheck(root)).rejects.toThrow(/Protected RNG source/iu);
  });

  it.each([
    ['production package import', "import '@creatordrop/domain';\n"],
    ['production deep import', "import '@creatordrop/domain/rng/private';\n"],
    ['dynamic verifier import', "await import('@creatordrop/rng-verifier');\n"],
    ['relative production import', "import '../packages/domain/src/index.js';\n"],
  ])('rejects vector-generator %s', async (_name, generatorSource) => {
    const root = await createBoundaryFixture({ generatorSource });
    await expect(runBoundaryCheck(root)).rejects.toThrow(/Protected RNG source/iu);
  });
});
