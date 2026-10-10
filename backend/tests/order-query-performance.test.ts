import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
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

/**
 * Guards the query behaviour of the order read paths.
 *
 * 1. Order lists must not be N+1. Rather than assert an absolute query count (which would break
 *    every time an unrelated query is added), these tests assert that listing twice as many orders
 *    costs the same number of queries. A per-order query makes the second measurement grow.
 *
 * 2. No connection may have two queries in flight at once. pg queues concurrent queries submitted
 *    on one connection and deprecates that pattern, and it is removed in pg 9. Batching several
 *    reads together is only safe when each query gets its own pooled connection, or when they run
 *    one after another on a transaction's connection.
 */

let counting = false;
let queryCount = 0;

const inFlight = new WeakMap<object, number>();
let maxConcurrentPerConnection = 0;

// Both `pool.query()` and a checked-out `PoolClient.query()` end up in `Client.prototype.query`,
// so patching that single method observes every query without double-counting.
const originalQuery = pg.Client.prototype.query as unknown as (this: unknown, ...args: unknown[]) => unknown;

const instrumented = function (this: object, ...args: unknown[]) {
  if (counting) queryCount += 1;

  const depth = (inFlight.get(this) ?? 0) + 1;
  inFlight.set(this, depth);
  if (depth > maxConcurrentPerConnection) maxConcurrentPerConnection = depth;
  const done = () => inFlight.set(this, depth - 1);

  const result = originalQuery.apply(this, args) as Promise<unknown> | undefined;
  if (result && typeof result.then === 'function') result.then(done, done);
  else done();
  return result;
};

beforeAll(() => {
  (pg.Client.prototype as unknown as { query: unknown }).query = instrumented;
});

afterAll(async () => {
  (pg.Client.prototype as unknown as { query: unknown }).query = originalQuery;
  await closeDb();
});

/** Runs `fn` and returns how many SQL queries it issued. */
async function countQueries(fn: () => Promise<unknown>): Promise<number> {
  queryCount = 0;
  counting = true;
  try {
    await fn();
  } finally {
    counting = false;
  }
  return queryCount;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('order query performance', () => {
  let owner: { id: string; token: string };
  let admin: { id: string; token: string };
  let restaurant: Awaited<ReturnType<typeof createRestaurant>>;
  let customer: { id: string; token: string };
  let addressId: string;

  /** Places `count` orders, each in its own transaction. */
  async function placeOrders(count: number) {
    for (let index = 0; index < count; index += 1) {
      await addToCart(customer.token, restaurant.paneerRoll, 1);
      const res = await checkoutOrder(customer.token, addressId);
      expect(res.status).toBe(201);
    }
  }

  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    owner = await createUser('RESTAURANT_OWNER');
    admin = await createUser('ADMIN');
    restaurant = await createRestaurant(owner.id);
    customer = await registerCustomer();
    addressId = (await createAddress(customer.token)).id;
  });

  it('GET /orders costs the same number of queries for 4 orders as for 8', async () => {
    await placeOrders(4);
    const small = await countQueries(() => request(app).get('/api/v1/orders').set(bearer(customer.token)));

    await placeOrders(4);
    const large = await countQueries(() => request(app).get('/api/v1/orders').set(bearer(customer.token)));

    expect(large).toBe(small);
    // auth (1) + page of ids (1) + count (1) + batch load of orders, items, and history (3) = 6.
    expect(large).toBeLessThanOrEqual(8);
  });

  it('GET /owner/restaurants/:id/orders costs the same number of queries for 4 orders as for 8', async () => {
    const url = `/api/v1/owner/restaurants/${restaurant.restaurantId}/orders`;
    await placeOrders(4);
    const small = await countQueries(() => request(app).get(url).set(bearer(owner.token)));

    await placeOrders(4);
    const large = await countQueries(() => request(app).get(url).set(bearer(owner.token)));

    expect(large).toBe(small);
    // The same six, plus one to confirm the caller owns the restaurant.
    expect(large).toBeLessThanOrEqual(9);
  });

  it('GET /admin/orders costs the same number of queries for 4 orders as for 8', async () => {
    await placeOrders(4);
    const small = await countQueries(() => request(app).get('/api/v1/admin/orders').set(bearer(admin.token)));

    await placeOrders(4);
    const large = await countQueries(() => request(app).get('/api/v1/admin/orders').set(bearer(admin.token)));

    expect(large).toBe(small);
    expect(large).toBeLessThanOrEqual(8);
  });

  it('returns every order with its items and timeline, so batching did not drop data', async () => {
    await placeOrders(3);
    const res = await request(app).get('/api/v1/orders?limit=50').set(bearer(customer.token));
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(3);
    for (const order of res.body.data) {
      expect(order.items).toHaveLength(1);
      expect(order.items[0].name).toBe('Paneer Roll');
      expect(order.timeline.map((t: { status: string }) => t.status)).toEqual(['PENDING_RESTAURANT_CONFIRMATION']);
    }
  });

  it('never has two queries in flight on the same connection', async () => {
    maxConcurrentPerConnection = 0;

    // Checkout builds the order view on the transaction's connection; the list endpoints batch-load
    // on the pool. Both paths must keep to one query per connection at a time.
    await placeOrders(2);
    await request(app).get('/api/v1/orders').set(bearer(customer.token));
    await request(app).get(`/api/v1/owner/restaurants/${restaurant.restaurantId}/orders`).set(bearer(owner.token));

    expect(maxConcurrentPerConnection).toBe(1);
  });
});
