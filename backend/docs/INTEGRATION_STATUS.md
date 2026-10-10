# Integration Status

Last updated: 2026-10-10. This page records what is built, what was run to verify it, and what is still open. It describes
the backend in `backend/`. The frontend has not been started by this work.

The backend is merged into `main` (PR #1, `feature/backend-api`) and the CI workflow is green on GitHub.

## 1. Summary

| Area | Status |
| --- | --- |
| Endpoints from the master spec | Implemented (51 operations, all in `openapi.yaml`) |
| Auth, roles, ownership checks | Implemented and tested |
| Cart, checkout, pricing, idempotency | Implemented and tested |
| Order lifecycle (state machine) | Implemented and tested |
| Owner, courier, admin flows | Implemented and tested |
| Reviews | Implemented and tested |
| OpenAPI 3.1 spec | Written, validated with Redocly, and checked against the code by a test |
| Frontend integration guide | Written (`FRONTEND_INTEGRATION.md`) |
| CI workflow | Written (`.github/workflows/backend.yml`) and **passing on GitHub** (3/3 runs on PR #1: branch push, `pull_request`, and the merge to `main`) |
| Commit / push / PR | Merged — PR #1 `feature/backend-api` → `main` |

## 2. Endpoints

Every operation below is documented in `docs/openapi.yaml` and checked by `tests/openapi-contract.test.ts`.

| Group | Endpoints | Tested by |
| --- | --- | --- |
| System | `GET /health`, `GET /ready`, `GET /openapi.yaml`, `GET /docs` | smoke, contract |
| Auth | `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me` | auth, access-control |
| Restaurants | `GET /restaurants`, `GET /restaurants/{id}`, `GET /restaurants/{id}/menu`, `GET /restaurants/{id}/reviews`, `GET /menu-items/{id}` | catalog-cart-checkout, seed |
| Addresses | `GET/POST /me/addresses`, `PATCH/DELETE /me/addresses/{id}` | catalog-cart-checkout, access-control |
| Cart | `GET /cart`, `POST /cart/items`, `PATCH/DELETE /cart/items/{id}`, `DELETE /cart` | catalog-cart-checkout |
| Checkout | `POST /checkout/preview`, `POST /checkout` (with `Idempotency-Key`) | catalog-cart-checkout |
| Orders | `GET /orders`, `GET /orders/{id}`, `POST /orders/{id}/cancel`, `POST /orders/{id}/review` | orders-lifecycle, access-control |
| Owner | restaurant read/update, menu categories and items, incoming orders (accept, reject, status) | owner-admin |
| Courier | `GET /courier/deliveries`, `GET /courier/deliveries/{id}`, `PATCH /courier/deliveries/{id}/status` | access-control, orders-lifecycle |
| Admin | users, restaurants, orders, courier assignment, cancel, audit log | owner-admin, access-control |

Not yet covered by an automated test: `GET /owner/restaurants/{id}/orders`, `GET /admin/audit-logs` filters, and
`GET /restaurants/{id}/reviews` pagination. They are implemented but have not been exercised by a test or by hand yet.

## 3. Verification results

All commands were run from `backend/` on the final code in this branch of work.

| Check | Command | Result |
| --- | --- | --- |
| Type check | `npx tsc -p tsconfig.json --noEmit` | exit 0, no errors |
| Lint | `npx eslint src tests scripts` | exit 0, no errors |
| Tests | `npx vitest run` | **9 files, 125 tests, all passed** (about 37 s) |
| Build | `npm run build` | exit 0, output to `dist/` |
| OpenAPI validation | `npx @redocly/cli@latest lint docs/openapi.yaml` | valid. 0 errors, 15 warnings (missing 4xx on some operations) |
| Migrations | `npm run db:migrate` against a local PostgreSQL | applied `001_init.sql` |
| Seed | `npm run db:seed`, run twice | both runs succeed; counts unchanged on the second run (4 users, 2 restaurants, 5 menu items) |

Test files and what they cover:

- `smoke.test.ts`: app boots, health, ready
- `auth.test.ts`: registration (always CUSTOMER), login, refresh rotation, reuse detection, logout, `/auth/me`
- `access-control.test.ts`: role gates, cross-customer and cross-courier access returns 404, suspended accounts, rate limit on login
- `catalog-cart-checkout.test.ts`: catalogue, addresses, cart rules, server-side pricing (client prices ignored), minimum order, idempotent checkout
- `orders-lifecycle.test.ts`: owner accept or reject, status transitions, courier pickup and delivery, customer cancel rules, admin cancel, reviews
- `owner-admin.test.ts`: owner menu management, admin user and restaurant management, courier assignment, audit log
- `seed.test.ts`: seed creates the accounts and menus and is safe to run twice
- `openapi-contract.test.ts`: spec parses as OpenAPI 3.1, every implemented operation is documented, no documented operation is missing, `/api/v1/openapi.yaml` is served
- `order-query-performance.test.ts`: order lists are batched (listing twice as many orders costs the same number of queries), and no connection ever has two queries in flight at once

The test run uses its own embedded PostgreSQL on port 54329 and creates it fresh each run.

### Manual end-to-end check

Against the local dev database (seeded), using `curl`:

- Login as customer → 200 with access token, user, and `expiresIn: 900`
- `GET /restaurants` → 2 restaurants with `isOpen`, `minOrderMinor`, `deliveryFeeMinor`
- `GET /restaurants/{id}/menu` → categories with priced items
- `POST /cart/items` (2 × Litti Chokha) → cart with subtotal 19800, delivery fee 3000, tax 990, total 23790 (all paise)
- `POST /checkout/preview` → `canPlaceOrder: true`, no blockers
- No token on `/cart` → 401 `UNAUTHENTICATED`
- Unknown route → 404 `ROUTE_NOT_FOUND` with `requestId`
- Login with missing password → 400 `VALIDATION_ERROR` with field details
- `POST /auth/register` with `"role": "ADMIN"` → 400 (unknown field rejected; public signup cannot pick a role)
- `POST /auth/refresh` with no cookie → 401 `REFRESH_TOKEN_INVALID`
- `POST /auth/refresh` with a foreign `Origin` → 403 `FORBIDDEN`
- `POST /checkout` with an invalid `Idempotency-Key` → 400 `INVALID_IDEMPOTENCY_KEY`

I did not place a full order through the live server by hand. The order flow is covered by `orders-lifecycle.test.ts`
and `catalog-cart-checkout.test.ts`.

## 4. Bugs and performance problems found and fixed during this work

These were found by the tests and fixed before the verification results above:

- Checkout returned 500 because the order view read a `courier_id` column that does not exist. The courier now comes
  from the `deliveries` table.
- Refresh-token reuse detection rolled back its own revocation, because the error was thrown inside the transaction.
  Revocation now commits before the error is returned.
- Late customer cancel returned 403 instead of 409 `ORDER_NOT_CANCELLABLE`.
- Restaurant detail was missing `status` and `isAcceptingOrders`.
- Owner menu item and category updates returned snake_case fields; they now return camelCase like the rest of the API.
- Order lists were N+1: each order cost three more queries, so a page of 20 orders ran 60+ queries
  against a pool of 10. `buildOrderViews` now loads the orders, their items, and their status history
  in three queries total, and `tests/order-query-performance.test.ts` fails if that ever regresses.
- Batching naively would have pushed three concurrent queries onto a transaction's single connection.
  pg queues those and deprecates the pattern (it is removed in pg 9), so the batch loads run one at a
  time when a transaction connection is supplied and in parallel only when each query gets its own
  pooled connection.

## 5. Known limitations

- **Cash on delivery only.** Online payments are not implemented.
- **No real-time updates.** The frontend has to poll order status.
- **No coupons.** `discountMinor` is always 0.
- **No email or phone verification.**
- **Owner and admin flows are tested through the API only.** No UI or browser tests exist.
- **Dev seed restaurants are open 00:00–23:59** so demos work at any time. Real restaurants should set real hours.
- **Rate limits are per process in memory.** Multiple API instances would each keep their own counters. A shared store such as Redis would be needed to enforce limits across instances.
- **Dev database is embedded PostgreSQL.** `npm run db:embedded` is for local development only. Production needs a managed PostgreSQL.
- **No load or performance testing.**
- **No security review or penetration test.** Tests cover the access rules, but nothing has been audited externally.
- **Opening hours are same-day windows in IST.** `isOpen` is true when the current IST time is between `opensAt` and `closesAt`. Overnight hours (for example 22:00 to 02:00) are not supported yet, and holidays are not handled.
- **Windows path handling** in the seed's run-directly check was rewritten to use `fileURLToPath`, but the seed has only been run on Linux.

## 6. Environment and configuration

- Copy `backend/.env.example` to `backend/.env`. Required: `DATABASE_URL`, `JWT_ACCESS_SECRET` (32+ characters).
- Required for seeding: `DEV_SEED_PASSWORD` (8+ characters). The seed refuses to run when `NODE_ENV=production`.
- Set `CORS_ORIGINS` to the frontend origin.
- Cross-site HTTPS deployments need `COOKIE_SAMESITE=none` and `COOKIE_SECURE=true`.

## 7. Open items

The backend is committed, pushed, merged to `main`, and CI is green, so nothing here blocks a frontend
from building against it today.

1. **Frontend.** No frontend work has started. `FRONTEND_INTEGRATION.md` and `docs/openapi.yaml` are the
   starting point.
2. **Collaborator access** on `-DATABASE-` is managed by you.
3. **Online payments.** Cash on delivery is the only implemented payment method.
4. **Operational gaps to close before real traffic:** request logging (only errors are logged today),
   a job to delete expired and revoked refresh tokens (the table grows without bound), and shared
   rate-limit counters if the API ever runs on more than one instance.
5. **Endpoints still without an automated test:** `GET /owner/restaurants/{id}/orders`,
   `GET /admin/audit-logs` filters, and `GET /restaurants/{id}/reviews` pagination. They are
   implemented and were exercised by hand, and the order-list batching is covered indirectly by
   `order-query-performance.test.ts`.
