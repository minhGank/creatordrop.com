import { spawn } from 'node:child_process';

const excludedServices = [
  'realtime',
  'imgproxy',
  'mailpit',
  'postgrest',
  'postgres-meta',
  'studio',
  'edge-runtime',
  'logflare',
  'vector',
  'supavisor',
].join(',');

const child = spawn('supabase', ['start', '--workdir', 'infra', '--exclude', excludedServices], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

let diagnosticOutput = '';
child.stdout?.setEncoding('utf8');
child.stdout?.on('data', (chunk) => {
  diagnosticOutput += chunk;
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  diagnosticOutput += chunk;
});

child.once('error', () => {
  process.stderr.write('Unable to launch the local Supabase CLI.\n');
  process.exitCode = 1;
});

child.once('exit', (code) => {
  if (code === 0) {
    process.stdout.write(
      'Local Supabase PostgreSQL, Auth, and private Storage services are ready.\n',
    );
    return;
  }

  const safeDiagnostic = diagnosticOutput
    .split('\n')
    .map((line) =>
      /^\s*(?:ANON_KEY|PUBLISHABLE_KEY|SECRET_KEY|SERVICE_ROLE_KEY)\s*[:=]/u.test(line)
        ? '[credential output redacted]'
        : line
            .replace(/eyJ[A-Za-z0-9._-]+/gu, '[JWT redacted]')
            .replace(/sb_(?:publishable|secret)_[A-Za-z0-9_-]+/gu, '[API key redacted]'),
    )
    .slice(-40)
    .join('\n');

  process.stderr.write(`Local Supabase failed to start.${safeDiagnostic}\n`);
  process.exitCode = code ?? 1;
});
