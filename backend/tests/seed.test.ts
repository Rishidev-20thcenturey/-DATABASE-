import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, request, app, resetDatabase } from './helpers.js';
import { seed } from '../src/db/seed.js';
import { query } from '../src/db/pool.js';

describe('development seed data', () => {
  beforeAll(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await resetDatabase();
    await closeDb();
  });

  it('creates sample accounts, restaurants, and menus, and is safe to run twice', async () => {
    await seed();
    await seed();

    const users = await query<{ role: string; count: string }>('SELECT role, count(*) AS count FROM users GROUP BY role');
    const byRole = Object.fromEntries(users.rows.map((r) => [r.role, Number(r.count)]));
    expect(byRole).toEqual({ ADMIN: 1, RESTAURANT_OWNER: 1, COURIER: 1, CUSTOMER: 1 });

    const restaurants = await query<{ count: string }>('SELECT count(*) AS count FROM restaurants');
    expect(Number(restaurants.rows[0].count)).toBe(2);

    const login = await request(app).post('/api/v1/auth/login').send({ email: 'customer@dev.local', password: 'dev-password-123' });
    expect(login.status).toBe(200);

    const list = await request(app).get('/api/v1/restaurants');
    expect(list.body.meta.total).toBe(2);
    const menu = await request(app).get(`/api/v1/restaurants/${list.body.data[0].id}/menu`);
    expect(menu.body.data.length).toBeGreaterThan(0);
  });
});
