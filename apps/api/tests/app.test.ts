import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createTestApp } from './support/test-app.js';

describe('service status endpoints', () => {
  it('reports process health', async () => {
    const response = await request(createTestApp()).get('/health');

    expect(response.status).toBe(200);
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/u);
    expect(response.body).toEqual({ service: 'api', status: 'ok' });
  });

  it('reports readiness without claiming unavailable dependencies', async () => {
    const response = await request(createTestApp()).get('/ready');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ service: 'api', status: 'ready' });
  });
});
