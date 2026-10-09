import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import 'dotenv/config';
import { closePool, query } from './pool.js';
import { migrate } from './migrate.js';

/**
 * DEVELOPMENT ONLY. Creates sample accounts, restaurants, and menus so the frontend has data to render.
 * Safe to run repeatedly. Refuses to run when NODE_ENV=production.
 */
export async function seed(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed development data in production.');
  }
  const password = process.env.DEV_SEED_PASSWORD;
  if (!password || password.length < 8) {
    throw new Error('Set DEV_SEED_PASSWORD (at least 8 characters) in your environment to create development accounts.');
  }

  await migrate();
  const hash = await bcrypt.hash(password, 12);

  const accounts = [
    { email: 'admin@dev.local', name: 'Dev Admin', role: 'ADMIN' },
    { email: 'owner@dev.local', name: 'Dev Restaurant Owner', role: 'RESTAURANT_OWNER' },
    { email: 'courier@dev.local', name: 'Dev Courier', role: 'COURIER' },
    { email: 'customer@dev.local', name: 'Dev Customer', role: 'CUSTOMER' },
  ];
  const ids: Record<string, string> = {};
  for (const account of accounts) {
    const result = await query<{ id: string }>(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [account.name, account.email, hash, account.role],
    );
    ids[account.role] = result.rows[0].id;
  }

  const existingRestaurants = await query<{ count: string }>(
    `SELECT count(*) AS count FROM restaurants WHERE owner_id = $1`,
    [ids.RESTAURANT_OWNER],
  );
  if (Number(existingRestaurants.rows[0].count) === 0) {
    await seedRestaurant(ids.RESTAURANT_OWNER, {
      name: 'Bihari Bhoj',
      description: 'Traditional Bihari thali, litti chokha, and sweets.',
      cuisines: ['Bihari', 'Thali'],
      addressLine: '14 Boring Road',
      minOrderMinor: 15000,
      deliveryFeeMinor: 3000,
      taxBps: 500,
      categories: [
        {
          name: 'Thali',
          items: [
            { name: 'Veg Thali', priceMinor: 14900, isVeg: true, description: 'Dal, rice, roti, two sabzis, salad.' },
            { name: 'Litti Chokha (2 pcs)', priceMinor: 9900, isVeg: true, description: 'Sattu litti with baingan chokha.' },
          ],
        },
        {
          name: 'Sweets',
          items: [{ name: 'Tilkut', priceMinor: 4900, isVeg: true, description: 'Sesame and jaggery sweet.' }],
        },
      ],
    });
    await seedRestaurant(ids.RESTAURANT_OWNER, {
      name: 'Chai Corner',
      description: 'Kulhad chai, samosas, and quick snacks.',
      cuisines: ['Snacks', 'Beverages'],
      addressLine: '2 Fraser Road',
      minOrderMinor: 5000,
      deliveryFeeMinor: 1500,
      taxBps: 500,
      categories: [
        {
          name: 'Snacks',
          items: [
            { name: 'Samosa (2 pcs)', priceMinor: 4000, isVeg: true, description: 'Crispy potato-pea samosas.' },
            { name: 'Kulhad Masala Chai', priceMinor: 2000, isVeg: true, description: 'Spiced milk tea in a clay cup.' },
          ],
        },
      ],
    });
  }

  const addresses = await query<{ count: string }>('SELECT count(*) AS count FROM addresses WHERE user_id = $1', [ids.CUSTOMER]);
  if (Number(addresses.rows[0].count) === 0) {
    await query(
      `INSERT INTO addresses (user_id, label, recipient_name, recipient_phone, line1, landmark, city, state,
                              postal_code, country, is_default)
       VALUES ($1, 'Home', 'Dev Customer', '9000000001', '5 Patliputra Colony', 'Near the park',
               'Patna', 'Bihar', '800013', 'IN', true)`,
      [ids.CUSTOMER],
    );
  }

  console.log('Seeded development data. Sign in with any of these accounts using DEV_SEED_PASSWORD:');
  for (const account of accounts) console.log(`  ${account.role.padEnd(18)} ${account.email}`);
}

async function seedRestaurant(
  ownerId: string,
  r: {
    name: string;
    description: string;
    cuisines: string[];
    addressLine: string;
    minOrderMinor: number;
    deliveryFeeMinor: number;
    taxBps: number;
    categories: Array<{ name: string; items: Array<{ name: string; priceMinor: number; isVeg: boolean; description: string }> }>;
  },
) {
  const restaurant = await query<{ id: string }>(
    `INSERT INTO restaurants (owner_id, name, description, cuisines, address_line, city, state, postal_code,
                              opens_at, closes_at, min_order_minor, delivery_fee_minor, tax_bps, status, is_accepting_orders)
     VALUES ($1, $2, $3, $4, $5, 'Patna', 'Bihar', '800001', '00:00', '23:59', $6, $7, $8, 'ACTIVE', true)
     RETURNING id`,
    [ownerId, r.name, r.description, r.cuisines, r.addressLine, r.minOrderMinor, r.deliveryFeeMinor, r.taxBps],
  );
  const restaurantId = restaurant.rows[0].id;
  let order = 1;
  for (const category of r.categories) {
    const cat = await query<{ id: string }>(
      'INSERT INTO menu_categories (restaurant_id, name, display_order) VALUES ($1, $2, $3) RETURNING id',
      [restaurantId, category.name, order++],
    );
    for (const item of category.items) {
      await query(
        `INSERT INTO menu_items (restaurant_id, category_id, name, description, price_minor, is_veg, dietary_labels, is_available)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
        [restaurantId, cat.rows[0].id, item.name, item.description, item.priceMinor, item.isVeg, item.isVeg ? ['vegetarian'] : []],
      );
    }
  }
}

// Run directly with `npm run db:seed`.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  seed()
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
