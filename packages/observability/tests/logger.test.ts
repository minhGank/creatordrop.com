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

  it('redacts sensitive attributes and prevents reserved-field replacement', () => {
    const lines: string[] = [];
    const logger = createConsoleLogger({
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      service: 'test-service',
      write: (line) => lines.push(line),
    });

    logger.error('request.failed', {
      authorization: 'Bearer synthetic-token-that-must-not-appear',
      password: 'synthetic-password-that-must-not-appear',
      requestId: 'request-123',
      service: 'replacement-service',
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('synthetic-token-that-must-not-appear');
    expect(lines[0]).not.toContain('synthetic-password-that-must-not-appear');
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      authorization: '[REDACTED]',
      level: 'error',
      message: 'request.failed',
      password: '[REDACTED]',
      requestId: 'request-123',
      service: 'test-service',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
  });
});
