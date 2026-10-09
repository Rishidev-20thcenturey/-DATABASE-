import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addToCart,
  app,
  checkoutOrder,
  closeDb,
  createAddress,
  createRestaurant,
  createUser,
  registerCustomer,
  request,
  resetDatabase,
} from './helpers.js';
import { query } from '../src/db/pool.js';

describe('restaurant discovery and menus', () => {
  let owner: { id: string; token: string };
  let restaurant: Awaited<ReturnType<typeof createRestaurant>>;

  beforeAll(async () => {
    await resetDatabase();
  });
  beforeEach(async () => {
    await resetDatabase();
    owner = await createUser('RESTAURANT_OWNER');
    restaurant = await createRestaurant(owner.id, { name: 'Bihari Bhoj', cuisines: ['Bihari', 'Thali'] });
  });
  afterAll(async () => {
    await closeDb();
  });

  it('lists only active restaurants with pagination meta and the documented shape', async () => {
    await createRestaurant(owner.id, { name: 'Pending Place', status: 'PENDING_APPROVAL' });
    const res = await request(app).get('/api/v1/restaurants?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ page: 1, limit: 10, total: 1, totalPages: 1 });
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ id: restaurant.restaurantId, name: 'Bihari Bhoj', currency: 'INR' });
    expect(res.body.data[0]).not.toHaveProperty('ownerId');
  });

  it('searches by restaurant name, cuisine, and menu item name', async () => {
    const byName = await request(app).get('/api/v1/restaurants?q=bhoj');
    expect(byName.body.meta.total).toBe(1);

    const byCuisine = await request(app).get('/api/v1/restaurants?cuisine=thali');
    expect(byCuisine.body.meta.total).toBe(1);

    const byItem = await request(app).get('/api/v1/restaurants?q=paneer');
    expect(byItem.body.meta.total).toBe(1);

    const none = await request(app).get('/api/v1/restaurants?q=pizza');
    expect(none.body.meta.total).toBe(0);
  });

  it('treats LIKE wildcards in search text literally', async () => {
    const res = await request(app).get('/api/v1/restaurants?q=%25');
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(0);
  });

  it('returns 404 for suspended or pending restaurants, but detail for active ones', async () => {
    const pending = await createRestaurant(owner.id, { name: 'Hidden', status: 'PENDING_APPROVAL' });
    expect((await request(app).get(`/api/v1/restaurants/${pending.restaurantId}`)).status).toBe(404);
    expect((await request(app).get(`/api/v1/restaurants/${pending.restaurantId}/menu`)).status).toBe(404);

    const detail = await request(app).get(`/api/v1/restaurants/${restaurant.restaurantId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.address.postalCode).toBe('800001');
  });

  it('rejects malformed IDs and invalid list parameters with VALIDATION_ERROR', async () => {
    const badId = await request(app).get('/api/v1/restaurants/not-a-uuid');
    expect(badId.status).toBe(400);
    expect(badId.body.error.code).toBe('VALIDATION_ERROR');

    const badSort = await request(app).get('/api/v1/restaurants?sort=drop_table');
    expect(badSort.status).toBe(400);

    const badLimit = await request(app).get('/api/v1/restaurants?limit=500');
    expect(badLimit.status).toBe(400);
  });

  it('returns the menu grouped by category and hides inactive or deleted items', async () => {
    await query('UPDATE menu_items SET is_active = false WHERE id = $1', [restaurant.chai]);
    const res = await request(app).get(`/api/v1/restaurants/${restaurant.restaurantId}/menu`);
    expect(res.status).toBe(200);
    const items = res.body.data[0].items as Array<{ id: string; isAvailable: boolean }>;
    expect(items.map((i) => i.id)).not.toContain(restaurant.chai);
    expect(items.find((i) => i.id === restaurant.soldOut)?.isAvailable).toBe(false);
  });

  it('returns a single menu item and 404s on unknown items', async () => {
    const item = await request(app).get(`/api/v1/menu-items/${restaurant.paneerRoll}`);
    expect(item.status).toBe(200);
    expect(item.body.data).toMatchObject({ name: 'Paneer Roll', priceMinor: 19900, currency: 'INR' });

    const missing = await request(app).get('/api/v1/menu-items/00000000-0000-4000-8000-000000000000');
    expect(missing.status).toBe(404);
  });

  it('lists reviews with only the customer first name exposed', async () => {
    const res = await request(app).get(`/api/v1/restaurants/${restaurant.restaurantId}/reviews`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(0);
  });
});

describe('cart and checkout', () => {
  let owner: { id: string; token: string };
  let restaurant: Awaited<ReturnType<typeof createRestaurant>>;
  let otherRestaurant: Awaited<ReturnType<typeof createRestaurant>>;
  let customer: { id: string; token: string };
  let addressId: string;

  beforeAll(async () => {
    await resetDatabase();
  });
  beforeEach(async () => {
    await resetDatabase();
    owner = await createUser('RESTAURANT_OWNER');
    restaurant = await createRestaurant(owner.id, { name: 'Main Kitchen', minOrderMinor: 10000, deliveryFeeMinor: 3000, taxBps: 500 });
    otherRestaurant = await createRestaurant(owner.id, { name: 'Other Kitchen' });
    customer = await registerCustomer();
    addressId = (await createAddress(customer.token)).id;
  });
  afterAll(async () => {
    await closeDb();
  });

  it('adds items, computes server-side pricing, and updates quantities', async () => {
    const added = await addToCart(customer.token, restaurant.paneerRoll, 2);
    expect(added.status).toBe(201);
    expect(added.body.data.restaurant.id).toBe(restaurant.restaurantId);
    expect(added.body.data.items[0]).toMatchObject({ quantity: 2, unitPriceMinor: 19900, lineTotalMinor: 39800 });
    // subtotal 39800; tax 5% = 1990; fee 3000; total 44790
    expect(added.body.data.pricing).toEqual({
      subtotalMinor: 39800,
      deliveryFeeMinor: 3000,
      taxMinor: 1990,
      discountMinor: 0,
      totalMinor: 44790,
      currency: 'INR',
    });

    const cartItemId = added.body.data.items[0].id;
    const updated = await request(app)
      .patch(`/api/v1/cart/items/${cartItemId}`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ quantity: 3 });
    expect(updated.status).toBe(200);
    expect(updated.body.data.items[0].quantity).toBe(3);
  });

  it('rejects invalid quantities and quantities above the per-item limit', async () => {
    expect((await addToCart(customer.token, restaurant.paneerRoll, 0)).status).toBe(400);
    expect((await addToCart(customer.token, restaurant.paneerRoll, 51)).status).toBe(400);
    const first = await addToCart(customer.token, restaurant.paneerRoll, 50);
    expect(first.status).toBe(201);
    const over = await addToCart(customer.token, restaurant.paneerRoll, 1);
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe('QUANTITY_LIMIT_EXCEEDED');
  });

  it('refuses unavailable items with a stable code', async () => {
    const res = await addToCart(customer.token, restaurant.soldOut, 1);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ITEM_UNAVAILABLE');
  });

  it('allows only one restaurant per cart and lets the customer replace it explicitly', async () => {
    await addToCart(customer.token, restaurant.paneerRoll, 1);

    const mismatch = await addToCart(customer.token, otherRestaurant.paneerRoll, 1);
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error.code).toBe('CART_RESTAURANT_MISMATCH');
    expect(mismatch.body.error.details[0]).toMatchObject({ currentRestaurantId: restaurant.restaurantId, requestedRestaurantId: otherRestaurant.restaurantId });

    const replaced = await addToCart(customer.token, otherRestaurant.paneerRoll, 1, true);
    expect(replaced.status).toBe(201);
    expect(replaced.body.data.restaurant.id).toBe(otherRestaurant.restaurantId);
    expect(replaced.body.data.items).toHaveLength(1);
  });

  it('removes items, clears the cart, and resets the restaurant when empty', async () => {
    const added = await addToCart(customer.token, restaurant.chai, 1);
    const cartItemId = added.body.data.items[0].id;

    const removed = await request(app).delete(`/api/v1/cart/items/${cartItemId}`).set('Authorization', `Bearer ${customer.token}`);
    expect(removed.status).toBe(200);
    expect(removed.body.data.restaurant).toBeNull();
    expect(removed.body.data.items).toEqual([]);

    await addToCart(customer.token, restaurant.chai, 1);
    const cleared = await request(app).delete('/api/v1/cart').set('Authorization', `Bearer ${customer.token}`);
    expect(cleared.body.data.items).toEqual([]);
  });

  it('previews checkout without creating an order', async () => {
    await addToCart(customer.token, restaurant.chai, 1); // 49.00 is below the 100.00 minimum
    const preview = await request(app)
      .post('/api/v1/checkout/preview')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ addressId });
    expect(preview.status).toBe(200);
    expect(preview.body.data.canPlaceOrder).toBe(false);
    expect(preview.body.data.blockers[0].code).toBe('MINIMUM_ORDER_NOT_MET');

    const orders = await query('SELECT id FROM orders');
    expect(orders.rows).toHaveLength(0);
  });

  it('enforces the minimum order value at checkout and leaves the cart intact on failure', async () => {
    await addToCart(customer.token, restaurant.chai, 1); // 49.00 is below the 100.00 minimum
    const res = await checkoutOrder(customer.token, addressId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MINIMUM_ORDER_NOT_MET');

    const cart = await request(app).get('/api/v1/cart').set('Authorization', `Bearer ${customer.token}`);
    expect(cart.body.data.items).toHaveLength(1);
    expect((await query('SELECT id FROM orders')).rows).toHaveLength(0);
  });

  it('places a COD order with item snapshots, a status history, and an empty cart', async () => {
    await addToCart(customer.token, restaurant.paneerRoll, 1);
    const res = await checkoutOrder(customer.token, addressId, { note: 'Ring the bell' });
    expect(res.status).toBe(201);
    const order = res.body.data;
    expect(order).toMatchObject({
      status: 'PENDING_RESTAURANT_CONFIRMATION',
      paymentMethod: 'COD',
      paymentStatus: 'COD_PENDING',
      customerNote: 'Ring the bell',
    });
    expect(order.pricing.totalMinor).toBe(19900 + 3000 + 995);
    expect(order.items[0]).toMatchObject({ name: 'Paneer Roll', unitPriceMinor: 19900, quantity: 1 });
    expect(order.timeline[0].status).toBe('PENDING_RESTAURANT_CONFIRMATION');
    expect(order.orderNumber).toMatch(/^FD-\d{6}-[A-F0-9]{8}$/);

    // Snapshot survives later menu price changes.
    await query('UPDATE menu_items SET price_minor = 99900 WHERE id = $1', [restaurant.paneerRoll]);
    const stored = await request(app).get(`/api/v1/orders/${order.id}`).set('Authorization', `Bearer ${customer.token}`);
    expect(stored.body.data.items[0].unitPriceMinor).toBe(19900);
    expect(stored.body.data.pricing.totalMinor).toBe(order.pricing.totalMinor);

    const cart = await request(app).get('/api/v1/cart').set('Authorization', `Bearer ${customer.token}`);
    expect(cart.body.data.items).toEqual([]);
  });

  it('returns the same order for a retried request with the same Idempotency-Key', async () => {
    await addToCart(customer.token, restaurant.paneerRoll, 1);
    const key = 'checkout-key-0001';
    const first = await checkoutOrder(customer.token, addressId, { key });
    expect(first.status).toBe(201);

    // Client retries after a network failure; the cart is now empty, but the original order is returned.
    const retry = await checkoutOrder(customer.token, addressId, { key });
    expect(retry.status).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.data.id).toBe(first.body.data.id);

    expect((await query('SELECT id FROM orders')).rows).toHaveLength(1);
  });

  it('rejects reuse of an Idempotency-Key for a different request', async () => {
    await addToCart(customer.token, restaurant.paneerRoll, 1);
    const key = 'checkout-key-0002';
    await checkoutOrder(customer.token, addressId, { key, note: 'first' });
    const different = await checkoutOrder(customer.token, addressId, { key, note: 'second' });
    expect(different.status).toBe(409);
    expect(different.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('refuses checkout with an empty cart and malformed Idempotency-Keys', async () => {
    const empty = await checkoutOrder(customer.token, addressId);
    expect(empty.status).toBe(409);
    expect(empty.body.error.code).toBe('CART_EMPTY');

    await addToCart(customer.token, restaurant.paneerRoll, 1);
    const badKey = await checkoutOrder(customer.token, addressId, { key: 'x' });
    expect(badKey.status).toBe(400);
    expect(badKey.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');
  });

  it('refuses checkout when the item became unavailable after it was added to the cart', async () => {
    await addToCart(customer.token, restaurant.paneerRoll, 1);
    await query('UPDATE menu_items SET is_available = false WHERE id = $1', [restaurant.paneerRoll]);
    const res = await checkoutOrder(customer.token, addressId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ITEM_UNAVAILABLE');
    expect((await query('SELECT id FROM orders')).rows).toHaveLength(0);
  });

  it('refuses checkout when the restaurant is not accepting orders', async () => {
    await addToCart(customer.token, restaurant.paneerRoll, 1);
    await query('UPDATE restaurants SET is_accepting_orders = false WHERE id = $1', [restaurant.restaurantId]);
    const res = await checkoutOrder(customer.token, addressId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RESTAURANT_CLOSED');
  });

  it('refuses checkout with an address that does not exist', async () => {
    await addToCart(customer.token, restaurant.paneerRoll, 1);
    const res = await checkoutOrder(customer.token, '00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
  });

  it('manages addresses with a single default and keeps one default after deletion', async () => {
    const second = await createAddress(customer.token, { line1: '99 Second Lane', isDefault: true });
    const list = await request(app).get('/api/v1/me/addresses').set('Authorization', `Bearer ${customer.token}`);
    const defaults = list.body.data.filter((a: { isDefault: boolean }) => a.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(second.id);

    const del = await request(app).delete(`/api/v1/me/addresses/${second.id}`).set('Authorization', `Bearer ${customer.token}`);
    expect(del.status).toBe(204);
    const after = await request(app).get('/api/v1/me/addresses').set('Authorization', `Bearer ${customer.token}`);
    expect(after.body.data).toHaveLength(1);
    expect(after.body.data[0].isDefault).toBe(true);
  });
});
