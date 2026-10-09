import bcrypt from 'bcryptjs';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { closePool, query } from '../src/db/pool.js';

export const env = loadEnv();
export const app = createApp(env);
export const PASSWORD = 'correct-horse-battery';

/** Clears all business data between test files. Migrations stay applied. */
export async function resetDatabase() {
  await query(`
    TRUNCATE audit_logs, reviews, deliveries, order_status_history, order_items, orders,
             cart_items, carts, menu_items, menu_categories, restaurants, addresses,
             refresh_tokens, users RESTART IDENTITY CASCADE`);
}

export async function closeDb() {
  await closePool();
}

let counter = 0;
const unique = () => `${Date.now()}-${++counter}`;

/** Creates a user directly in the database with a given role. Used for owners, couriers, and admins. */
export async function createUser(role: 'CUSTOMER' | 'RESTAURANT_OWNER' | 'COURIER' | 'ADMIN', overrides: { name?: string; status?: string } = {}) {
  const email = `${role.toLowerCase()}-${unique()}@example.test`;
  const hash = await bcrypt.hash(PASSWORD, 4);
  const result = await query<{ id: string }>(
    'INSERT INTO users (name, email, password_hash, role, status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [overrides.name ?? `${role} Test`, email, hash, role, overrides.status ?? 'ACTIVE'],
  );
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { id: result.rows[0].id, email, token: login.body.data.accessToken as string };
}

export async function registerCustomer(name = 'Asha Customer') {
  const email = `customer-${unique()}@example.test`;
  const res = await request(app).post('/api/v1/auth/register').send({ name, email, password: PASSWORD });
  return { id: res.body.data.user.id as string, email, token: res.body.data.accessToken as string, res };
}

/** Creates an ACTIVE restaurant with one category and items. Opens 00:00 to 23:59 IST so tests are not time-dependent. */
export async function createRestaurant(ownerId: string, overrides: Record<string, unknown> = {}) {
  const r = await query<{ id: string }>(
    `INSERT INTO restaurants (owner_id, name, cuisines, address_line, city, state, postal_code, opens_at, closes_at,
                              min_order_minor, delivery_fee_minor, tax_bps, status, is_accepting_orders)
     VALUES ($1, $2, $3, '1 Test Road', 'Patna', 'Bihar', '800001', '00:00', '23:59', $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      ownerId,
      (overrides.name as string) ?? `Test Kitchen ${unique()}`,
      (overrides.cuisines as string[]) ?? ['Indian'],
      (overrides.minOrderMinor as number) ?? 0,
      (overrides.deliveryFeeMinor as number) ?? 3000,
      (overrides.taxBps as number) ?? 500,
      (overrides.status as string) ?? 'ACTIVE',
      (overrides.isAcceptingOrders as boolean) ?? true,
    ],
  );
  const restaurantId = r.rows[0].id;
  const c = await query<{ id: string }>(
    `INSERT INTO menu_categories (restaurant_id, name, display_order) VALUES ($1, 'Mains', 1) RETURNING id`,
    [restaurantId],
  );
  const categoryId = c.rows[0].id;
  const items = await query<{ id: string; name: string }>(
    `INSERT INTO menu_items (restaurant_id, category_id, name, price_minor, is_available)
     VALUES ($1, $2, 'Paneer Roll', 19900, true),
            ($1, $2, 'Masala Chai', 4900, true),
            ($1, $2, 'Sold Out Thali', 35000, false)
     RETURNING id, name`,
    [restaurantId, categoryId],
  );
  const byName = Object.fromEntries(items.rows.map((i) => [i.name, i.id]));
  return { restaurantId, categoryId, paneerRoll: byName['Paneer Roll'], chai: byName['Masala Chai'], soldOut: byName['Sold Out Thali'] };
}

export async function createAddress(token: string, overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/api/v1/me/addresses')
    .set('Authorization', `Bearer ${token}`)
    .send({
      recipientName: 'Asha Customer',
      recipientPhone: '9876543210',
      line1: '12 Station Road',
      city: 'Patna',
      state: 'Bihar',
      postalCode: '800001',
      country: 'IN',
      ...overrides,
    });
  return res.body.data as { id: string };
}

export async function addToCart(token: string, menuItemId: string, quantity = 1, replaceExistingCart = false) {
  return request(app)
    .post('/api/v1/cart/items')
    .set('Authorization', `Bearer ${token}`)
    .send({ menuItemId, quantity, replaceExistingCart });
}

export async function checkoutOrder(token: string, addressId: string, extra: { key?: string; note?: string } = {}) {
  const req = request(app)
    .post('/api/v1/checkout')
    .set('Authorization', `Bearer ${token}`)
    .send({ addressId, paymentMethod: 'COD', customerNote: extra.note ?? null });
  if (extra.key) req.set('Idempotency-Key', extra.key);
  return req;
}

/** Moves an order through the lifecycle using the given actor token. */
export async function patchOwnerStatus(token: string, orderId: string, status: 'PREPARING' | 'READY_FOR_PICKUP') {
  return request(app).patch(`/api/v1/owner/orders/${orderId}/status`).set('Authorization', `Bearer ${token}`).send({ status });
}

export { request };
