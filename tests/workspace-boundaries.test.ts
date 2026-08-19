import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('workspace boundaries', () => {
  it('accepts the declared dependency direction', async () => {
    const { stderr, stdout } = await execFileAsync('node', [
      'scripts/check-workspace-boundaries.mjs',
    ]);

    expect(stderr).toBe('');
    expect(stdout).toMatch(/^Validated \d+ workspace boundaries\.\n$/u);
  });
});
