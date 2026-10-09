import { Router } from 'express';
import { z } from 'zod';
import type { Env } from '../../config/env.js';
import { authenticate, currentUser, requireRole } from '../../middleware/auth.js';
import { input, validate } from '../../middleware/validate.js';
import { badRequest, conflict } from '../../utils/errors.js';
import { sendData } from '../../utils/http.js';
import { uuidParam } from '../../validators/common.js';
import { checkout, previewCheckout } from '../orders/service.js';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

const checkoutBody = z
  .object({
    addressId: uuidParam,
    paymentMethod: z.literal('COD'),
    customerNote: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

const previewBody = z.object({ addressId: uuidParam }).strict();

export function checkoutRouter(env: Env): Router {
  const router = Router();
  router.use(authenticate, requireRole('CUSTOMER'));

  router.post('/preview', validate('body', previewBody), async (req, res) => {
    const body = input<typeof previewBody>(req, 'body');
    sendData(res, await previewCheckout(currentUser(req).id, body.addressId));
  });

  router.post('/', validate('body', checkoutBody), async (req, res) => {
    const body = input<typeof checkoutBody>(req, 'body');
    if (body.paymentMethod === 'COD' && !env.ENABLE_COD) {
      throw conflict('PAYMENT_METHOD_UNAVAILABLE', 'Cash on delivery is not enabled.');
    }

    const headerKey = req.header('idempotency-key') ?? null;
    if (headerKey !== null && !IDEMPOTENCY_KEY.test(headerKey)) {
      throw badRequest('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8 to 100 letters, digits, hyphens, or underscores.');
    }

    const result = await checkout({
      customerId: currentUser(req).id,
      addressId: body.addressId,
      paymentMethod: body.paymentMethod,
      customerNote: body.customerNote ?? null,
      idempotencyKey: headerKey,
    });

    if (result.replayed) {
      res.setHeader('Idempotent-Replayed', 'true');
      return sendData(res, result.order, 200);
    }
    return sendData(res, result.order, 201);
  });

  return router;
}
