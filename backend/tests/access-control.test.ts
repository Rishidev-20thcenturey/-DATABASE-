import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, addToCart, checkoutOrder, closeDb, createAddress, createRestaurant, createUser, env, registerCustomer, request, resetDatabase } from './helpers.js';
import { createApp } from '../src/app.js';
import { query } from '../src/db/pool.js';

/** Creates a placed order for a customer at a restaurant owned by the given owner. */
async function placedOrder(ownerId: string) {
  const restaurant = await createRestaurant(ownerId);
  const customer = await registerCustomer();
  const address = await createAddress(customer.token);
  await addToCart(customer.token, restaurant.paneerRoll, 1);
  const order = await checkoutOrder(customer.token, address.id);
  return { restaurant, customer, address, orderId: order.body.data.id as string };
}

describe('role-based access control and ownership', () => {
  beforeAll(async () => {
    await resetDatabase();
  });
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closeDb();
  });

  it('returns 401 for protected routes without a token', async () => {
    for (const path of ['/api/v1/cart', '/api/v1/orders', '/api/v1/owner/restaurants', '/api/v1/courier/deliveries', '/api/v1/admin/users']) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(401);
    }
  });

  it('blocks customers from admin, owner, and courier endpoints even with a direct API call', async () => {
    const customer = await registerCustomer();
    const auth = { Authorization: `Bearer ${customer.token}` };

    expect((await request(app).get('/api/v1/admin/users').set(auth)).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/restaurants').set(auth)).status).toBe(403);
    expect((await request(app).get('/api/v1/owner/restaurants').set(auth)).status).toBe(403);
    expect((await request(app).get('/api/v1/courier/deliveries').set(auth)).status).toBe(403);
  });

  it('blocks owners and couriers from customer-only cart routes', async () => {
    const owner = await createUser('RESTAURANT_OWNER');
    const courier = await createUser('COURIER');
    expect((await request(app).get('/api/v1/cart').set('Authorization', `Bearer ${owner.token}`)).status).toBe(403);
    expect((await request(app).get('/api/v1/cart').set('Authorization', `Bearer ${courier.token}`)).status).toBe(403);
  });

  it('does not let one restaurant owner read or change another owner\u2019s restaurant', async () => {
    const ownerA = await createUser('RESTAURANT_OWNER');
    const ownerB = await createUser('RESTAURANT_OWNER');
    const restaurantB = await createRestaurant(ownerB.id);

    const read = await request(app).get(`/api/v1/owner/restaurants/${restaurantB.restaurantId}`).set('Authorization', `Bearer ${ownerA.token}`);
    expect(read.status).toBe(404);

    const patch = await request(app)
      .patch(`/api/v1/owner/restaurants/${restaurantB.restaurantId}/menu-items/${restaurantB.paneerRoll}`)
      .set('Authorization', `Bearer ${ownerA.token}`)
      .send({ priceMinor: 1 });
    expect(patch.status).toBe(404);

    const price = await query<{ price_minor: number }>('SELECT price_minor FROM menu_items WHERE id = $1', [restaurantB.paneerRoll]);
    expect(price.rows[0].price_minor).toBe(19900);
  });

  it('does not let a courier act on a delivery that is not assigned to them', async () => {
    const owner = await createUser('RESTAURANT_OWNER');
    const courierA = await createUser('COURIER');
    const courierB = await createUser('COURIER');
    const { orderId } = await placedOrder(owner.id);
    const ownerAuth = { Authorization: `Bearer ${owner.token}` };

    // Follow the real lifecycle: accept, prepare, mark ready, then assign a courier.
    expect((await request(app).post(`/api/v1/owner/orders/${orderId}/accept`).set(ownerAuth)).status).toBe(200);
    expect((await request(app).patch(`/api/v1/owner/orders/${orderId}/status`).set(ownerAuth).send({ status: 'PREPARING' })).status).toBe(200);
    expect((await request(app).patch(`/api/v1/owner/orders/${orderId}/status`).set(ownerAuth).send({ status: 'READY_FOR_PICKUP' })).status).toBe(200);

    const admin = await createUser('ADMIN');
    const assign = await request(app)
      .post(`/api/v1/admin/orders/${orderId}/assign-courier`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ courierId: courierA.id });
    expect(assign.status).toBe(200);

    const otherView = await request(app).get(`/api/v1/courier/deliveries/${orderId}`).set('Authorization', `Bearer ${courierB.token}`);
    expect(otherView.status).toBe(404);

    const otherPickup = await request(app)
      .patch(`/api/v1/courier/deliveries/${orderId}/status`)
      .set('Authorization', `Bearer ${courierB.token}`)
      .send({ status: 'PICKED_UP' });
    expect(otherPickup.status).toBe(404);

    const ownPickup = await request(app)
      .patch(`/api/v1/courier/deliveries/${orderId}/status`)
      .set('Authorization', `Bearer ${courierA.token}`)
      .send({ status: 'PICKED_UP' });
    expect(ownPickup.status).toBe(200);
  });

  it('does not let a customer read or cancel another customer\u2019s order', async () => {
    const owner = await createUser('RESTAURANT_OWNER');
    const { orderId } = await placedOrder(owner.id);
    const intruder = await registerCustomer('Intruder');

    expect((await request(app).get(`/api/v1/orders/${orderId}`).set('Authorization', `Bearer ${intruder.token}`)).status).toBe(404);
    expect((await request(app).post(`/api/v1/orders/${orderId}/cancel`).set('Authorization', `Bearer ${intruder.token}`).send({})).status).toBe(404);
  });

  it('does not let a customer use or modify another customer\u2019s address', async () => {
    const owner = await createUser('RESTAURANT_OWNER');
    const restaurant = await createRestaurant(owner.id);
    const victim = await registerCustomer('Victim');
    const victimAddress = await createAddress(victim.token);
    const attacker = await registerCustomer('Attacker');
    await addToCart(attacker.token, restaurant.paneerRoll, 1);

    const checkout = await checkoutOrder(attacker.token, victimAddress.id);
    expect(checkout.status).toBe(404);

    const patch = await request(app)
      .patch(`/api/v1/me/addresses/${victimAddress.id}`)
      .set('Authorization', `Bearer ${attacker.token}`)
      .send({ city: 'Hacked' });
    expect(patch.status).toBe(404);
  });

  it('ignores client-supplied totals and prices (server calculates them)', async () => {
    const owner = await createUser('RESTAURANT_OWNER');
    const restaurant = await createRestaurant(owner.id);
    const customer = await registerCustomer();
    const address = await createAddress(customer.token);
    await addToCart(customer.token, restaurant.paneerRoll, 1);

    const res = await request(app)
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ addressId: address.id, paymentMethod: 'COD', totalMinor: 1, priceMinor: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('blocks suspended accounts even when they hold a valid, unexpired access token', async () => {
    const customer = await registerCustomer();
    await query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [customer.id]);
    const res = await request(app).get('/api/v1/cart').set('Authorization', `Bearer ${customer.token}`);
    expect(res.status).toBe(403);
  });

  it('rate-limits login attempts with a 429 and stable code', async () => {
    const limited = createApp({ ...env, AUTH_RATE_LIMIT_MAX: 2 });
    const body = { email: 'nobody@example.test', password: 'whatever-password' };
    expect((await request(limited).post('/api/v1/auth/login').send(body)).status).toBe(401);
    expect((await request(limited).post('/api/v1/auth/login').send(body)).status).toBe(401);
    const third = await request(limited).post('/api/v1/auth/login').send(body);
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('RATE_LIMITED');
  });
});
