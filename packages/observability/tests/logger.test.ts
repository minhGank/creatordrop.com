import { describe, expect, it } from 'vitest';

import { createConsoleLogger } from '../src/index.js';

describe('console logger', () => {
  it('writes structured service messages with an injected clock', () => {
    const lines: string[] = [];
    const logger = createConsoleLogger({
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      service: 'test-service',
      write: (line) => lines.push(line),
    });

    logger.info('started');

    expect(lines).toEqual([
      '{"level":"info","message":"started","service":"test-service","timestamp":"2026-01-01T00:00:00.000Z"}',
    ]);
  });
});
