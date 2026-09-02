import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const containerName = 'creatordrop-phase13-redis';
export const localRedisUrl = 'redis://127.0.0.1:56379';

const inspectRunning = async () => {
  try {
    const { stdout } = await execFileAsync('docker', [
      'inspect',
      '--format',
      '{{.State.Running}}',
      containerName,
    ]);
    return stdout.trim() === 'true' ? 'running' : 'stopped';
  } catch {
    return 'missing';
  }
};

const waitUntilReady = async () => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const { stdout } = await execFileAsync('docker', [
        'exec',
        containerName,
        'redis-cli',
        'PING',
      ]);
      if (stdout.trim() === 'PONG') return;
    } catch {
      // The bounded readiness loop reports one stable failure below.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Local Redis did not become ready.');
};

export const ensureLocalRedis = async () => {
  const state = await inspectRunning();
  if (state === 'running') {
    await waitUntilReady();
    return { started: false };
  }
  if (state === 'stopped') {
    await execFileAsync('docker', ['start', containerName]);
  } else {
    await execFileAsync('docker', [
      'run',
      '--detach',
      '--name',
      containerName,
      '--publish',
      '127.0.0.1:56379:6379',
      '--rm',
      'redis:7.4-alpine',
      'redis-server',
      '--save',
      '',
      '--appendonly',
      'no',
    ]);
  }
  await waitUntilReady();
  return { started: true };
};

export const stopLocalRedis = async () => {
  if ((await inspectRunning()) === 'running') {
    await execFileAsync('docker', ['stop', '--time', '5', containerName]);
  }
};
