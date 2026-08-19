import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';

describe('service status endpoints', () => {
  it('reports process health', async () => {
    const response = await request(createApp()).get('/health');

    expect(response.status).toBe(200);
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.body).toEqual({ service: 'api', status: 'ok' });
  });

  it('reports readiness without claiming unavailable dependencies', async () => {
    const response = await request(createApp()).get('/ready');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ service: 'api', status: 'ready' });
  });
});
