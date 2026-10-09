import { Router } from 'express';
import { z } from 'zod';
import { authenticate, currentUser, requireRole } from '../../middleware/auth.js';
import { input, validate } from '../../middleware/validate.js';
import { ORDER_STATUSES } from '../../types/domain.js';
import { pageMeta, sendData, sendList } from '../../utils/http.js';
import { idParams, pageQuery } from '../../validators/common.js';
import { cancelByCustomer, getCustomerOrder, listCustomerOrders, reviewOrder } from './service.js';

const listQuery = pageQuery.extend({
  status: z.enum(ORDER_STATUSES).optional(),
});

const cancelBody = z.object({ reason: z.string().trim().min(1).max(300).optional() }).strict();

const reviewBody = z
  .object({
    rating: z.number().int().min(1).max(5),
    comment: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();

const orderParams = idParams('orderId');

export const orderRouter = Router();
orderRouter.use(authenticate, requireRole('CUSTOMER'));

orderRouter.get('/', validate('query', listQuery), async (req, res) => {
  const q = input<typeof listQuery>(req, 'query');
  const { orders, total } = await listCustomerOrders(currentUser(req).id, q.status, q.page, q.limit);
  sendList(res, orders, pageMeta(q.page, q.limit, total));
});

orderRouter.get('/:orderId', validate('params', orderParams), async (req, res) => {
  const { orderId } = input<typeof orderParams>(req, 'params');
  sendData(res, await getCustomerOrder(currentUser(req).id, orderId));
});

orderRouter.post('/:orderId/cancel', validate('params', orderParams), validate('body', cancelBody), async (req, res) => {
  const { orderId } = input<typeof orderParams>(req, 'params');
  const body = input<typeof cancelBody>(req, 'body');
  sendData(res, await cancelByCustomer(currentUser(req).id, orderId, body.reason ?? null));
});

orderRouter.post('/:orderId/review', validate('params', orderParams), validate('body', reviewBody), async (req, res) => {
  const { orderId } = input<typeof orderParams>(req, 'params');
  const body = input<typeof reviewBody>(req, 'body');
  sendData(
    res,
    await reviewOrder(currentUser(req).id, orderId, body.rating, body.comment ?? null),
    201,
  );
});
