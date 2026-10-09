import { query } from '../../db/pool.js';
import { notFound } from '../../utils/errors.js';

export const RESTAURANT_SELECT = `
  r.id,
  r.name,
  r.description,
  r.logo_url,
  r.cover_url,
  r.cuisines,
  r.address_line,
  r.city,
  r.state,
  r.postal_code,
  to_char(r.opens_at, 'HH24:MI') AS opens_at,
  to_char(r.closes_at, 'HH24:MI') AS closes_at,
  ((now() AT TIME ZONE 'Asia/Kolkata')::time BETWEEN r.opens_at AND r.closes_at AND r.is_accepting_orders) AS is_open,
  r.is_accepting_orders,
  r.min_order_minor,
  r.delivery_fee_minor,
  r.tax_bps,
  r.prep_minutes,
  r.delivery_minutes,
  r.rating_average,
  r.rating_count,
  r.status`;

export interface RestaurantRow {
  id: string;
  name: string;
  description: string | null;
  logo_url: string | null;
  cover_url: string | null;
  cuisines: string[];
  address_line: string;
  city: string;
  state: string;
  postal_code: string;
  opens_at: string;
  closes_at: string;
  is_open: boolean;
  is_accepting_orders: boolean;
  min_order_minor: number;
  delivery_fee_minor: number;
  tax_bps: number;
  prep_minutes: number;
  delivery_minutes: number;
  rating_average: string;
  rating_count: number;
  status: string;
}

export const toRestaurantSummary = (row: RestaurantRow) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  logoUrl: row.logo_url,
  coverUrl: row.cover_url,
  cuisines: row.cuisines,
  city: row.city,
  postalCode: row.postal_code,
  opensAt: row.opens_at,
  closesAt: row.closes_at,
  isOpen: row.is_open,
  minOrderMinor: row.min_order_minor,
  deliveryFeeMinor: row.delivery_fee_minor,
  prepMinutes: row.prep_minutes,
  deliveryMinutes: row.delivery_minutes,
  ratingAverage: Number(row.rating_average),
  ratingCount: row.rating_count,
  currency: 'INR' as const,
});

export const toRestaurantDetail = (row: RestaurantRow) => ({
  ...toRestaurantSummary(row),
  status: row.status,
  isAcceptingOrders: row.is_accepting_orders,
  address: {
    line: row.address_line,
    city: row.city,
    state: row.state,
    postalCode: row.postal_code,
    country: 'IN',
  },
});

export interface ListRestaurantsParams {
  q?: string;
  cuisine?: string;
  open?: boolean;
  postalCode?: string;
  sort: 'rating' | 'name' | 'newest' | 'minOrder';
  page: number;
  limit: number;
}

const SORT_SQL: Record<ListRestaurantsParams['sort'], string> = {
  rating: 'r.rating_average DESC, r.rating_count DESC, r.id',
  name: 'r.name ASC, r.id',
  newest: 'r.created_at DESC, r.id',
  minOrder: 'r.min_order_minor ASC, r.id',
};

export async function listRestaurants(params: ListRestaurantsParams) {
  const conditions: string[] = ["r.status = 'ACTIVE'"];
  const values: unknown[] = [];
  const add = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };

  if (params.q) {
    const pattern = `%${params.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const p = add(pattern);
    conditions.push(`(
      r.name ILIKE ${p}
      OR EXISTS (SELECT 1 FROM unnest(r.cuisines) c WHERE c ILIKE ${p})
      OR EXISTS (
        SELECT 1 FROM menu_items mi
        WHERE mi.restaurant_id = r.id AND mi.is_active AND mi.name ILIKE ${p}
      )
    )`);
  }
  if (params.cuisine) {
    conditions.push(`EXISTS (SELECT 1 FROM unnest(r.cuisines) c WHERE lower(c) = lower(${add(params.cuisine)}))`);
  }
  if (params.open) {
    conditions.push(`r.is_accepting_orders AND (now() AT TIME ZONE 'Asia/Kolkata')::time BETWEEN r.opens_at AND r.closes_at`);
  }
  if (params.postalCode) {
    conditions.push(`r.postal_code = ${add(params.postalCode)}`);
  }

  const where = conditions.join(' AND ');
  const offset = (params.page - 1) * params.limit;
  const limitParam = add(params.limit);
  const offsetParam = add(offset);

  const [rows, count] = await Promise.all([
    query<RestaurantRow>(
      `SELECT ${RESTAURANT_SELECT}
       FROM restaurants r
       WHERE ${where}
       ORDER BY ${SORT_SQL[params.sort]}
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      values,
    ),
    query<{ total: string }>(`SELECT count(*) AS total FROM restaurants r WHERE ${where}`, values.slice(0, -2)),
  ]);

  return { rows: rows.rows.map(toRestaurantSummary), total: Number(count.rows[0].total) };
}

export async function getRestaurant(id: string) {
  const result = await query<RestaurantRow>(
    `SELECT ${RESTAURANT_SELECT} FROM restaurants r WHERE r.id = $1 AND r.status = 'ACTIVE'`,
    [id],
  );
  if (!result.rows[0]) throw notFound('Restaurant');
  return toRestaurantDetail(result.rows[0]);
}

export async function getMenu(restaurantId: string) {
  await getRestaurant(restaurantId); // 404 if the restaurant is not publicly visible

  const result = await query<{
    category_id: string;
    category_name: string;
    category_description: string | null;
    display_order: number;
    item_id: string | null;
    item_name: string | null;
    item_description: string | null;
    image_url: string | null;
    price_minor: number | null;
    is_veg: boolean | null;
    dietary_labels: string[] | null;
    is_available: boolean | null;
  }>(
    `SELECT c.id AS category_id, c.name AS category_name, c.description AS category_description,
            c.display_order,
            i.id AS item_id, i.name AS item_name, i.description AS item_description, i.image_url,
            i.price_minor, i.is_veg, i.dietary_labels, i.is_available
     FROM menu_categories c
     LEFT JOIN menu_items i ON i.category_id = c.id AND i.is_active
     WHERE c.restaurant_id = $1 AND c.is_active
     ORDER BY c.display_order, c.name, i.name`,
    [restaurantId],
  );

  const categories = new Map<
    string,
    {
      id: string;
      name: string;
      description: string | null;
      displayOrder: number;
      items: Array<{
        id: string;
        name: string;
        description: string | null;
        imageUrl: string | null;
        priceMinor: number;
        isVeg: boolean | null;
        dietaryLabels: string[];
        isAvailable: boolean;
      }>;
    }
  >();

  for (const row of result.rows) {
    if (!categories.has(row.category_id)) {
      categories.set(row.category_id, {
        id: row.category_id,
        name: row.category_name,
        description: row.category_description,
        displayOrder: row.display_order,
        items: [],
      });
    }
    if (row.item_id) {
      categories.get(row.category_id)!.items.push({
        id: row.item_id,
        name: row.item_name!,
        description: row.item_description,
        imageUrl: row.image_url,
        priceMinor: row.price_minor!,
        isVeg: row.is_veg,
        dietaryLabels: row.dietary_labels ?? [],
        isAvailable: row.is_available!,
      });
    }
  }
  return [...categories.values()];
}

export async function getMenuItem(itemId: string) {
  const result = await query<{
    id: string;
    restaurant_id: string;
    category_id: string;
    name: string;
    description: string | null;
    image_url: string | null;
    price_minor: number;
    is_veg: boolean | null;
    dietary_labels: string[];
    is_available: boolean;
  }>(
    `SELECT i.id, i.restaurant_id, i.category_id, i.name, i.description, i.image_url, i.price_minor,
            i.is_veg, i.dietary_labels, i.is_available
     FROM menu_items i
     JOIN restaurants r ON r.id = i.restaurant_id
     WHERE i.id = $1 AND i.is_active AND r.status = 'ACTIVE'`,
    [itemId],
  );
  const item = result.rows[0];
  if (!item) throw notFound('Menu item');
  return {
    id: item.id,
    restaurantId: item.restaurant_id,
    categoryId: item.category_id,
    name: item.name,
    description: item.description,
    imageUrl: item.image_url,
    priceMinor: item.price_minor,
    isVeg: item.is_veg,
    dietaryLabels: item.dietary_labels,
    isAvailable: item.is_available,
    currency: 'INR' as const,
  };
}

export async function listReviews(restaurantId: string, page: number, limit: number) {
  await getRestaurant(restaurantId);
  const offset = (page - 1) * limit;
  const [rows, count] = await Promise.all([
    query<{ id: string; rating: number; comment: string | null; created_at: Date; first_name: string }>(
      `SELECT rv.id, rv.rating, rv.comment, rv.created_at,
              split_part(u.name, ' ', 1) AS first_name
       FROM reviews rv
       JOIN users u ON u.id = rv.customer_id
       WHERE rv.restaurant_id = $1
       ORDER BY rv.created_at DESC, rv.id
       LIMIT $2 OFFSET $3`,
      [restaurantId, limit, offset],
    ),
    query<{ total: string }>('SELECT count(*) AS total FROM reviews WHERE restaurant_id = $1', [restaurantId]),
  ]);
  return {
    rows: rows.rows.map((r) => ({
      id: r.id,
      rating: r.rating,
      comment: r.comment,
      customerFirstName: r.first_name,
      createdAt: r.created_at.toISOString(),
    })),
    total: Number(count.rows[0].total),
  };
}
