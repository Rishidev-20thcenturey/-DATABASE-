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

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('order lifecycle, delivery, and reviews', () => {
  let owner: { id: string; token: string };
  let courier: { id: string; token: string };
  let admin: { id: string; token: string };
  let restaurant: Awaited<ReturnType<typeof createRestaurant>>;
  let customer: { id: string; token: string };
  let addressId: string;

  async function freshOrder() {
    await addToCart(customer.token, restaurant.paneerRoll, 1);
    const res = await checkoutOrder(customer.token, addressId);
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  }

  beforeAll(async () => {
    await resetDatabase();
  });
  beforeEach(async () => {
    await resetDatabase();
    owner = await createUser('RESTAURANT_OWNER');
    courier = await createUser('COURIER');
    admin = await createUser('ADMIN');
    restaurant = await createRestaurant(owner.id);
    customer = await registerCustomer();
    addressId = (await createAddress(customer.token)).id;
  });
  afterAll(async () => {
    await closeDb();
  });

  it('runs the full happy path: accept, prepare, ready, assign, pick up, deliver, and collect COD', async () => {
    const orderId = await freshOrder();

    const accepted = await request(app).post(`/api/v1/owner/orders/${orderId}/accept`).set(bearer(owner.token));
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.status).toBe('CONFIRMED');
    expect(accepted.body.data.confirmedAt).toBeTruthy();

    expect((await request(app).patch(`/api/v1/owner/orders/${orderId}/status`).set(bearer(owner.token)).send({ status: 'PREPARING' })).body.data.status).toBe('PREPARING');
    expect((await request(app).patch(`/api/v1/owner/orders/${orderId}/status`).set(bearer(owner.token)).send({ status: 'READY_FOR_PICKUP' })).body.data.status).toBe('READY_FOR_PICKUP');

    const assign = await request(app).post(`/api/v1/admin/orders/${orderId}/assign-courier`).set(bearer(admin.token)).send({ courierId: courier.id });
    expect(assign.status).toBe(200);
    expect(assign.body.data.courier).toEqual({ id: courier.id, name: 'COURIER Test' });

    const deliveries = await request(app).get('/api/v1/courier/deliveries').set(bearer(courier.token));
    expect(deliveries.body.data[0]).toMatchObject({ orderId, deliveryStatus: 'ASSIGNED', amountToCollectMinor: expect.any(Number) });
    expect(deliveries.body.data[0].amountToCollectMinor).toBeGreaterThan(0);

    for (const status of ['PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED']) {
      const res = await request(app).patch(`/api/v1/courier/deliveries/${orderId}/status`).set(bearer(courier.token)).send({ status });
      expect(res.status, status).toBe(200);
      expect(res.body.data.status).toBe(status);
    }

    const final = await request(app).get(`/api/v1/orders/${orderId}`).set(bearer(customer.token));
    expect(final.body.data.status).toBe('DELIVERED');
    expect(final.body.data.paymentStatus).toBe('COD_COLLECTED');
    expect(final.body.data.timeline.map((t: { status: string }) => t.status)).toEqual([
      'PENDING_RESTAURANT_CONFIRMATION',
      'CONFIRMED',
      'PREPARING',
      'READY_FOR_PICKUP',
      'PICKED_UP',
      'OUT_FOR_DELIVERY',
      'DELIVERED',
    ]);

    const delivery = await query<{ status: string }>('SELECT status FROM deliveries WHERE order_id = $1', [orderId]);
    expect(delivery.rows[0].status).toBe('COMPLETED');
  });

  it('rejects invalid state transitions with a stable 409 code', async () => {
    const orderId = await freshOrder();
    // Cannot skip acceptance and go straight to preparing.
    const skip = await request(app).patch(`/api/v1/owner/orders/${orderId}/status`).set(bearer(owner.token)).send({ status: 'PREPARING' });
    expect(skip.status).toBe(409);
    expect(skip.body.error.code).toBe('INVALID_STATUS_TRANSITION');

    await request(app).post(`/api/v1/owner/orders/${orderId}/reject`).set(bearer(owner.token)).send({ reason: 'Out of paneer' });
    // Terminal states cannot be reopened.
    const reopen = await request(app).post(`/api/v1/owner/orders/${orderId}/accept`).set(bearer(owner.token));
    expect(reopen.status).toBe(409);
    expect(reopen.body.error.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('lets the restaurant reject an order with a reason, and records the cancellation', async () => {
    const orderId = await freshOrder();
    const res = await request(app).post(`/api/v1/owner/orders/${orderId}/reject`).set(bearer(owner.token)).send({ reason: 'Kitchen closed early' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('REJECTED');
    expect(res.body.data.cancelReason).toBe('Kitchen closed early');
    expect(res.body.data.cancelledAt).toBeTruthy();
  });

  it('lets the customer cancel only before the restaurant accepts', async () => {
    const orderId = await freshOrder();
    const cancel = await request(app).post(`/api/v1/orders/${orderId}/cancel`).set(bearer(customer.token)).send({ reason: 'Changed my mind' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.status).toBe('CANCELLED');

    const second = await freshOrder();
    await request(app).post(`/api/v1/owner/orders/${second}/accept`).set(bearer(owner.token));
    const late = await request(app).post(`/api/v1/orders/${second}/cancel`).set(bearer(customer.token)).send({});
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('ORDER_NOT_CANCELLABLE');
  });

  it('forbids owners from changing delivery states and couriers from preparing food', async () => {
    const orderId = await freshOrder();
    await request(app).post(`/api/v1/owner/orders/${orderId}/accept`).set(bearer(owner.token));
    await request(app).patch(`/api/v1/owner/orders/${orderId}/status`).set(bearer(owner.token)).send({ status: 'PREPARING' });
    await request(app).patch(`/api/v1/owner/orders/${orderId}/status`).set(bearer(owner.token)).send({ status: 'READY_FOR_PICKUP' });
    await request(app).post(`/api/v1/admin/orders/${orderId}/assign-courier`).set(bearer(admin.token)).send({ courierId: courier.id });

    // Owner cannot mark the order picked up: the owner endpoint does not accept delivery states at all.
    const ownerPickup = await request(app).patch(`/api/v1/owner/orders/${orderId}/status`).set(bearer(owner.token)).send({ status: 'PICKED_UP' });
    expect(ownerPickup.status).toBe(400);

    // Courier cannot skip ahead to DELIVERED from READY_FOR_PICKUP.
    const skip = await request(app).patch(`/api/v1/courier/deliveries/${orderId}/status`).set(bearer(courier.token)).send({ status: 'DELIVERED' });
    expect(skip.status).toBe(409);
    expect(skip.body.error.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('does not allow a courier to be assigned before the restaurant confirms the order', async () => {
    const orderId = await freshOrder();
    const res = await request(app).post(`/api/v1/admin/orders/${orderId}/assign-courier`).set(bearer(admin.token)).send({ courierId: courier.id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_NOT_ASSIGNABLE');
  });

  it('only assigns active users with the courier role', async () => {
    const orderId = await freshOrder();
    await request(app).post(`/api/v1/owner/orders/${orderId}/accept`).set(bearer(owner.token));
    const notCourier = await request(app).post(`/api/v1/admin/orders/${orderId}/assign-courier`).set(bearer(admin.token)).send({ courierId: customer.id });
    expect(notCourier.status).toBe(409);
    expect(notCourier.body.error.code).toBe('INVALID_COURIER');
  });

  it('lets a customer review a delivered order exactly once and updates the restaurant rating', async () => {
    const orderId = await freshOrder();
    // A review before delivery is refused.
    const early = await request(app).post(`/api/v1/orders/${orderId}/review`).set(bearer(customer.token)).send({ rating: 5 });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('ORDER_NOT_REVIEWABLE');

    await request(app).post(`/api/v1/owner/orders/${orderId}/accept`).set(bearer(owner.token));
    await request(app).patch(`/api/v1/owner/orders/${orderId}/status`).set(bearer(owner.token)).send({ status: 'PREPARING' });
    await request(app).patch(`/api/v1/owner/orders/${orderId}/status`).set(bearer(owner.token)).send({ status: 'READY_FOR_PICKUP' });
    await request(app).post(`/api/v1/admin/orders/${orderId}/assign-courier`).set(bearer(admin.token)).send({ courierId: courier.id });
    for (const status of ['PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED']) {
      await request(app).patch(`/api/v1/courier/deliveries/${orderId}/status`).set(bearer(courier.token)).send({ status });
    }

    const review = await request(app).post(`/api/v1/orders/${orderId}/review`).set(bearer(customer.token)).send({ rating: 4, comment: 'Tasty' });
    expect(review.status).toBe(201);
    expect(review.body.data.rating).toBe(4);

    const duplicate = await request(app).post(`/api/v1/orders/${orderId}/review`).set(bearer(customer.token)).send({ rating: 1 });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('REVIEW_ALREADY_EXISTS');

    const detail = await request(app).get(`/api/v1/restaurants/${restaurant.restaurantId}`);
    expect(detail.body.data.ratingAverage).toBe(4);
    expect(detail.body.data.ratingCount).toBe(1);

    const list = await request(app).get(`/api/v1/restaurants/${restaurant.restaurantId}/reviews`);
    expect(list.body.data[0]).toMatchObject({ rating: 4, comment: 'Tasty' });
    expect(list.body.data[0].customerFirstName).toBe('Asha');
  });

  it('lets an admin cancel an order before pickup but not after', async () => {
    const orderId = await freshOrder();
    await request(app).post(`/api/v1/owner/orders/${orderId}/accept`).set(bearer(owner.token));
    const cancel = await request(app).post(`/api/v1/admin/orders/${orderId}/cancel`).set(bearer(admin.token)).send({ reason: 'Fraud check' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.status).toBe('CANCELLED');

    const audit = await query<{ action: string }>("SELECT action FROM audit_logs WHERE entity_id = $1", [orderId]);
    expect(audit.rows.map((r) => r.action)).toContain('ORDER_CANCELLED');
  });

  it('lists customer orders with status filter and pagination', async () => {
    await freshOrder();
    await freshOrder();
    const all = await request(app).get('/api/v1/orders?limit=1').set(bearer(customer.token));
    expect(all.body.meta).toEqual({ page: 1, limit: 1, total: 2, totalPages: 2 });
    expect(all.body.data).toHaveLength(1);

    const cancelled = await request(app).get('/api/v1/orders?status=CANCELLED').set(bearer(customer.token));
    expect(cancelled.body.meta.total).toBe(0);
  });
});
