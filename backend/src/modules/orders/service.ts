import { createHash, randomBytes } from 'node:crypto';
import { query, withTransaction, type Queryable } from '../../db/pool.js';
import type { AuthUser, OrderStatus, Role } from '../../types/domain.js';
import { conflict, forbidden, notFound } from '../../utils/errors.js';
import { buildPricing, type Pricing } from '../../utils/money.js';
import { checkTransition } from './state-machine.js';

export interface DeliveryAddressInput {
  label?: string | null;
  recipientName: string;
  recipientPhone: string;
  line1: string;
  landmark?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  latitude?: number | null;
  longitude?: number | null;
  instructions?: string | null;
}

interface OrderRow {
  id: string;
  order_number: string;
  customer_id: string;
  restaurant_id: string;
  courier_id: string | null;
  status: OrderStatus;
  payment_method: string;
  payment_status: string;
  delivery_address: DeliveryAddressInput;
  customer_note: string | null;
  subtotal_minor: number;
  delivery_fee_minor: number;
  tax_minor: number;
  discount_minor: number;
  total_minor: number;
  currency: string;
  created_at: Date;
  updated_at: Date;
  confirmed_at: Date | null;
  delivered_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export async function buildOrderView(orderId: string, db?: Queryable) {
  const orderResult = await query<
    OrderRow & { restaurant_name: string; courier_name: string | null }
  >(
    `SELECT o.*, r.name AS restaurant_name, d.courier_id, cu.name AS courier_name
     FROM orders o
     JOIN restaurants r ON r.id = o.restaurant_id
     LEFT JOIN deliveries d ON d.order_id = o.id AND d.status <> 'CANCELLED'
     LEFT JOIN users cu ON cu.id = d.courier_id
     WHERE o.id = $1`,
    [orderId],
    db,
  );
  const order = orderResult.rows[0];
  if (!order) throw notFound('Order');

  const [items, history] = await Promise.all([
    query<{ id: string; menu_item_id: string | null; item_name: string; unit_price_minor: number; quantity: number; line_total_minor: number }>(
      'SELECT id, menu_item_id, item_name, unit_price_minor, quantity, line_total_minor FROM order_items WHERE order_id = $1 ORDER BY item_name, id',
      [orderId],
      db,
    ),
    query<{ to_status: string; created_at: Date }>(
      'SELECT to_status, created_at FROM order_status_history WHERE order_id = $1 ORDER BY created_at, id',
      [orderId],
      db,
    ),
  ]);

  const address = order.delivery_address;
  return {
    id: order.id,
    orderNumber: order.order_number,
    status: order.status,
    paymentMethod: order.payment_method,
    paymentStatus: order.payment_status,
    restaurant: { id: order.restaurant_id, name: order.restaurant_name },
    deliveryAddress: {
      label: address.label ?? null,
      recipientName: address.recipientName,
      recipientPhone: address.recipientPhone,
      line1: address.line1,
      landmark: address.landmark ?? null,
      city: address.city,
      state: address.state,
      postalCode: address.postalCode,
      country: address.country,
      latitude: address.latitude ?? null,
      longitude: address.longitude ?? null,
      instructions: address.instructions ?? null,
    },
    customerNote: order.customer_note,
    items: items.rows.map((item) => ({
      id: item.id,
      menuItemId: item.menu_item_id,
      name: item.item_name,
      unitPriceMinor: item.unit_price_minor,
      quantity: item.quantity,
      lineTotalMinor: item.line_total_minor,
    })),
    pricing: {
      subtotalMinor: order.subtotal_minor,
      deliveryFeeMinor: order.delivery_fee_minor,
      taxMinor: order.tax_minor,
      discountMinor: order.discount_minor,
      totalMinor: order.total_minor,
      currency: 'INR' as const,
    },
    courier: order.courier_id ? { id: order.courier_id, name: order.courier_name } : null,
    timeline: history.rows.map((h) => ({ status: h.to_status, at: h.created_at.toISOString() })),
    createdAt: order.created_at.toISOString(),
    updatedAt: order.updated_at.toISOString(),
    confirmedAt: order.confirmed_at?.toISOString() ?? null,
    deliveredAt: order.delivered_at?.toISOString() ?? null,
    cancelledAt: order.cancelled_at?.toISOString() ?? null,
    cancelReason: order.cancel_reason,
  };
}

export type OrderView = Awaited<ReturnType<typeof buildOrderView>>;

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

interface CheckoutLine {
  menu_item_id: string;
  item_name: string;
  price_minor: number;
  quantity: number;
  is_available: boolean;
  item_active: boolean;
}

interface CheckoutContext {
  restaurantId: string;
  restaurantName: string;
  restaurantStatus: string;
  isAcceptingOrders: boolean;
  isOpen: boolean;
  minOrderMinor: number;
  deliveryFeeMinor: number;
  taxBps: number;
  lines: CheckoutLine[];
  pricing: Pricing;
  address: DeliveryAddressInput;
  addressId: string;
}

/**
 * Validates the cart and address against current database state and calculates prices on the server.
 * Must run inside a transaction that holds the cart lock when used by checkout.
 */
async function loadCheckoutContext(customerId: string, addressId: string, db: Queryable): Promise<CheckoutContext> {
  const cart = await query<{ id: string; restaurant_id: string | null }>(
    'SELECT id, restaurant_id FROM carts WHERE customer_id = $1',
    [customerId],
    db,
  );
  const cartRow = cart.rows[0];
  const lines = cartRow
    ? await query<CheckoutLine & { restaurant_id: string }>(
        `SELECT mi.id AS menu_item_id, mi.name AS item_name, mi.price_minor, ci.quantity,
                mi.is_available, mi.is_active AS item_active, mi.restaurant_id
         FROM cart_items ci JOIN menu_items mi ON mi.id = ci.menu_item_id
         WHERE ci.cart_id = $1 ORDER BY ci.created_at, ci.id`,
        [cartRow.id],
        db,
      )
    : { rows: [] as Array<CheckoutLine & { restaurant_id: string }> };

  if (!cartRow || lines.rows.length === 0) {
    throw conflict('CART_EMPTY', 'Your cart is empty.');
  }

  const restaurantId = lines.rows[0].restaurant_id;
  const unavailable = lines.rows.filter((line) => !line.is_available || !line.item_active);
  if (unavailable.length > 0) {
    throw conflict('ITEM_UNAVAILABLE', 'Some items in your cart are no longer available.', unavailable.map((line) => ({
      field: 'items',
      message: `${line.item_name} is unavailable.`,
      menuItemId: line.menu_item_id,
    })));
  }

  const restaurant = await query<{
    name: string; status: string; is_accepting_orders: boolean; is_open: boolean;
    min_order_minor: number; delivery_fee_minor: number; tax_bps: number;
  }>(
    `SELECT name, status, is_accepting_orders, min_order_minor, delivery_fee_minor, tax_bps,
            ((now() AT TIME ZONE 'Asia/Kolkata')::time BETWEEN opens_at AND closes_at) AS is_open
     FROM restaurants WHERE id = $1`,
    [restaurantId],
    db,
  );
  const r = restaurant.rows[0];
  if (!r || r.status !== 'ACTIVE') {
    throw conflict('RESTAURANT_UNAVAILABLE', 'This restaurant is not accepting orders.');
  }

  const address = await query<{ id: string } & DeliveryAddressRow>(
    `SELECT id, label, recipient_name, recipient_phone, line1, landmark, city, state, postal_code, country,
            latitude, longitude, instructions
     FROM addresses WHERE id = $1 AND user_id = $2`,
    [addressId, customerId],
    db,
  );
  const a = address.rows[0];
  if (!a) throw notFound('Address');

  const subtotalMinor = lines.rows.reduce((sum, line) => sum + line.price_minor * line.quantity, 0);
  const pricing = buildPricing({
    subtotalMinor,
    deliveryFeeMinor: r.delivery_fee_minor,
    taxBps: r.tax_bps,
  });

  return {
    restaurantId,
    restaurantName: r.name,
    restaurantStatus: r.status,
    isAcceptingOrders: r.is_accepting_orders,
    isOpen: r.is_open,
    minOrderMinor: r.min_order_minor,
    deliveryFeeMinor: r.delivery_fee_minor,
    taxBps: r.tax_bps,
    lines: lines.rows,
    pricing,
    addressId: a.id,
    address: {
      label: a.label,
      recipientName: a.recipient_name,
      recipientPhone: a.recipient_phone,
      line1: a.line1,
      landmark: a.landmark,
      city: a.city,
      state: a.state,
      postalCode: a.postal_code,
      country: a.country,
      latitude: a.latitude === null ? null : Number(a.latitude),
      longitude: a.longitude === null ? null : Number(a.longitude),
      instructions: a.instructions,
    },
  };
}

interface DeliveryAddressRow {
  label: string | null;
  recipient_name: string;
  recipient_phone: string;
  line1: string;
  landmark: string | null;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  latitude: string | null;
  longitude: string | null;
  instructions: string | null;
}

function assertCanPlaceOrder(ctx: CheckoutContext) {
  if (!ctx.isAcceptingOrders || !ctx.isOpen) {
    throw conflict('RESTAURANT_CLOSED', 'This restaurant is closed for orders right now.');
  }
  if (ctx.pricing.subtotalMinor < ctx.minOrderMinor) {
    throw conflict('MINIMUM_ORDER_NOT_MET', 'Your order is below the restaurant\u2019s minimum order value.', [
      { field: 'subtotal', message: 'Subtotal is below the minimum.', minimumOrderMinor: ctx.minOrderMinor, subtotalMinor: ctx.pricing.subtotalMinor },
    ]);
  }
}

export async function previewCheckout(customerId: string, addressId: string) {
  return withTransaction(async (client) => {
    const ctx = await loadCheckoutContext(customerId, addressId, client);
    const blockers: Array<{ code: string; message: string }> = [];
    if (!ctx.isAcceptingOrders || !ctx.isOpen) blockers.push({ code: 'RESTAURANT_CLOSED', message: 'This restaurant is closed for orders right now.' });
    if (ctx.pricing.subtotalMinor < ctx.minOrderMinor) blockers.push({ code: 'MINIMUM_ORDER_NOT_MET', message: 'Your order is below the minimum order value.' });
    return {
      restaurant: { id: ctx.restaurantId, name: ctx.restaurantName },
      pricing: ctx.pricing,
      minimumOrderMinor: ctx.minOrderMinor,
      availablePaymentMethods: [...ALLOWED_PAYMENT_METHODS],
      blockers,
      canPlaceOrder: blockers.length === 0,
    };
  });
}

/** Online payment providers are not integrated yet, so Cash on Delivery is the only method. */
export const ALLOWED_PAYMENT_METHODS = ['COD'] as const;

/**
 * Creates an order from the customer's cart in one transaction. Retries with the same Idempotency-Key
 * return the original order; reusing a key with a different request is rejected.
 */
export async function checkout(input: {
  customerId: string;
  addressId: string;
  paymentMethod: 'COD';
  customerNote: string | null;
  idempotencyKey: string | null;
}): Promise<{ order: OrderView; replayed: boolean }> {
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ addressId: input.addressId, paymentMethod: input.paymentMethod, customerNote: input.customerNote }))
    .digest('hex');

  return withTransaction(async (client) => {
    // Lock the cart first so concurrent checkouts from the same customer are serialized.
    await query(
      `INSERT INTO carts (customer_id) VALUES ($1) ON CONFLICT (customer_id) DO NOTHING`,
      [input.customerId],
      client,
    );
    await query('SELECT id FROM carts WHERE customer_id = $1 FOR UPDATE', [input.customerId], client);

    if (input.idempotencyKey) {
      const existing = await query<{ id: string; request_hash: string | null }>(
        'SELECT id, request_hash FROM orders WHERE customer_id = $1 AND idempotency_key = $2',
        [input.customerId, input.idempotencyKey],
        client,
      );
      const prior = existing.rows[0];
      if (prior) {
        if (prior.request_hash !== requestHash) {
          throw conflict('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request.');
        }
        return { order: await buildOrderView(prior.id, client), replayed: true };
      }
    }

    const ctx = await loadCheckoutContext(input.customerId, input.addressId, client);
    assertCanPlaceOrder(ctx);

    const orderNumber = `FD-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${randomBytes(4).toString('hex').toUpperCase()}`;
    const inserted = await query<{ id: string }>(
      `INSERT INTO orders (
         order_number, customer_id, restaurant_id, status, payment_method, payment_status,
         delivery_address, customer_note, currency,
         subtotal_minor, delivery_fee_minor, tax_minor, discount_minor, total_minor,
         idempotency_key, request_hash
       ) VALUES ($1, $2, $3, 'PENDING_RESTAURANT_CONFIRMATION', $4, 'COD_PENDING',
         $5, $6, 'INR', $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        orderNumber,
        input.customerId,
        ctx.restaurantId,
        input.paymentMethod,
        JSON.stringify(ctx.address),
        input.customerNote,
        ctx.pricing.subtotalMinor,
        ctx.pricing.deliveryFeeMinor,
        ctx.pricing.taxMinor,
        ctx.pricing.discountMinor,
        ctx.pricing.totalMinor,
        input.idempotencyKey,
        requestHash,
      ],
      client,
    );
    const orderId = inserted.rows[0].id;

    for (const line of ctx.lines) {
      await query(
        `INSERT INTO order_items (order_id, menu_item_id, item_name, unit_price_minor, quantity, line_total_minor)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [orderId, line.menu_item_id, line.item_name, line.price_minor, line.quantity, line.price_minor * line.quantity],
        client,
      );
    }

    await query(
      `INSERT INTO order_status_history (order_id, from_status, to_status, actor_id, actor_role)
       VALUES ($1, NULL, 'PENDING_RESTAURANT_CONFIRMATION', $2, 'CUSTOMER')`,
      [orderId, input.customerId],
      client,
    );

    // Empty the cart only as part of the same transaction that created the order.
    await query(
      `DELETE FROM cart_items WHERE cart_id IN (SELECT id FROM carts WHERE customer_id = $1)`,
      [input.customerId],
      client,
    );
    await query('UPDATE carts SET restaurant_id = NULL, updated_at = now() WHERE customer_id = $1', [input.customerId], client);

    return { order: await buildOrderView(orderId, client), replayed: false };
  });
}

// ---------------------------------------------------------------------------
// Status transitions (used by every role)
// ---------------------------------------------------------------------------

/**
 * Moves an order to a new status. Caller must already have verified the actor's ownership of the order.
 * Locks the order row, validates the transition, records history, and keeps related rows consistent.
 */
export async function transitionOrder(
  orderId: string,
  to: OrderStatus,
  actor: AuthUser,
  options: { reason?: string } = {},
): Promise<OrderView> {
  return withTransaction(async (client) => {
    const locked = await query<{ status: OrderStatus }>(
      'SELECT status FROM orders WHERE id = $1 FOR UPDATE',
      [orderId],
      client,
    );
    const current = locked.rows[0];
    if (!current) throw notFound('Order');

    const check = checkTransition(current.status, to, actor.role as Role);
    if (!check.ok) {
      if (check.code === 'ROLE_NOT_PERMITTED') throw forbidden(check.message);
      throw conflict(check.code, check.message, [{ field: 'status', message: check.message, currentStatus: current.status, requestedStatus: to }]);
    }

    const isCancellation = to === 'CANCELLED' || to === 'REJECTED';
    const extraSets: string[] = [];
    const params: unknown[] = [orderId, to];
    if (to === 'CONFIRMED') extraSets.push('confirmed_at = now()');
    if (to === 'DELIVERED') extraSets.push('delivered_at = now()', "payment_status = 'COD_COLLECTED'");
    if (isCancellation) {
      params.push(options.reason ?? null);
      extraSets.push('cancelled_at = now()', `cancel_reason = $${params.length}`);
    }

    await query(
      `UPDATE orders SET status = $2, updated_at = now()${extraSets.map((s) => `, ${s}`).join('')} WHERE id = $1`,
      params,
      client,
    );

    await query(
      `INSERT INTO order_status_history (order_id, from_status, to_status, actor_id, actor_role)
       VALUES ($1, $2, $3, $4, $5)`,
      [orderId, current.status, to, actor.id, actor.role],
      client,
    );

    if (to === 'DELIVERED') {
      await query(
        `UPDATE deliveries SET status = 'COMPLETED', delivered_at = now(), updated_at = now() WHERE order_id = $1`,
        [orderId],
        client,
      );
    }
    if (to === 'CANCELLED' || to === 'REJECTED') {
      await query(
        `UPDATE deliveries SET status = 'CANCELLED', updated_at = now() WHERE order_id = $1 AND status = 'ASSIGNED'`,
        [orderId],
        client,
      );
    }
    if (to === 'PICKED_UP') {
      await query(`UPDATE deliveries SET picked_up_at = now(), updated_at = now() WHERE order_id = $1`, [orderId], client);
    }

    return buildOrderView(orderId, client);
  });
}

// ---------------------------------------------------------------------------
// Customer operations
// ---------------------------------------------------------------------------

export async function listCustomerOrders(customerId: string, status: OrderStatus | undefined, page: number, limit: number) {
  const values: unknown[] = [customerId];
  let where = 'o.customer_id = $1';
  if (status) {
    values.push(status);
    where += ` AND o.status = $${values.length}`;
  }
  const offset = (page - 1) * limit;
  const [rows, count] = await Promise.all([
    query<{ id: string }>(
      `SELECT o.id FROM orders o WHERE ${where} ORDER BY o.created_at DESC, o.id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    ),
    query<{ total: string }>(`SELECT count(*) AS total FROM orders o WHERE ${where}`, values),
  ]);
  const orders = await Promise.all(rows.rows.map((row) => buildOrderView(row.id)));
  return { orders, total: Number(count.rows[0].total) };
}

/** Returns 404 for orders the customer does not own, so order IDs cannot be probed. */
export async function getCustomerOrder(customerId: string, orderId: string) {
  await assertOrderOwnedBy(orderId, customerId);
  return buildOrderView(orderId);
}

async function assertOrderOwnedBy(orderId: string, customerId: string) {
  const result = await query<{ id: string }>('SELECT id FROM orders WHERE id = $1 AND customer_id = $2', [orderId, customerId]);
  if (!result.rows[0]) throw notFound('Order');
}

export async function cancelByCustomer(customerId: string, orderId: string, reason: string | null) {
  await assertOrderOwnedBy(orderId, customerId);
  const current = await query<{ status: OrderStatus }>('SELECT status FROM orders WHERE id = $1', [orderId]);
  if (current.rows[0].status !== 'PENDING_RESTAURANT_CONFIRMATION') {
    throw conflict('ORDER_NOT_CANCELLABLE', 'This order can no longer be cancelled by the customer. Contact support.');
  }
  return transitionOrder(orderId, 'CANCELLED', { id: customerId, role: 'CUSTOMER' }, { reason: reason ?? 'Cancelled by customer' });
}

export async function reviewOrder(customerId: string, orderId: string, rating: number, comment: string | null) {
  return withTransaction(async (client) => {
    const found = await query<{ status: OrderStatus; restaurant_id: string }>(
      'SELECT status, restaurant_id FROM orders WHERE id = $1 AND customer_id = $2 FOR UPDATE',
      [orderId, customerId],
      client,
    );
    const order = found.rows[0];
    if (!order) throw notFound('Order');
    if (order.status !== 'DELIVERED') {
      throw conflict('ORDER_NOT_REVIEWABLE', 'Only delivered orders can be reviewed.');
    }
    const existing = await query('SELECT id FROM reviews WHERE order_id = $1', [orderId], client);
    if (existing.rows[0]) throw conflict('REVIEW_ALREADY_EXISTS', 'You have already reviewed this order.');

    const inserted = await query<{ id: string; created_at: Date }>(
      `INSERT INTO reviews (order_id, customer_id, restaurant_id, rating, comment)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [orderId, customerId, order.restaurant_id, rating, comment],
      client,
    );

    // Recalculate the aggregate from source rows so it can never drift.
    await query(
      `UPDATE restaurants r SET
         rating_count = agg.cnt,
         rating_average = agg.avg,
         updated_at = now()
       FROM (SELECT count(*)::int AS cnt, COALESCE(round(avg(rating)::numeric, 2), 0) AS avg
             FROM reviews WHERE restaurant_id = $1) agg
       WHERE r.id = $1`,
      [order.restaurant_id],
      client,
    );

    return {
      id: inserted.rows[0].id,
      orderId,
      restaurantId: order.restaurant_id,
      rating,
      comment,
      createdAt: inserted.rows[0].created_at.toISOString(),
    };
  });
}

