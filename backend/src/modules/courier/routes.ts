import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { authenticate, currentUser, requireRole } from '../../middleware/auth.js';
import { input, validate } from '../../middleware/validate.js';
import { notFound } from '../../utils/errors.js';
import { pageMeta, sendData, sendList } from '../../utils/http.js';
import { idParams, pageQuery } from '../../validators/common.js';
import { buildOrderView, transitionOrder } from '../orders/service.js';

const orderParams = idParams('orderId');
const listQuery = pageQuery.extend({
  status: z.enum(['ASSIGNED', 'COMPLETED', 'CANCELLED']).optional(),
});
const statusBody = z.object({ status: z.enum(['PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED']) }).strict();

/** Couriers may only act on deliveries assigned to them. Other IDs return 404. */
async function assertAssignedToMe(orderId: string, courierId: string) {
  const result = await query<{ status: string }>(
    'SELECT status FROM deliveries WHERE order_id = $1 AND courier_id = $2',
    [orderId, courierId],
  );
  if (!result.rows[0]) throw notFound('Delivery');
  return result.rows[0];
}

export const courierRouter = Router();
courierRouter.use(authenticate, requireRole('COURIER'));

courierRouter.get('/deliveries', validate('query', listQuery), async (req, res) => {
  const q = input<typeof listQuery>(req, 'query');
  const courierId = currentUser(req).id;
  const values: unknown[] = [courierId];
  let where = 'd.courier_id = $1';
  if (q.status) {
    values.push(q.status);
    where += ` AND d.status = $${values.length}`;
  }
  const offset = (q.page - 1) * q.limit;
  const [rows, count] = await Promise.all([
    query<{
      order_id: string;
      order_number: string;
      delivery_status: string;
      order_status: string;
      restaurant_id: string;
      restaurant_name: string;
      restaurant_address: string;
      delivery_address: Record<string, unknown>;
      total_minor: number;
      payment_method: string;
      payment_status: string;
      assigned_at: Date;
    }>(
      `SELECT d.order_id, o.order_number, d.status AS delivery_status, o.status AS order_status,
              r.id AS restaurant_id, r.name AS restaurant_name,
              concat_ws(', ', r.address_line, r.city, r.postal_code) AS restaurant_address,
              o.delivery_address, o.total_minor, o.payment_method, o.payment_status, d.assigned_at
       FROM deliveries d
       JOIN orders o ON o.id = d.order_id
       JOIN restaurants r ON r.id = o.restaurant_id
       WHERE ${where}
       ORDER BY d.assigned_at DESC, d.order_id
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, q.limit, offset],
    ),
    query<{ total: string }>(`SELECT count(*) AS total FROM deliveries d WHERE ${where}`, values),
  ]);

  sendList(
    res,
    rows.rows.map((r) => ({
      orderId: r.order_id,
      orderNumber: r.order_number,
      deliveryStatus: r.delivery_status,
      orderStatus: r.order_status,
      restaurant: { id: r.restaurant_id, name: r.restaurant_name, address: r.restaurant_address },
      deliveryAddress: {
        recipientName: r.delivery_address.recipientName,
        recipientPhone: r.delivery_address.recipientPhone,
        line1: r.delivery_address.line1,
        landmark: r.delivery_address.landmark ?? null,
        city: r.delivery_address.city,
        postalCode: r.delivery_address.postalCode,
        instructions: r.delivery_address.instructions ?? null,
      },
      amountToCollectMinor: r.payment_method === 'COD' && r.payment_status === 'COD_PENDING' ? r.total_minor : 0,
      currency: 'INR' as const,
      assignedAt: r.assigned_at.toISOString(),
    })),
    pageMeta(q.page, q.limit, Number(count.rows[0].total)),
  );
});

courierRouter.get('/deliveries/:orderId', validate('params', orderParams), async (req, res) => {
  const { orderId } = input<typeof orderParams>(req, 'params');
  await assertAssignedToMe(orderId, currentUser(req).id);
  sendData(res, await buildOrderView(orderId));
});

courierRouter.patch(
  '/deliveries/:orderId/status',
  validate('params', orderParams),
  validate('body', statusBody),
  async (req, res) => {
    const { orderId } = input<typeof orderParams>(req, 'params');
    const body = input<typeof statusBody>(req, 'body');
    await assertAssignedToMe(orderId, currentUser(req).id);
    // transitionOrder enforces the lifecycle: pickup only from READY_FOR_PICKUP, and so on.
    sendData(res, await transitionOrder(orderId, body.status, currentUser(req)));
  },
);
