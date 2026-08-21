import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const readLocalSupabaseEnvironment = async () => {
  let stdout;

  try {
    ({ stdout } = await execFileAsync(
      'supabase',
      ['status', '--workdir', 'infra', '--output', 'json'],
      { encoding: 'utf8' },
    ));
  } catch {
    throw new Error('Local Supabase is unavailable. Run npm run db:start first.');
  }

  const status = JSON.parse(stdout);
  const apiUrl = status.API_URL;
  const publishableKey = status.PUBLISHABLE_KEY ?? status.ANON_KEY;

  if (typeof apiUrl !== 'string' || typeof publishableKey !== 'string') {
    throw new Error('The local Supabase status did not include Auth connection details.');
  }

  return { apiUrl, publishableKey };
};

const { apiUrl, publishableKey } = await readLocalSupabaseEnvironment();
const child = spawn(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    '--config',
    'vitest.integration.config.ts',
    '--passWithNoTests',
  ],
  {
    env: {
      ...process.env,
      LOCAL_SUPABASE_API_URL: apiUrl,
      LOCAL_SUPABASE_PUBLISHABLE_KEY: publishableKey,
    },
    stdio: 'inherit',
  },
);

child.once('error', () => {
  process.stderr.write('Unable to launch the integration test runner.\n');
  process.exitCode = 1;
});

child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
