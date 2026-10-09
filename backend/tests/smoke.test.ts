import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app, closeDb, request, resetDatabase } from './helpers.js';

describe('smoke', () => {
  beforeAll(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closeDb();
  });

  it('health and readiness respond', async () => {
    const health = await request(app).get('/api/v1/health');
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ data: { status: 'ok' } });

    const ready = await request(app).get('/api/v1/ready');
    expect(ready.status).toBe(200);
  });
});
