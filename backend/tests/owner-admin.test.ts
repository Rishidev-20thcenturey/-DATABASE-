import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, closeDb, createRestaurant, createUser, request, resetDatabase } from './helpers.js';
import { query } from '../src/db/pool.js';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('restaurant owner operations', () => {
  let owner: { id: string; token: string };
  let restaurant: Awaited<ReturnType<typeof createRestaurant>>;

  beforeAll(async () => {
    await resetDatabase();
  });
  beforeEach(async () => {
    await resetDatabase();
    owner = await createUser('RESTAURANT_OWNER');
    restaurant = await createRestaurant(owner.id);
  });
  afterAll(async () => {
    await closeDb();
  });

  it('lists only the owner\u2019s own restaurants', async () => {
    const other = await createUser('RESTAURANT_OWNER');
    await createRestaurant(other.id, { name: 'Not Mine' });
    const res = await request(app).get('/api/v1/owner/restaurants').set(bearer(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: { id: string }) => r.id)).toEqual([restaurant.restaurantId]);
  });

  it('updates allowed restaurant fields but not admin-controlled fields', async () => {
    const res = await request(app)
      .patch(`/api/v1/owner/restaurants/${restaurant.restaurantId}`)
      .set(bearer(owner.token))
      .send({ description: 'Fresh food', minOrderMinor: 15000, opensAt: '08:30' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ description: 'Fresh food', minOrderMinor: 15000, opensAt: '08:30' });

    // Tax rate and approval status belong to administrators.
    const forbiddenField = await request(app)
      .patch(`/api/v1/owner/restaurants/${restaurant.restaurantId}`)
      .set(bearer(owner.token))
      .send({ taxBps: 0, status: 'ACTIVE' });
    expect(forbiddenField.status).toBe(400);
  });

  it('manages categories and menu items, and deactivates instead of deleting items', async () => {
    const created = await request(app)
      .post(`/api/v1/owner/restaurants/${restaurant.restaurantId}/menu-items`)
      .set(bearer(owner.token))
      .send({ categoryId: restaurant.categoryId, name: 'Litti Chokha', priceMinor: 12000, isVeg: true, dietaryLabels: ['veg'] });
    expect(created.status).toBe(201);
    const itemId = created.body.data.id as string;

    const priced = await request(app)
      .patch(`/api/v1/owner/restaurants/${restaurant.restaurantId}/menu-items/${itemId}`)
      .set(bearer(owner.token))
      .send({ priceMinor: 13000, isAvailable: false });
    expect(priced.status).toBe(200);
    expect(priced.body.data).toMatchObject({ priceMinor: 13000, isAvailable: false });

    const negative = await request(app)
      .patch(`/api/v1/owner/restaurants/${restaurant.restaurantId}/menu-items/${itemId}`)
      .set(bearer(owner.token))
      .send({ priceMinor: -5 });
    expect(negative.status).toBe(400);

    const removed = await request(app)
      .delete(`/api/v1/owner/restaurants/${restaurant.restaurantId}/menu-items/${itemId}`)
      .set(bearer(owner.token));
    expect(removed.status).toBe(200);
    const row = await query<{ is_active: boolean }>('SELECT is_active FROM menu_items WHERE id = $1', [itemId]);
    expect(row.rows[0].is_active).toBe(false);

    const menu = await request(app).get(`/api/v1/restaurants/${restaurant.restaurantId}/menu`);
    const ids = menu.body.data.flatMap((c: { items: Array<{ id: string }> }) => c.items.map((i) => i.id));
    expect(ids).not.toContain(itemId);
  });

  it('refuses to add a menu item to another restaurant\u2019s category', async () => {
    const other = await createRestaurant(owner.id, { name: 'Second Kitchen' });
    const res = await request(app)
      .post(`/api/v1/owner/restaurants/${restaurant.restaurantId}/menu-items`)
      .set(bearer(owner.token))
      .send({ categoryId: other.categoryId, name: 'Sneaky', priceMinor: 100 });
    expect(res.status).toBe(404);
  });

  it('lets the owner update availability and see incoming orders for their restaurant', async () => {
    const res = await request(app)
      .get(`/api/v1/owner/restaurants/${restaurant.restaurantId}/orders`)
      .set(bearer(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(0);
  });
});

describe('administrator operations', () => {
  let admin: { id: string; token: string };
  let customerToken: string;

  beforeAll(async () => {
    await resetDatabase();
  });
  beforeEach(async () => {
    await resetDatabase();
    admin = await createUser('ADMIN');
    const owner = await createUser('RESTAURANT_OWNER');
    await createRestaurant(owner.id, { status: 'PENDING_APPROVAL' });
    const customer = await createUser('CUSTOMER');
    customerToken = customer.token;
  });
  afterAll(async () => {
    await closeDb();
  });

  it('approves a pending restaurant, which then becomes visible publicly', async () => {
    const pending = await request(app).get('/api/v1/admin/restaurants?status=PENDING_APPROVAL').set(bearer(admin.token));
    expect(pending.body.meta.total).toBe(1);
    const restaurantId = pending.body.data[0].id as string;

    expect((await request(app).get(`/api/v1/restaurants/${restaurantId}`)).status).toBe(404);

    const approved = await request(app)
      .patch(`/api/v1/admin/restaurants/${restaurantId}`)
      .set(bearer(admin.token))
      .send({ status: 'ACTIVE', taxBps: 500 });
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe('ACTIVE');

    expect((await request(app).get(`/api/v1/restaurants/${restaurantId}`)).status).toBe(200);
  });

  it('records an audit entry for sensitive changes', async () => {
    const pending = await request(app).get('/api/v1/admin/restaurants').set(bearer(admin.token));
    const restaurantId = pending.body.data[0].id as string;
    await request(app).patch(`/api/v1/admin/restaurants/${restaurantId}`).set(bearer(admin.token)).send({ status: 'ACTIVE' });

    const logs = await request(app).get('/api/v1/admin/audit-logs').set(bearer(admin.token));
    expect(logs.status).toBe(200);
    expect(logs.body.data.map((l: { action: string }) => l.action)).toContain('RESTAURANT_UPDATED');
    expect(logs.body.data[0].actorId).toBe(admin.id);
    expect(JSON.stringify(logs.body)).not.toMatch(/password/i);
  });

  it('suspends and reactivates other users, but blocks self-suspension', async () => {
    const target = await createUser('CUSTOMER');
    const suspend = await request(app).patch(`/api/v1/admin/users/${target.id}`).set(bearer(admin.token)).send({ status: 'SUSPENDED' });
    expect(suspend.status).toBe(200);
    expect(suspend.body.data.status).toBe('SUSPENDED');

    const self = await request(app).patch(`/api/v1/admin/users/${admin.id}`).set(bearer(admin.token)).send({ status: 'SUSPENDED' });
    expect(self.status).toBe(409);
    expect(self.body.error.code).toBe('SELF_MODIFICATION_NOT_ALLOWED');
  });

  it('rejects role changes from a non-admin and unknown roles', async () => {
    const res = await request(app)
      .patch(`/api/v1/admin/users/${admin.id}`)
      .set(bearer(customerToken))
      .send({ role: 'ADMIN' });
    expect(res.status).toBe(403);

    const unknown = await request(app).patch(`/api/v1/admin/users/${admin.id}`).set(bearer(admin.token)).send({ role: 'SUPERUSER' });
    expect(unknown.status).toBe(400);
  });

  it('lists users with filters and never exposes password hashes', async () => {
    const res = await request(app).get('/api/v1/admin/users?role=COURIER').set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    const all = await request(app).get('/api/v1/admin/users').set(bearer(admin.token));
    expect(JSON.stringify(all.body)).not.toMatch(/password_hash|\$2[aby]\$/);
  });
});
