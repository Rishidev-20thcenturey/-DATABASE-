import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Request, type Response } from 'express';
import helmet from 'helmet';
import { corsOrigins, type Env } from './config/env.js';
import { query } from './db/pool.js';
import { configureAuth } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { createApiRateLimit } from './middleware/rate-limit.js';
import { requestId } from './middleware/request-id.js';
import { addressRouter } from './modules/addresses/routes.js';
import { adminRouter } from './modules/admin/routes.js';
import { authRouter } from './modules/auth/routes.js';
import { cartRouter } from './modules/cart/routes.js';
import { checkoutRouter } from './modules/checkout/routes.js';
import { courierRouter } from './modules/courier/routes.js';
import { orderRouter } from './modules/orders/routes.js';
import { ownerRouter } from './modules/owner/routes.js';
import { menuItemRouter, restaurantRouter } from './modules/restaurants/routes.js';
import { sendData } from './utils/http.js';

export const API_PREFIX = '/api/v1';
const docsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');

export function createApp(env: Env): express.Express {
  configureAuth(env.JWT_ACCESS_SECRET);
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', 1);

  app.use(requestId);
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, callback) => {
        // Requests without an Origin header (curl, server-to-server) are not browser CORS requests.
        if (!origin || corsOrigins(env).includes(origin)) return callback(null, true);
        return callback(null, false);
      },
      credentials: true,
      allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id', 'Idempotent-Replayed'],
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(API_PREFIX, createApiRateLimit(env.API_RATE_LIMIT_MAX));

  // Health: never reveals secrets, connection strings, or stack traces.
  app.get(`${API_PREFIX}/health`, (_req: Request, res: Response) => {
    sendData(res, { status: 'ok' });
  });

  app.get(`${API_PREFIX}/ready`, async (_req: Request, res: Response) => {
    try {
      await query('SELECT 1');
      sendData(res, { status: 'ready', database: 'up' });
    } catch {
      res.status(503).json({ error: { code: 'NOT_READY', message: 'The service is not ready.', details: [] } });
    }
  });

  // API documentation: the OpenAPI spec and a human-readable index.
  app.get(`${API_PREFIX}/openapi.yaml`, async (_req: Request, res: Response) => {
    res.type('application/yaml').send(await readFile(path.join(docsDir, 'openapi.yaml'), 'utf8'));
  });
  app.get('/docs', (_req: Request, res: Response) => {
    res.type('html').send(DOCS_PAGE);
  });

  app.use(`${API_PREFIX}/auth`, authRouter(env));
  app.use(`${API_PREFIX}/restaurants`, restaurantRouter);
  app.use(`${API_PREFIX}/menu-items`, menuItemRouter);
  app.use(`${API_PREFIX}/me/addresses`, addressRouter);
  app.use(`${API_PREFIX}/cart`, cartRouter);
  app.use(`${API_PREFIX}/checkout`, checkoutRouter(env));
  app.use(`${API_PREFIX}/orders`, orderRouter);
  app.use(`${API_PREFIX}/owner`, ownerRouter);
  app.use(`${API_PREFIX}/courier`, courierRouter);
  app.use(`${API_PREFIX}/admin`, adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const DOCS_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Food Delivery API docs</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto;">
<h1>Food Delivery API</h1>
<p>The OpenAPI 3.1 specification is at <a href="${API_PREFIX}/openapi.yaml">${API_PREFIX}/openapi.yaml</a>.</p>
<p>Integration guide: <code>docs/FRONTEND_INTEGRATION.md</code> in the repository.</p>
</body></html>`;
