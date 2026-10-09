import { Router } from 'express';
import { z } from 'zod';
import { authenticate, currentUser, requireRole } from '../../middleware/auth.js';
import { input, validate } from '../../middleware/validate.js';
import { sendData } from '../../utils/http.js';
import { idParams, uuidParam } from '../../validators/common.js';
import { MAX_QUANTITY, addItem, clearCart, getCartView, removeItem, updateItemQuantity } from './service.js';

const quantity = z.number().int().min(1).max(MAX_QUANTITY);

const addItemBody = z
  .object({
    menuItemId: uuidParam,
    quantity,
    /** Set to true after the frontend asks the customer whether to replace a cart from another restaurant. */
    replaceExistingCart: z.boolean().default(false),
  })
  .strict();

const updateItemBody = z.object({ quantity }).strict();
const cartItemParams = idParams('itemId');

export const cartRouter = Router();
cartRouter.use(authenticate, requireRole('CUSTOMER'));

cartRouter.get('/', async (req, res) => {
  sendData(res, await getCartView(currentUser(req).id));
});

cartRouter.post('/items', validate('body', addItemBody), async (req, res) => {
  const body = input<typeof addItemBody>(req, 'body');
  sendData(res, await addItem(currentUser(req).id, body), 201);
});

cartRouter.patch('/items/:itemId', validate('params', cartItemParams), validate('body', updateItemBody), async (req, res) => {
  const { itemId } = input<typeof cartItemParams>(req, 'params');
  const body = input<typeof updateItemBody>(req, 'body');
  sendData(res, await updateItemQuantity(currentUser(req).id, itemId, body.quantity));
});

cartRouter.delete('/items/:itemId', validate('params', cartItemParams), async (req, res) => {
  const { itemId } = input<typeof cartItemParams>(req, 'params');
  sendData(res, await removeItem(currentUser(req).id, itemId));
});

cartRouter.delete('/', async (req, res) => {
  sendData(res, await clearCart(currentUser(req).id));
});
