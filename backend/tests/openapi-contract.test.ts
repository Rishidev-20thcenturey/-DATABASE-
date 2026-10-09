import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { app, request } from './helpers.js';

const specPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs/openapi.yaml');
const spec = parse(readFileSync(specPath, 'utf8')) as {
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
};

// Every endpoint the API implements, as "METHOD /api/v1/path" with OpenAPI path templates.
const IMPLEMENTED: string[] = [
  'get /health', 'get /ready',
  'post /auth/register', 'post /auth/login', 'post /auth/refresh', 'post /auth/logout', 'get /auth/me',
  'get /restaurants', 'get /restaurants/{restaurantId}', 'get /restaurants/{restaurantId}/menu',
  'get /restaurants/{restaurantId}/reviews', 'get /menu-items/{itemId}',
  'get /me/addresses', 'post /me/addresses', 'patch /me/addresses/{addressId}', 'delete /me/addresses/{addressId}',
  'get /cart', 'delete /cart', 'post /cart/items', 'patch /cart/items/{itemId}', 'delete /cart/items/{itemId}',
  'post /checkout/preview', 'post /checkout',
  'get /orders', 'get /orders/{orderId}', 'post /orders/{orderId}/cancel', 'post /orders/{orderId}/review',
  'get /owner/restaurants', 'get /owner/restaurants/{restaurantId}', 'patch /owner/restaurants/{restaurantId}',
  'get /owner/restaurants/{restaurantId}/menu', 'post /owner/restaurants/{restaurantId}/categories',
  'patch /owner/restaurants/{restaurantId}/categories/{categoryId}',
  'post /owner/restaurants/{restaurantId}/menu-items', 'patch /owner/restaurants/{restaurantId}/menu-items/{itemId}',
  'delete /owner/restaurants/{restaurantId}/menu-items/{itemId}', 'get /owner/restaurants/{restaurantId}/orders',
  'post /owner/orders/{orderId}/accept', 'post /owner/orders/{orderId}/reject', 'patch /owner/orders/{orderId}/status',
  'get /courier/deliveries', 'get /courier/deliveries/{orderId}', 'patch /courier/deliveries/{orderId}/status',
  'get /admin/users', 'patch /admin/users/{userId}', 'get /admin/restaurants', 'patch /admin/restaurants/{restaurantId}',
  'get /admin/orders', 'post /admin/orders/{orderId}/assign-courier', 'post /admin/orders/{orderId}/cancel',
  'get /admin/audit-logs',
];

describe('OpenAPI contract', () => {
  it('is an OpenAPI 3.1 document', () => {
    expect(spec.openapi).toBe('3.1.0');
  });

  it.each(IMPLEMENTED)('documents %s', (endpoint) => {
    const [method, route] = endpoint.split(' ');
    expect(spec.paths[route], `missing path ${route}`).toBeDefined();
    expect(spec.paths[route][method], `missing ${method} on ${route}`).toBeDefined();
  });

  it('documents no paths the API does not implement', () => {
    const documented = Object.entries(spec.paths).flatMap(([route, ops]) =>
      Object.keys(ops)
        .filter((m) => ['get', 'post', 'patch', 'put', 'delete'].includes(m))
        .map((m) => `${m} ${route}`),
    );
    const implemented = new Set(IMPLEMENTED);
    expect(documented.filter((e) => !implemented.has(e))).toEqual([]);
  });

  it('is served by the API at /api/v1/openapi.yaml', async () => {
    const res = await request(app).get('/api/v1/openapi.yaml');
    expect(res.status).toBe(200);
    expect(res.text).toContain('openapi: 3.1.0');
  });
});
