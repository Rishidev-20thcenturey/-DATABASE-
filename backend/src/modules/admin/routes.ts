import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { authenticate, currentUser, requireRole } from '../../middleware/auth.js';
import { input, validate } from '../../middleware/validate.js';
import { ORDER_STATUSES, ROLES, type OrderStatus } from '../../types/domain.js';
import { conflict, notFound } from '../../utils/errors.js';
import { audit } from '../../utils/audit.js';
import { pageMeta, sendData, sendList } from '../../utils/http.js';
import { idParams, pageQuery } from '../../validators/common.js';
import { buildOrderView, buildOrderViews, transitionOrder } from '../orders/service.js';
import { RESTAURANT_SELECT, toRestaurantDetail, type RestaurantRow } from '../restaurants/service.js';

const userParams = idParams('userId');
const restaurantParams = idParams('restaurantId');
const orderParams = idParams('orderId');

const usersQuery = pageQuery.extend({
  role: z.enum(ROLES).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
  q: z.string().trim().min(1).max(100).optional(),
});
const restaurantsQuery = pageQuery.extend({
  status: z.enum(['PENDING_APPROVAL', 'ACTIVE', 'SUSPENDED']).optional(),
});
const ordersQuery = pageQuery.extend({ status: z.enum(ORDER_STATUSES).optional() });

const userPatch = z
  .object({
    role: z.enum(ROLES).optional(),
    status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
  })
  .strict()
  .refine((v) => v.role !== undefined || v.status !== undefined, 'Provide role or status.');

const restaurantPatch = z
  .object({
    status: z.enum(['PENDING_APPROVAL', 'ACTIVE', 'SUSPENDED']).optional(),
    taxBps: z.number().int().min(0).max(10000).optional(),
    isAcceptingOrders: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Provide at least one field.');

const assignCourierBody = z.object({ courierId: z.uuid() }).strict();
const cancelBody = z.object({ reason: z.string().trim().min(1).max(300) }).strict();

export const adminRouter = Router();
adminRouter.use(authenticate, requireRole('ADMIN'));

// ---- Users -----------------------------------------------------------------

adminRouter.get('/users', validate('query', usersQuery), async (req, res) => {
  const q = input<typeof usersQuery>(req, 'query');
  const values: unknown[] = [];
  const conditions: string[] = [];
  if (q.role) {
    values.push(q.role);
    conditions.push(`role = $${values.length}`);
  }
  if (q.status) {
    values.push(q.status);
    conditions.push(`status = $${values.length}`);
  }
  if (q.q) {
    values.push(`%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    conditions.push(`(name ILIKE $${values.length} OR email ILIKE $${values.length})`);
  }
  const where = conditions.length ? conditions.join(' AND ') : 'TRUE';
  const offset = (q.page - 1) * q.limit;
  const [rows, count] = await Promise.all([
    query<{ id: string; name: string; email: string; phone: string | null; role: string; status: string; created_at: Date }>(
      `SELECT id, name, email, phone, role, status, created_at FROM users WHERE ${where}
       ORDER BY created_at DESC, id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, q.limit, offset],
    ),
    query<{ total: string }>(`SELECT count(*) AS total FROM users WHERE ${where}`, values),
  ]);
  sendList(
    res,
    rows.rows.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      role: u.role,
      status: u.status,
      createdAt: u.created_at.toISOString(),
    })),
    pageMeta(q.page, q.limit, Number(count.rows[0].total)),
  );
});

adminRouter.patch('/users/:userId', validate('params', userParams), validate('body', userPatch), async (req, res) => {
  const { userId } = input<typeof userParams>(req, 'params');
  const body = input<typeof userPatch>(req, 'body');
  const actor = currentUser(req);

  if (userId === actor.id && (body.status === 'SUSPENDED' || (body.role && body.role !== 'ADMIN'))) {
    throw conflict('SELF_MODIFICATION_NOT_ALLOWED', 'Administrators cannot suspend or demote their own account.');
  }

  const updated = await withTransaction(async (client) => {
    const before = await query<{ role: string; status: string }>(
      'SELECT role, status FROM users WHERE id = $1 FOR UPDATE',
      [userId],
      client,
    );
    if (!before.rows[0]) throw notFound('User');

    const result = await query<{ id: string; role: string; status: string }>(
      `UPDATE users SET role = COALESCE($2, role), status = COALESCE($3, status), updated_at = now()
       WHERE id = $1 RETURNING id, role, status`,
      [userId, body.role ?? null, body.status ?? null],
      client,
    );
    await audit(actor.id, 'USER_UPDATED', 'user', userId, { before: before.rows[0], after: result.rows[0] }, client);
    return result.rows[0];
  });
  sendData(res, updated);
});

// ---- Restaurants -----------------------------------------------------------

adminRouter.get('/restaurants', validate('query', restaurantsQuery), async (req, res) => {
  const q = input<typeof restaurantsQuery>(req, 'query');
  const values: unknown[] = [];
  let where = 'TRUE';
  if (q.status) {
    values.push(q.status);
    where = `r.status = $${values.length}`;
  }
  const offset = (q.page - 1) * q.limit;
  const [rows, count] = await Promise.all([
    query<RestaurantRow>(
      `SELECT ${RESTAURANT_SELECT} FROM restaurants r WHERE ${where}
       ORDER BY r.created_at DESC, r.id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, q.limit, offset],
    ),
    query<{ total: string }>(`SELECT count(*) AS total FROM restaurants r WHERE ${where}`, values),
  ]);
  sendList(res, rows.rows.map((r) => toRestaurantDetail(r)), pageMeta(q.page, q.limit, Number(count.rows[0].total)));
});

adminRouter.patch(
  '/restaurants/:restaurantId',
  validate('params', restaurantParams),
  validate('body', restaurantPatch),
  async (req, res) => {
    const { restaurantId } = input<typeof restaurantParams>(req, 'params');
    const body = input<typeof restaurantPatch>(req, 'body');
    const actor = currentUser(req);

    await withTransaction(async (client) => {
      const before = await query<{ status: string; tax_bps: number; is_accepting_orders: boolean }>(
        'SELECT status, tax_bps, is_accepting_orders FROM restaurants WHERE id = $1 FOR UPDATE',
        [restaurantId],
        client,
      );
      if (!before.rows[0]) throw notFound('Restaurant');

      await query(
        `UPDATE restaurants SET
           status = COALESCE($2, status),
           tax_bps = COALESCE($3, tax_bps),
           is_accepting_orders = COALESCE($4, is_accepting_orders),
           updated_at = now()
         WHERE id = $1`,
        [restaurantId, body.status ?? null, body.taxBps ?? null, body.isAcceptingOrders ?? null],
        client,
      );
      await audit(actor.id, 'RESTAURANT_UPDATED', 'restaurant', restaurantId, {
        before: before.rows[0],
        requested: body,
      }, client);
    });

    const result = await query<RestaurantRow>(`SELECT ${RESTAURANT_SELECT} FROM restaurants r WHERE r.id = $1`, [restaurantId]);
    sendData(res, toRestaurantDetail(result.rows[0]));
  },
);

// ---- Orders ----------------------------------------------------------------

adminRouter.get('/orders', validate('query', ordersQuery), async (req, res) => {
  const q = input<typeof ordersQuery>(req, 'query');
  const values: unknown[] = [];
  let where = 'TRUE';
  if (q.status) {
    values.push(q.status);
    where = `o.status = $${values.length}`;
  }
  const offset = (q.page - 1) * q.limit;
  const [rows, count] = await Promise.all([
    query<{ id: string }>(
      `SELECT o.id FROM orders o WHERE ${where} ORDER BY o.created_at DESC, o.id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, q.limit, offset],
    ),
    query<{ total: string }>(`SELECT count(*) AS total FROM orders o WHERE ${where}`, values),
  ]);
  const orders = await buildOrderViews(rows.rows.map((r) => r.id));
  sendList(res, orders, pageMeta(q.page, q.limit, Number(count.rows[0].total)));
});

adminRouter.post(
  '/orders/:orderId/assign-courier',
  validate('params', orderParams),
  validate('body', assignCourierBody),
  async (req, res) => {
    const { orderId } = input<typeof orderParams>(req, 'params');
    const body = input<typeof assignCourierBody>(req, 'body');
    const actor = currentUser(req);

    await withTransaction(async (client) => {
      const order = await query<{ status: OrderStatus }>('SELECT status FROM orders WHERE id = $1 FOR UPDATE', [orderId], client);
      if (!order.rows[0]) throw notFound('Order');
      if (!['CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP'].includes(order.rows[0].status)) {
        throw conflict('ORDER_NOT_ASSIGNABLE', 'Couriers can only be assigned to confirmed orders that have not been picked up.');
      }

      const courier = await query<{ role: string; status: string }>('SELECT role, status FROM users WHERE id = $1', [body.courierId], client);
      if (!courier.rows[0] || courier.rows[0].role !== 'COURIER' || courier.rows[0].status !== 'ACTIVE') {
        throw conflict('INVALID_COURIER', 'The selected user is not an active courier.');
      }

      // Reassignment is allowed only before pickup, so the order is never handed to two couriers.
      await query(
        `INSERT INTO deliveries (order_id, courier_id, status, assigned_at)
         VALUES ($1, $2, 'ASSIGNED', now())
         ON CONFLICT (order_id) DO UPDATE SET courier_id = EXCLUDED.courier_id, status = 'ASSIGNED',
           assigned_at = now(), updated_at = now()`,
        [orderId, body.courierId],
        client,
      );
      await audit(actor.id, 'COURIER_ASSIGNED', 'order', orderId, { courierId: body.courierId }, client);
    });
    sendData(res, await buildOrderView(orderId));
  },
);

adminRouter.post('/orders/:orderId/cancel', validate('params', orderParams), validate('body', cancelBody), async (req, res) => {
  const { orderId } = input<typeof orderParams>(req, 'params');
  const body = input<typeof cancelBody>(req, 'body');
  const actor = currentUser(req);
  const view = await transitionOrder(orderId, 'CANCELLED', actor, { reason: body.reason });
  await audit(actor.id, 'ORDER_CANCELLED', 'order', orderId, { reason: body.reason });
  sendData(res, view);
});

// ---- Audit log -------------------------------------------------------------

adminRouter.get('/audit-logs', validate('query', pageQuery), async (req, res) => {
  const q = input<typeof pageQuery>(req, 'query');
  const offset = (q.page - 1) * q.limit;
  const [rows, count] = await Promise.all([
    query<{ id: string; actor_id: string | null; action: string; entity_type: string; entity_id: string; details: unknown; created_at: Date }>(
      `SELECT id, actor_id, action, entity_type, entity_id, details, created_at FROM audit_logs
       ORDER BY created_at DESC, id LIMIT $1 OFFSET $2`,
      [q.limit, offset],
    ),
    query<{ total: string }>('SELECT count(*) AS total FROM audit_logs'),
  ]);
  sendList(
    res,
    rows.rows.map((r) => ({
      id: r.id,
      actorId: r.actor_id,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      details: r.details,
      createdAt: r.created_at.toISOString(),
    })),
    pageMeta(q.page, q.limit, Number(count.rows[0].total)),
  );
});
