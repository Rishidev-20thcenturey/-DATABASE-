import { Router } from 'express';
import { z } from 'zod';
import { input, validate } from '../../middleware/validate.js';
import { idParams, pageQuery } from '../../validators/common.js';
import { pageMeta, sendData, sendList } from '../../utils/http.js';
import * as service from './service.js';

const listQuery = pageQuery.extend({
  q: z.string().trim().min(1).max(100).optional(),
  cuisine: z.string().trim().min(1).max(60).optional(),
  open: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  postalCode: z.string().regex(/^[0-9]{6}$/, 'Postal code must be 6 digits.').optional(),
  sort: z.enum(['rating', 'name', 'newest', 'minOrder']).default('rating'),
});

const restaurantParams = idParams('restaurantId');
const itemParams = idParams('itemId');

export const restaurantRouter = Router();

restaurantRouter.get('/', validate('query', listQuery), async (req, res) => {
  const q = input<typeof listQuery>(req, 'query');
  const { rows, total } = await service.listRestaurants({
    q: q.q,
    cuisine: q.cuisine,
    open: q.open,
    postalCode: q.postalCode,
    sort: q.sort,
    page: q.page,
    limit: q.limit,
  });
  sendList(res, rows, pageMeta(q.page, q.limit, total));
});

restaurantRouter.get('/:restaurantId', validate('params', restaurantParams), async (req, res) => {
  const { restaurantId } = input<typeof restaurantParams>(req, 'params');
  sendData(res, await service.getRestaurant(restaurantId));
});

restaurantRouter.get('/:restaurantId/menu', validate('params', restaurantParams), async (req, res) => {
  const { restaurantId } = input<typeof restaurantParams>(req, 'params');
  sendData(res, await service.getMenu(restaurantId));
});

restaurantRouter.get(
  '/:restaurantId/reviews',
  validate('params', restaurantParams),
  validate('query', pageQuery),
  async (req, res) => {
    const { restaurantId } = input<typeof restaurantParams>(req, 'params');
    const q = input<typeof pageQuery>(req, 'query');
    const { rows, total } = await service.listReviews(restaurantId, q.page, q.limit);
    sendList(res, rows, pageMeta(q.page, q.limit, total));
  },
);

export const menuItemRouter = Router();

menuItemRouter.get('/:itemId', validate('params', itemParams), async (req, res) => {
  const { itemId } = input<typeof itemParams>(req, 'params');
  sendData(res, await service.getMenuItem(itemId));
});
