import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const migrationDirectory = fileURLToPath(new URL('../infra/supabase/migrations/', import.meta.url));
const migrationNamePattern = /^(?<version>\d{14})_[a-z][a-z0-9_]*\.sql$/u;
const entries = await readdir(migrationDirectory, { withFileTypes: true });
const migrationFiles = entries
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .sort();

if (migrationFiles.length === 0) {
  throw new Error('At least one SQL migration is required.');
}

const seenVersions = new Set();

for (const fileName of migrationFiles) {
  const match = migrationNamePattern.exec(fileName);

  if (match?.groups === undefined) {
    throw new Error(`Invalid migration filename: ${fileName}`);
  }

  const version = match.groups['version'];

  if (version === undefined || seenVersions.has(version)) {
    throw new Error(`Duplicate or missing migration version in: ${fileName}`);
  }

  seenVersions.add(version);
}

process.stdout.write(`Validated ${migrationFiles.length} ordered SQL migration file(s).\n`);
