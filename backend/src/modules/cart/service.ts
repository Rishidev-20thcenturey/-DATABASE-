import { query, withTransaction, type Queryable } from '../../db/pool.js';
import { badRequest, conflict, notFound } from '../../utils/errors.js';
import { buildPricing } from '../../utils/money.js';

export const MAX_QUANTITY = 50;

interface CartRow {
  id: string;
  restaurant_id: string | null;
}

interface CartLineRow {
  cart_item_id: string;
  quantity: number;
  menu_item_id: string;
  item_name: string;
  price_minor: number;
  is_available: boolean;
  item_active: boolean;
  restaurant_id: string;
  restaurant_name: string;
  restaurant_status: string;
  is_accepting_orders: boolean;
  min_order_minor: number;
  delivery_fee_minor: number;
  tax_bps: number;
  is_open: boolean;
}

/** Ensures the customer has exactly one cart and returns it. */
export async function ensureCart(customerId: string, db?: Queryable): Promise<CartRow> {
  const result = await query<CartRow>(
    `INSERT INTO carts (customer_id) VALUES ($1)
     ON CONFLICT (customer_id) DO UPDATE SET updated_at = carts.updated_at
     RETURNING id, restaurant_id`,
    [customerId],
    db,
  );
  return result.rows[0];
}

async function cartLines(cartId: string, db: Queryable) {
  const result = await query<CartLineRow>(
    `SELECT ci.id AS cart_item_id, ci.quantity,
            mi.id AS menu_item_id, mi.name AS item_name, mi.price_minor,
            mi.is_available, mi.is_active AS item_active,
            r.id AS restaurant_id, r.name AS restaurant_name, r.status AS restaurant_status,
            r.is_accepting_orders, r.min_order_minor, r.delivery_fee_minor, r.tax_bps,
            ((now() AT TIME ZONE 'Asia/Kolkata')::time BETWEEN r.opens_at AND r.closes_at) AS is_open
     FROM cart_items ci
     JOIN menu_items mi ON mi.id = ci.menu_item_id
     JOIN restaurants r ON r.id = mi.restaurant_id
     JOIN carts c ON c.id = ci.cart_id
     WHERE ci.cart_id = $1
     ORDER BY ci.created_at, ci.id`,
    [cartId],
    db,
  );
  return result.rows;
}

/** Full cart view. Totals are an estimate from current prices; checkout recalculates them. */
export async function getCartView(customerId: string) {
  return withTransaction(async (client) => {
    const cart = await ensureCart(customerId, client);
    return buildCartView(cart, client);
  });
}

async function buildCartView(cart: CartRow, db: Queryable) {
  const lines = await cartLines(cart.id, db);
  const warnings: Array<{ code: string; message: string; cartItemId?: string }> = [];

  const items = lines.map((line) => {
    const lineTotalMinor = line.price_minor * line.quantity;
    const unavailable = !line.is_available || !line.item_active;
    if (unavailable) {
      warnings.push({
        code: 'ITEM_UNAVAILABLE',
        message: `${line.item_name} is currently unavailable and must be removed before checkout.`,
        cartItemId: line.cart_item_id,
      });
    }
    return {
      id: line.cart_item_id,
      menuItemId: line.menu_item_id,
      name: line.item_name,
      unitPriceMinor: line.price_minor,
      quantity: line.quantity,
      lineTotalMinor,
      isAvailable: !unavailable,
    };
  });

  const first = lines[0];
  let restaurant: null | { id: string; name: string; isOpen: boolean } = null;
  let pricing = null;
  let minimumOrderMinor = 0;

  if (first) {
    restaurant = { id: first.restaurant_id, name: first.restaurant_name, isOpen: first.is_open && first.is_accepting_orders };
    minimumOrderMinor = first.min_order_minor;
    const subtotalMinor = items.reduce((sum, item) => sum + item.lineTotalMinor, 0);
    pricing = buildPricing({
      subtotalMinor,
      deliveryFeeMinor: first.delivery_fee_minor,
      taxBps: first.tax_bps,
    });
    if (subtotalMinor < minimumOrderMinor) {
      warnings.push({
        code: 'MINIMUM_ORDER_NOT_MET',
        message: 'The subtotal is below this restaurant\u2019s minimum order value.',
      });
    }
  }

  return {
    restaurant,
    items,
    pricing,
    minimumOrderMinor,
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    warnings,
  };
}

async function assertAvailableMenuItem(menuItemId: string, db: Queryable) {
  const result = await query<{ restaurant_id: string; is_available: boolean; status: string }>(
    `SELECT mi.restaurant_id, mi.is_available, r.status
     FROM menu_items mi JOIN restaurants r ON r.id = mi.restaurant_id
     WHERE mi.id = $1 AND mi.is_active`,
    [menuItemId],
    db,
  );
  const item = result.rows[0];
  if (!item || item.status !== 'ACTIVE') throw notFound('Menu item');
  if (!item.is_available) throw conflict('ITEM_UNAVAILABLE', 'This item is currently unavailable.');
  return item;
}

export async function addItem(
  customerId: string,
  input: { menuItemId: string; quantity: number; replaceExistingCart: boolean },
) {
  return withTransaction(async (client) => {
    const cart = await ensureCart(customerId, client);
    await query('SELECT id FROM carts WHERE id = $1 FOR UPDATE', [cart.id], client);
    const item = await assertAvailableMenuItem(input.menuItemId, client);

    const currentRestaurantId = cart.restaurant_id;
    if (currentRestaurantId && currentRestaurantId !== item.restaurant_id) {
      if (!input.replaceExistingCart) {
        throw conflict(
          'CART_RESTAURANT_MISMATCH',
          'Your cart contains items from another restaurant. Clear the cart to add this item.',
          [
            { field: 'restaurantId', message: 'Cart belongs to a different restaurant.', currentRestaurantId, requestedRestaurantId: item.restaurant_id },
          ],
        );
      }
      await query('DELETE FROM cart_items WHERE cart_id = $1', [cart.id], client);
    }

    const existing = await query<{ quantity: number }>(
      'SELECT quantity FROM cart_items WHERE cart_id = $1 AND menu_item_id = $2',
      [cart.id, input.menuItemId],
      client,
    );
    const newQuantity = (existing.rows[0]?.quantity ?? 0) + input.quantity;
    if (newQuantity > MAX_QUANTITY) {
      throw badRequest('QUANTITY_LIMIT_EXCEEDED', `You can order at most ${MAX_QUANTITY} of an item.`, [
        { field: 'quantity', message: `Maximum is ${MAX_QUANTITY}.` },
      ]);
    }

    await query(
      `INSERT INTO cart_items (cart_id, menu_item_id, quantity) VALUES ($1, $2, $3)
       ON CONFLICT (cart_id, menu_item_id) DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()`,
      [cart.id, input.menuItemId, newQuantity],
      client,
    );
    await query(
      'UPDATE carts SET restaurant_id = $2, updated_at = now() WHERE id = $1',
      [cart.id, item.restaurant_id],
      client,
    );
    return buildCartView({ id: cart.id, restaurant_id: item.restaurant_id }, client);
  });
}

export async function updateItemQuantity(customerId: string, cartItemId: string, quantity: number) {
  return withTransaction(async (client) => {
    const cart = await ensureCart(customerId, client);
    const existing = await query<{ menu_item_id: string }>(
      'SELECT menu_item_id FROM cart_items WHERE id = $1 AND cart_id = $2',
      [cartItemId, cart.id],
      client,
    );
    if (!existing.rows[0]) throw notFound('Cart item');
    await assertAvailableMenuItem(existing.rows[0].menu_item_id, client);
    await query(
      'UPDATE cart_items SET quantity = $3, updated_at = now() WHERE id = $1 AND cart_id = $2',
      [cartItemId, cart.id, quantity],
      client,
    );
    return buildCartView(cart, client);
  });
}

export async function removeItem(customerId: string, cartItemId: string) {
  return withTransaction(async (client) => {
    const cart = await ensureCart(customerId, client);
    const deleted = await query('DELETE FROM cart_items WHERE id = $1 AND cart_id = $2', [cartItemId, cart.id], client);
    if (deleted.rowCount === 0) throw notFound('Cart item');
    await clearRestaurantIfEmpty(cart.id, client);
    return buildCartView(cart, client);
  });
}

export async function clearCart(customerId: string) {
  return withTransaction(async (client) => {
    const cart = await ensureCart(customerId, client);
    await query('DELETE FROM cart_items WHERE cart_id = $1', [cart.id], client);
    await query('UPDATE carts SET restaurant_id = NULL, updated_at = now() WHERE id = $1', [cart.id], client);
    return buildCartView({ id: cart.id, restaurant_id: null }, client);
  });
}

async function clearRestaurantIfEmpty(cartId: string, db: Queryable) {
  await query(
    `UPDATE carts SET restaurant_id = NULL, updated_at = now()
     WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM cart_items WHERE cart_id = $1)`,
    [cartId],
    db,
  );
}
