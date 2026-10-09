import { z } from 'zod';

export const uuidParam = z.uuid({ message: 'Must be a valid UUID.' });

export const idParams = (name: string) => z.object({ [name]: uuidParam }).strict();

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const minorUnits = z
  .number()
  .int('Amount must be an integer number of paise.')
  .min(0)
  .max(10_000_000, 'Amount is too large.');

export const postalCode = z.string().regex(/^[0-9]{6}$/, 'Postal code must be 6 digits.');

export const optionalUrl = z.url({ protocol: /^https?$/ }).max(2048).nullable().optional();

export const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be in HH:MM (24-hour) format.');
