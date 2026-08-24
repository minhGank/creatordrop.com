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
      active_server_seed: 'synthetic-active-seed-that-must-not-appear',
      authorization: 'Bearer synthetic-token-that-must-not-appear',
      ciphertext: 'synthetic-ciphertext-that-must-not-appear',
      encryptionAuthTag: 'synthetic-auth-tag-that-must-not-appear',
      encryption_iv: 'synthetic-iv-that-must-not-appear',
      idempotencyKey: 'synthetic-idempotency-key-that-must-not-appear',
      password: 'synthetic-password-that-must-not-appear',
      requestId: 'request-123',
      RNG_MASTER_KEY: 'synthetic-master-key-that-must-not-appear',
      rng_server_seed_ciphertext: 'synthetic-prefixed-ciphertext-that-must-not-appear',
      server_seed_ciphertext: 'synthetic-db-ciphertext-that-must-not-appear',
      server_seed_hex: 'synthetic-server-seed-that-must-not-appear',
      service: 'replacement-service',
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('synthetic-token-that-must-not-appear');
    expect(lines[0]).not.toContain('synthetic-password-that-must-not-appear');
    expect(lines[0]).not.toContain('synthetic-server-seed-that-must-not-appear');
    expect(lines[0]).not.toContain('synthetic-ciphertext-that-must-not-appear');
    expect(lines[0]).not.toContain('synthetic-master-key-that-must-not-appear');
    expect(lines[0]).not.toContain('synthetic-active-seed-that-must-not-appear');
    expect(lines[0]).not.toContain('synthetic-auth-tag-that-must-not-appear');
    expect(lines[0]).not.toContain('synthetic-iv-that-must-not-appear');
    expect(lines[0]).not.toContain('synthetic-idempotency-key-that-must-not-appear');
    expect(lines[0]).not.toContain('synthetic-prefixed-ciphertext-that-must-not-appear');
    expect(lines[0]).not.toContain('synthetic-db-ciphertext-that-must-not-appear');
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      active_server_seed: '[REDACTED]',
      authorization: '[REDACTED]',
      ciphertext: '[REDACTED]',
      encryptionAuthTag: '[REDACTED]',
      encryption_iv: '[REDACTED]',
      idempotencyKey: '[REDACTED]',
      level: 'error',
      message: 'request.failed',
      password: '[REDACTED]',
      requestId: 'request-123',
      RNG_MASTER_KEY: '[REDACTED]',
      rng_server_seed_ciphertext: '[REDACTED]',
      server_seed_ciphertext: '[REDACTED]',
      server_seed_hex: '[REDACTED]',
      service: 'test-service',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
  });
});
