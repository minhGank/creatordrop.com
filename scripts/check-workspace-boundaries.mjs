import { readFile } from 'node:fs/promises';

const rootManifest = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);
const workspacePaths = rootManifest.workspaces;

if (!Array.isArray(workspacePaths) || workspacePaths.length === 0) {
  throw new Error('Root package.json must declare explicit npm workspaces.');
}

const seenNames = new Set();

for (const workspacePath of workspacePaths) {
  const manifestUrl = new URL(`../${workspacePath}/package.json`, import.meta.url);
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));

  if (manifest.private !== true) {
    throw new Error(`${workspacePath} must remain private during pre-release development.`);
  }

  if (typeof manifest.name !== 'string' || seenNames.has(manifest.name)) {
    throw new Error(`${workspacePath} must have a unique package name.`);
  }

  seenNames.add(manifest.name);

  if (workspacePath.startsWith('packages/')) {
    const dependencyNames = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
    });

    if (dependencyNames.some((dependencyName) => dependencyName.startsWith('@creatordrop/app-'))) {
      throw new Error(`${manifest.name} must not depend on an application workspace.`);
    }
  }
}

process.stdout.write(`Validated ${seenNames.size} workspace boundaries.\n`);
