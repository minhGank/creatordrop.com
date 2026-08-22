import { readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
const sourceExtensionPattern = /\.(?:[cm]?[jt]sx?)$/u;

const rootArgumentIndex = process.argv.indexOf('--root');
if (rootArgumentIndex >= 0 && process.argv[rootArgumentIndex + 1] === undefined) {
  throw new Error('--root requires a repository fixture path.');
}
const repositoryRoot =
  rootArgumentIndex >= 0
    ? resolve(process.argv[rootArgumentIndex + 1])
    : fileURLToPath(new URL('..', import.meta.url));

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const rootManifest = await readJson(resolve(repositoryRoot, 'package.json'));
const workspacePaths = rootManifest.workspaces;

if (!Array.isArray(workspacePaths) || workspacePaths.length === 0) {
  throw new Error('Root package.json must declare explicit npm workspaces.');
}

const dependencyNames = (manifest) =>
  dependencyFields.flatMap((field) => {
    const values = manifest[field];
    return typeof values === 'object' && values !== null && !Array.isArray(values)
      ? Object.keys(values)
      : [];
  });

const workspaceRecords = [];
const seenNames = new Set();
for (const workspacePath of workspacePaths) {
  const absolutePath = resolve(repositoryRoot, workspacePath);
  const manifest = await readJson(resolve(absolutePath, 'package.json'));

  if (manifest.private !== true) {
    throw new Error(`${workspacePath} must remain private during pre-release development.`);
  }
  if (typeof manifest.name !== 'string' || seenNames.has(manifest.name)) {
    throw new Error(`${workspacePath} must have a unique package name.`);
  }

  seenNames.add(manifest.name);
  workspaceRecords.push({
    absolutePath,
    dependencies: dependencyNames(manifest),
    manifest,
    name: manifest.name,
    workspacePath,
  });
}

const recordByName = new Map(workspaceRecords.map((record) => [record.name, record]));
const importsPackage = (specifier, packageName) =>
  specifier === packageName || specifier.startsWith(`${packageName}/`);
const pathIsWithin = (parent, candidate) => {
  const childPath = relative(parent, candidate);
  return childPath === '' || (!childPath.startsWith(`..${sep}`) && !isAbsolute(childPath));
};
const workspaceForPath = (candidate) =>
  workspaceRecords.find((record) => pathIsWithin(record.absolutePath, candidate));
const workspaceForSpecifier = (specifier) =>
  workspaceRecords.find((record) => importsPackage(specifier, record.name));

const dependencyReaches = (dependencyName, forbiddenNames, visited = new Set()) => {
  if (forbiddenNames.some((name) => importsPackage(dependencyName, name))) return true;
  const record = workspaceForSpecifier(dependencyName);
  if (record === undefined || visited.has(record.name)) return false;
  visited.add(record.name);
  return record.dependencies.some((nested) => dependencyReaches(nested, forbiddenNames, visited));
};

for (const record of workspaceRecords) {
  if (
    record.workspacePath.startsWith('packages/') &&
    record.dependencies.some((dependencyName) => dependencyName.startsWith('@creatordrop/app-'))
  ) {
    throw new Error(`${record.name} must not depend on an application workspace.`);
  }
}

const verifier = recordByName.get('@creatordrop/rng-verifier');
const productionDomain = recordByName.get('@creatordrop/domain');
if (verifier === undefined || productionDomain === undefined) {
  throw new Error('The RNG verifier and production domain workspaces must both be declared.');
}
if (
  verifier.dependencies.some((dependencyName) =>
    dependencyReaches(dependencyName, [productionDomain.name]),
  )
) {
  throw new Error('The independent RNG verifier must not depend on the production domain.');
}

const collectSourceFiles = async (root) => {
  const files = [];
  const visitDirectory = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'dist' || entry.name === 'node_modules') continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visitDirectory(path);
      else if (entry.isFile() && sourceExtensionPattern.test(entry.name)) files.push(path);
    }
  };
  await visitDirectory(root);
  return files;
};

const moduleSpecifiers = (path, source) => {
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const specifiers = [];
  const literalText = (node) =>
    ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) {
        const specifier = literalText(node.moduleSpecifier);
        if (specifier !== undefined) specifiers.push(specifier);
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined
    ) {
      const specifier = literalText(node.moduleReference.expression);
      if (specifier !== undefined) specifiers.push(specifier);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const argument = node.arguments[0];
      const specifier = argument === undefined ? undefined : literalText(argument);
      if (specifier === undefined) {
        throw new Error(
          `Protected RNG source ${relative(repositoryRoot, path)} uses a nonliteral import.`,
        );
      }
      specifiers.push(specifier);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return specifiers;
};

const checkProtectedSource = async (path, forbiddenNames) => {
  const source = await readFile(path, 'utf8');
  for (const specifier of moduleSpecifiers(path, source)) {
    if (forbiddenNames.some((name) => importsPackage(specifier, name))) {
      throw new Error(
        `Protected RNG source ${relative(repositoryRoot, path)} imports forbidden ${specifier}.`,
      );
    }
    const target =
      specifier.startsWith('.') || isAbsolute(specifier)
        ? workspaceForPath(resolve(dirname(path), specifier))
        : workspaceForSpecifier(specifier);
    if (
      target !== undefined &&
      (forbiddenNames.includes(target.name) ||
        target.dependencies.some((dependencyName) =>
          dependencyReaches(dependencyName, forbiddenNames),
        ))
    ) {
      throw new Error(
        `Protected RNG source ${relative(repositoryRoot, path)} reaches forbidden workspace ${target.name}.`,
      );
    }
  }
};

for (const path of await collectSourceFiles(verifier.absolutePath)) {
  await checkProtectedSource(path, [productionDomain.name]);
}
const generatorPath = resolve(repositoryRoot, 'scripts/generate-rng-test-vectors.mjs');
await checkProtectedSource(generatorPath, [productionDomain.name, verifier.name]);

process.stdout.write(`Validated ${seenNames.size} workspace boundaries.\n`);
