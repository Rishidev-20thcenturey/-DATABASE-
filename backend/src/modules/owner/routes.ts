import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { authenticate, currentUser, requireRole } from '../../middleware/auth.js';
import { input, validate } from '../../middleware/validate.js';
import { ORDER_STATUSES, type OrderStatus } from '../../types/domain.js';
import { notFound } from '../../utils/errors.js';
import { pageMeta, sendData, sendList } from '../../utils/http.js';
import { buildOrderView, transitionOrder } from '../orders/service.js';
import { RESTAURANT_SELECT, toRestaurantDetail, type RestaurantRow } from '../restaurants/service.js';
import { idParams, minorUnits, optionalUrl, pageQuery, postalCode, timeOfDay } from '../../validators/common.js';

const restaurantParams = idParams('restaurantId');
const categoryParams = z.object({ restaurantId: z.uuid(), categoryId: z.uuid() }).strict();
const itemParams = z.object({ restaurantId: z.uuid(), itemId: z.uuid() }).strict();
const orderParams = idParams('orderId');

const restaurantPatch = z
  .object({
    name: z.string().trim().min(1).max(150),
    description: z.string().trim().max(2000).nullable(),
    logoUrl: optionalUrl,
    coverUrl: optionalUrl,
    cuisines: z.array(z.string().trim().min(1).max(40)).max(10),
    addressLine: z.string().trim().min(1).max(300),
    city: z.string().trim().min(1).max(100),
    state: z.string().trim().min(1).max(100),
    postalCode,
    opensAt: timeOfDay,
    closesAt: timeOfDay,
    minOrderMinor: minorUnits,
    deliveryFeeMinor: minorUnits,
    prepMinutes: z.number().int().min(0).max(240),
    deliveryMinutes: z.number().int().min(0).max(240),
    isAcceptingOrders: z.boolean(),
  })
  .partial()
  .strict();

const categoryBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).nullable().optional(),
    displayOrder: z.number().int().min(0).max(10000).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

const categoryPatch = categoryBody.partial().strict();

const itemBody = z
  .object({
    categoryId: z.uuid(),
    name: z.string().trim().min(1).max(150),
    description: z.string().trim().max(1000).nullable().optional(),
    imageUrl: optionalUrl,
    priceMinor: minorUnits,
    isVeg: z.boolean().nullable().optional(),
    dietaryLabels: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
    isAvailable: z.boolean().optional(),
  })
  .strict();

const itemPatch = itemBody.partial().strict();

const orderStatusBody = z.object({ status: z.enum(['PREPARING', 'READY_FOR_PICKUP']) }).strict();
const rejectBody = z.object({ reason: z.string().trim().min(1).max(300).optional() }).strict();
const ordersQuery = pageQuery.extend({ status: z.enum(ORDER_STATUSES).optional() });

/** Loads a restaurant the caller owns. Returns 404 for others' restaurants so IDs cannot be probed. */
async function ownedRestaurant(restaurantId: string, ownerId: string): Promise<RestaurantRow> {
  const result = await query<RestaurantRow>(
    `SELECT ${RESTAURANT_SELECT} FROM restaurants r WHERE r.id = $1 AND r.owner_id = $2`,
    [restaurantId, ownerId],
  );
  if (!result.rows[0]) throw notFound('Restaurant');
  return result.rows[0];
}

async function assertOrderOwner(orderId: string, ownerId: string) {
  const result = await query<{ restaurant_id: string }>(
    `SELECT o.restaurant_id FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
     WHERE o.id = $1 AND r.owner_id = $2`,
    [orderId, ownerId],
  );
  if (!result.rows[0]) throw notFound('Order');
}

export const ownerRouter = Router();
ownerRouter.use(authenticate, requireRole('RESTAURANT_OWNER'));

// ---- Restaurants -----------------------------------------------------------

ownerRouter.get('/restaurants', async (req, res) => {
  const result = await query<RestaurantRow>(
    `SELECT ${RESTAURANT_SELECT} FROM restaurants r WHERE r.owner_id = $1 ORDER BY r.created_at, r.id`,
    [currentUser(req).id],
  );
  sendData(res, result.rows.map((row) => toRestaurantDetail(row)));
});

ownerRouter.get('/restaurants/:restaurantId', validate('params', restaurantParams), async (req, res) => {
  const { restaurantId } = input<typeof restaurantParams>(req, 'params');
  sendData(res, toRestaurantDetail(await ownedRestaurant(restaurantId, currentUser(req).id)));
});

ownerRouter.patch(
  '/restaurants/:restaurantId',
  validate('params', restaurantParams),
  validate('body', restaurantPatch),
  async (req, res) => {
    const { restaurantId } = input<typeof restaurantParams>(req, 'params');
    const body = input<typeof restaurantPatch>(req, 'body');
    await ownedRestaurant(restaurantId, currentUser(req).id);

    // Tax rate, approval status, and ratings are controlled by administrators, not owners.
    const columns: Record<string, string> = {
      name: 'name',
      description: 'description',
      logoUrl: 'logo_url',
      coverUrl: 'cover_url',
      cuisines: 'cuisines',
      addressLine: 'address_line',
      city: 'city',
      state: 'state',
      postalCode: 'postal_code',
      opensAt: 'opens_at',
      closesAt: 'closes_at',
      minOrderMinor: 'min_order_minor',
      deliveryFeeMinor: 'delivery_fee_minor',
      prepMinutes: 'prep_minutes',
      deliveryMinutes: 'delivery_minutes',
      isAcceptingOrders: 'is_accepting_orders',
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(columns)) {
      const value = (body as Record<string, unknown>)[key];
      if (value !== undefined) {
        values.push(value ?? null);
        sets.push(`${column} = $${values.length}`);
      }
    }
    if (sets.length > 0) {
      values.push(restaurantId);
      await query(`UPDATE restaurants SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length}`, values);
    }
    sendData(res, toRestaurantDetail(await ownedRestaurant(restaurantId, currentUser(req).id)));
  },
);

// ---- Menu management -------------------------------------------------------

ownerRouter.get('/restaurants/:restaurantId/menu', validate('params', restaurantParams), async (req, res) => {
  const { restaurantId } = input<typeof restaurantParams>(req, 'params');
  await ownedRestaurant(restaurantId, currentUser(req).id);
  const categories = await query<{ id: string; name: string; description: string | null; display_order: number; is_active: boolean }>(
    `SELECT id, name, description, display_order, is_active FROM menu_categories
     WHERE restaurant_id = $1 ORDER BY display_order, name`,
    [restaurantId],
  );
  const items = await query<Record<string, unknown>>(
    `SELECT id, category_id, name, description, image_url, price_minor, is_veg, dietary_labels, is_available, is_active
     FROM menu_items WHERE restaurant_id = $1 ORDER BY name`,
    [restaurantId],
  );
  sendData(
    res,
    categories.rows.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      displayOrder: c.display_order,
      isActive: c.is_active,
      items: items.rows
        .filter((i) => i.category_id === c.id)
        .map((i) => ({
          id: i.id,
          name: i.name,
          description: i.description,
          imageUrl: i.image_url,
          priceMinor: i.price_minor,
          isVeg: i.is_veg,
          dietaryLabels: i.dietary_labels,
          isAvailable: i.is_available,
          isActive: i.is_active,
        })),
    })),
  );
});

ownerRouter.post(
  '/restaurants/:restaurantId/categories',
  validate('params', restaurantParams),
  validate('body', categoryBody),
  async (req, res) => {
    const { restaurantId } = input<typeof restaurantParams>(req, 'params');
    const body = input<typeof categoryBody>(req, 'body');
    await ownedRestaurant(restaurantId, currentUser(req).id);
    const result = await query<{ id: string }>(
      `INSERT INTO menu_categories (restaurant_id, name, description, display_order, is_active)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [restaurantId, body.name, body.description ?? null, body.displayOrder ?? 0, body.isActive ?? true],
    );
    sendData(res, { id: result.rows[0].id, ...body }, 201);
  },
);

ownerRouter.patch(
  '/restaurants/:restaurantId/categories/:categoryId',
  validate('params', categoryParams),
  validate('body', categoryPatch),
  async (req, res) => {
    const { restaurantId, categoryId } = input<typeof categoryParams>(req, 'params');
    const body = input<typeof categoryPatch>(req, 'body');
    await ownedRestaurant(restaurantId, currentUser(req).id);
    const result = await query(
      `UPDATE menu_categories SET
         name = COALESCE($3, name),
         description = CASE WHEN $4::boolean THEN $5 ELSE description END,
         display_order = COALESCE($6, display_order),
         is_active = COALESCE($7, is_active),
         updated_at = now()
       WHERE id = $1 AND restaurant_id = $2
       RETURNING id, name, description, display_order, is_active`,
      [
        categoryId,
        restaurantId,
        body.name ?? null,
        body.description !== undefined,
        body.description ?? null,
        body.displayOrder ?? null,
        body.isActive ?? null,
      ],
    );
    if (result.rows.length === 0) throw notFound('Menu category');
    const row = result.rows[0];
    sendData(res, {
      id: row.id,
      name: row.name,
      description: row.description,
      displayOrder: row.display_order,
      isActive: row.is_active,
    });
  },
);

ownerRouter.post(
  '/restaurants/:restaurantId/menu-items',
  validate('params', restaurantParams),
  validate('body', itemBody),
  async (req, res) => {
    const { restaurantId } = input<typeof restaurantParams>(req, 'params');
    const body = input<typeof itemBody>(req, 'body');
    await ownedRestaurant(restaurantId, currentUser(req).id);
    const category = await query('SELECT id FROM menu_categories WHERE id = $1 AND restaurant_id = $2', [body.categoryId, restaurantId]);
    if (category.rows.length === 0) throw notFound('Menu category');

    const result = await query<{ id: string }>(
      `INSERT INTO menu_items (restaurant_id, category_id, name, description, image_url, price_minor, is_veg,
                               dietary_labels, is_available)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        restaurantId,
        body.categoryId,
        body.name,
        body.description ?? null,
        body.imageUrl ?? null,
        body.priceMinor,
        body.isVeg ?? null,
        body.dietaryLabels ?? [],
        body.isAvailable ?? true,
      ],
    );
    sendData(res, { id: result.rows[0].id, ...body, isActive: true }, 201);
  },
);

ownerRouter.patch(
  '/restaurants/:restaurantId/menu-items/:itemId',
  validate('params', itemParams),
  validate('body', itemPatch),
  async (req, res) => {
    const { restaurantId, itemId } = input<typeof itemParams>(req, 'params');
    const body = input<typeof itemPatch>(req, 'body');
    await ownedRestaurant(restaurantId, currentUser(req).id);

    const result = await query(
      `UPDATE menu_items SET
         category_id = COALESCE($3, category_id),
         name = COALESCE($4, name),
         description = CASE WHEN $5::boolean THEN $6 ELSE description END,
         image_url = CASE WHEN $7::boolean THEN $8 ELSE image_url END,
         price_minor = COALESCE($9, price_minor),
         is_veg = CASE WHEN $10::boolean THEN $11 ELSE is_veg END,
         dietary_labels = COALESCE($12, dietary_labels),
         is_available = COALESCE($13, is_available),
         updated_at = now()
       WHERE id = $1 AND restaurant_id = $2
       RETURNING id, name, price_minor, is_available, is_active`,
      [
        itemId,
        restaurantId,
        body.categoryId ?? null,
        body.name ?? null,
        body.description !== undefined,
        body.description ?? null,
        body.imageUrl !== undefined,
        body.imageUrl ?? null,
        body.priceMinor ?? null,
        body.isVeg !== undefined,
        body.isVeg ?? null,
        body.dietaryLabels ?? null,
        body.isAvailable ?? null,
      ],
    );
    if (result.rows.length === 0) throw notFound('Menu item');
    const row = result.rows[0];
    sendData(res, {
      id: row.id,
      name: row.name,
      priceMinor: row.price_minor,
      isAvailable: row.is_available,
      isActive: row.is_active,
    });
  },
);

/** Items may be referenced by past orders, so "delete" deactivates the item instead of removing it. */
ownerRouter.delete('/restaurants/:restaurantId/menu-items/:itemId', validate('params', itemParams), async (req, res) => {
  const { restaurantId, itemId } = input<typeof itemParams>(req, 'params');
  await ownedRestaurant(restaurantId, currentUser(req).id);
  const result = await query<{ id: string; is_active: boolean }>(
    `UPDATE menu_items SET is_active = false, is_available = false, updated_at = now()
     WHERE id = $1 AND restaurant_id = $2 RETURNING id, is_active`,
    [itemId, restaurantId],
  );
  if (result.rows.length === 0) throw notFound('Menu item');
  sendData(res, { ...result.rows[0], deactivated: true });
});

// ---- Incoming orders -------------------------------------------------------

ownerRouter.get(
  '/restaurants/:restaurantId/orders',
  validate('params', restaurantParams),
  validate('query', ordersQuery),
  async (req, res) => {
    const { restaurantId } = input<typeof restaurantParams>(req, 'params');
    const q = input<typeof ordersQuery>(req, 'query');
    await ownedRestaurant(restaurantId, currentUser(req).id);
    const values: unknown[] = [restaurantId];
    let where = 'o.restaurant_id = $1';
    if (q.status) {
      values.push(q.status);
      where += ` AND o.status = $${values.length}`;
    }
    const offset = (q.page - 1) * q.limit;
    const [rows, count] = await Promise.all([
      query<{ id: string }>(
        `SELECT o.id FROM orders o WHERE ${where} ORDER BY o.created_at DESC, o.id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, q.limit, offset],
      ),
      query<{ total: string }>(`SELECT count(*) AS total FROM orders o WHERE ${where}`, values),
    ]);
    const orders = await Promise.all(rows.rows.map((r) => buildOrderView(r.id)));
    sendList(res, orders, pageMeta(q.page, q.limit, Number(count.rows[0].total)));
  },
);

ownerRouter.post('/orders/:orderId/accept', validate('params', orderParams), async (req, res) => {
  const { orderId } = input<typeof orderParams>(req, 'params');
  await assertOrderOwner(orderId, currentUser(req).id);
  sendData(res, await transitionOrder(orderId, 'CONFIRMED', currentUser(req)));
});

ownerRouter.post(
  '/orders/:orderId/reject',
  validate('params', orderParams),
  validate('body', rejectBody),
  async (req, res) => {
    const { orderId } = input<typeof orderParams>(req, 'params');
    const body = input<typeof rejectBody>(req, 'body');
    await assertOrderOwner(orderId, currentUser(req).id);
    sendData(res, await transitionOrder(orderId, 'REJECTED', currentUser(req), { reason: body.reason ?? 'Rejected by restaurant' }));
  },
);

ownerRouter.patch(
  '/orders/:orderId/status',
  validate('params', orderParams),
  validate('body', orderStatusBody),
  async (req, res) => {
    const { orderId } = input<typeof orderParams>(req, 'params');
    const body = input<typeof orderStatusBody>(req, 'body');
    await assertOrderOwner(orderId, currentUser(req).id);
    const target: OrderStatus = body.status;
    sendData(res, await transitionOrder(orderId, target, currentUser(req)));
  },
);
