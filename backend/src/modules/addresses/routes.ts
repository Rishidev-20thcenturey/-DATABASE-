import { Router } from 'express';
import { z } from 'zod';
import { withTransaction, query, type Queryable } from '../../db/pool.js';
import { authenticate, currentUser, requireRole } from '../../middleware/auth.js';
import { input, validate } from '../../middleware/validate.js';
import { conflict, notFound } from '../../utils/errors.js';
import { sendData } from '../../utils/http.js';
import { idParams, postalCode } from '../../validators/common.js';

const addressBody = z
  .object({
    label: z.string().trim().min(1).max(40).nullable().optional(),
    recipientName: z.string().trim().min(1).max(120),
    recipientPhone: z.string().trim().regex(/^\+?[0-9]{10,15}$/, 'Phone must be 10 to 15 digits.'),
    line1: z.string().trim().min(1).max(200),
    landmark: z.string().trim().max(200).nullable().optional(),
    city: z.string().trim().min(1).max(100),
    state: z.string().trim().min(1).max(100),
    postalCode,
    country: z.literal('IN').default('IN'),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    instructions: z.string().trim().max(500).nullable().optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();

const addressPatch = addressBody.partial().strict();
const addressParams = idParams('addressId');

interface AddressRow {
  id: string;
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
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

const ADDRESS_COLUMNS = `id, label, recipient_name, recipient_phone, line1, landmark, city, state,
  postal_code, country, latitude, longitude, instructions, is_default, created_at, updated_at`;

const toAddress = (row: AddressRow) => ({
  id: row.id,
  label: row.label,
  recipientName: row.recipient_name,
  recipientPhone: row.recipient_phone,
  line1: row.line1,
  landmark: row.landmark,
  city: row.city,
  state: row.state,
  postalCode: row.postal_code,
  country: row.country,
  latitude: row.latitude === null ? null : Number(row.latitude),
  longitude: row.longitude === null ? null : Number(row.longitude),
  instructions: row.instructions,
  isDefault: row.is_default,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

/** Columns the body maps to, in the same order as the INSERT/UPDATE below. */
const COLUMN_MAP: Array<[keyof z.infer<typeof addressBody>, string]> = [
  ['label', 'label'],
  ['recipientName', 'recipient_name'],
  ['recipientPhone', 'recipient_phone'],
  ['line1', 'line1'],
  ['landmark', 'landmark'],
  ['city', 'city'],
  ['state', 'state'],
  ['postalCode', 'postal_code'],
  ['country', 'country'],
  ['latitude', 'latitude'],
  ['longitude', 'longitude'],
  ['instructions', 'instructions'],
];

async function clearDefault(db: Queryable, userId: string, exceptId?: string) {
  await query(
    'UPDATE addresses SET is_default = false WHERE user_id = $1 AND is_default AND ($2::uuid IS NULL OR id <> $2)',
    [userId, exceptId ?? null],
    db,
  );
}

/** Returns the address only if it belongs to the user; otherwise 404 so IDs cannot be probed. */
async function ownedAddress(db: Queryable, userId: string, addressId: string): Promise<AddressRow> {
  const result = await query<AddressRow>(
    `SELECT ${ADDRESS_COLUMNS} FROM addresses WHERE id = $1 AND user_id = $2`,
    [addressId, userId],
    db,
  );
  if (!result.rows[0]) throw notFound('Address');
  return result.rows[0];
}

export const addressRouter = Router();
addressRouter.use(authenticate, requireRole('CUSTOMER'));

addressRouter.get('/', async (req, res) => {
  const { id } = currentUser(req);
  const result = await query<AddressRow>(
    `SELECT ${ADDRESS_COLUMNS} FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC`,
    [id],
  );
  sendData(res, result.rows.map(toAddress));
});

addressRouter.post('/', validate('body', addressBody), async (req, res) => {
  const { id: userId } = currentUser(req);
  const body = input<typeof addressBody>(req, 'body');

  const created = await withTransaction(async (client) => {
    const existing = await query<{ count: string }>(
      'SELECT count(*) AS count FROM addresses WHERE user_id = $1',
      [userId],
      client,
    );
    // The first address is always the default.
    const makeDefault = body.isDefault === true || Number(existing.rows[0].count) === 0;
    if (makeDefault) await clearDefault(client, userId);

    const columns = [...COLUMN_MAP.map(([, col]) => col), 'user_id', 'is_default'];
    const values = [...COLUMN_MAP.map(([key]) => body[key] ?? null), userId, makeDefault];
    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
    const result = await query<AddressRow>(
      `INSERT INTO addresses (${columns.join(', ')}) VALUES (${placeholders}) RETURNING ${ADDRESS_COLUMNS}`,
      values,
      client,
    );
    return result.rows[0];
  });
  sendData(res, toAddress(created), 201);
});

addressRouter.patch(
  '/:addressId',
  validate('params', addressParams),
  validate('body', addressPatch),
  async (req, res) => {
    const { id: userId } = currentUser(req);
    const { addressId } = input<typeof addressParams>(req, 'params');
    const body = input<typeof addressPatch>(req, 'body');

    const updated = await withTransaction(async (client) => {
      await ownedAddress(client, userId, addressId);
      if (body.isDefault === true) await clearDefault(client, userId, addressId);

      const sets: string[] = [];
      const values: unknown[] = [];
      for (const [key, col] of COLUMN_MAP) {
        if (body[key] !== undefined) {
          values.push(body[key] ?? null);
          sets.push(`${col} = $${values.length}`);
        }
      }
      if (body.isDefault !== undefined) {
        // Un-setting the default is only allowed by setting another address as default.
        if (body.isDefault === false) {
          const current = await ownedAddress(client, userId, addressId);
          if (current.is_default) {
            throw conflict(
              'DEFAULT_ADDRESS_REQUIRED',
              'Set another address as default instead of unsetting this one.',
            );
          }
        }
        values.push(body.isDefault);
        sets.push(`is_default = $${values.length}`);
      }
      if (sets.length === 0) return ownedAddress(client, userId, addressId);

      values.push(addressId);
      sets.push('updated_at = now()');
      const result = await query<AddressRow>(
        `UPDATE addresses SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING ${ADDRESS_COLUMNS}`,
        values,
        client,
      );
      return result.rows[0];
    });
    sendData(res, toAddress(updated));
  },
);

addressRouter.delete('/:addressId', validate('params', addressParams), async (req, res) => {
  const { id: userId } = currentUser(req);
  const { addressId } = input<typeof addressParams>(req, 'params');

  await withTransaction(async (client) => {
    const address = await ownedAddress(client, userId, addressId);
    await query('DELETE FROM addresses WHERE id = $1', [addressId], client);
    if (address.is_default) {
      // Promote the most recent remaining address so the customer always has a default when one exists.
      await query(
        `UPDATE addresses SET is_default = true
         WHERE id = (SELECT id FROM addresses WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1)`,
        [userId],
        client,
      );
    }
  });
  res.status(204).end();
});
