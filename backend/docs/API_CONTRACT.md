# Food Delivery API — Contract

This document describes the rules that every endpoint follows. The endpoint-by-endpoint reference is
[`openapi.yaml`](./openapi.yaml), served by the running API at `/api/v1/openapi.yaml`. When the two disagree, the
OpenAPI file is the source of truth for request and response shapes, and `tests/openapi-contract.test.ts` checks that
every implemented route is documented there.

- Base URL (local): `http://localhost:4000/api/v1`
- Content type: `application/json` for request and response bodies (`/auth/logout` and `204` responses have no body)
- Currency: INR. All money is an **integer in minor units (paise)**. `19900` means Rs 199.00. Never send decimals.
- Timestamps: ISO 8601 strings in UTC (`2026-10-10T06:30:00.000Z`).
- IDs: UUID v4 strings. Treat them as opaque.

## 1. Response envelope

Success:

```json
{ "data": { "id": "…" } }
```

Paginated list:

```json
{
  "data": [ { "id": "…" } ],
  "meta": { "page": 1, "limit": 20, "total": 42, "totalPages": 3 }
}
```

Error:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request contains invalid fields.",
    "details": [ { "field": "email", "message": "Invalid email address" } ],
    "requestId": "cdb3bd1b-9a20-4a72-b7ee-57df4b1095a6"
  }
}
```

- Branch on `error.code`. The `message` is human-readable, may change, and is not stable.
- `details` is always an array (possibly empty). For `VALIDATION_ERROR`, each entry has `field` and `message`.
- `requestId` is also returned in the `X-Request-Id` response header. Include it in bug reports.

## 2. HTTP status usage

| Status | Meaning |
| --- | --- |
| 200 | Success with a body (also checkout replay) |
| 201 | Resource created |
| 204 | Success, no body (logout, address delete) |
| 400 | Malformed input, validation failure, invalid `Idempotency-Key` |
| 401 | Missing, invalid, or expired access token; invalid refresh token |
| 403 | Authenticated but the role is not allowed; suspended account; disallowed `Origin` on cookie endpoints |
| 404 | Not found **or not yours**. Ownership failures return 404 on purpose so IDs cannot be probed |
| 409 | Business-rule conflict (see the error codes below) |
| 413 | Request body over 100 kB |
| 429 | Rate limited |
| 500 | Unexpected server error (`INTERNAL_ERROR`) |
| 503 | Not ready (`/ready` only) |

## 3. Error codes

Each code is listed with the statuses that can carry it.

**Generic**

| Code | Status | Meaning |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | Body, query, or path failed validation. See `details`. |
| `MALFORMED_JSON` | 400 | The request body is not valid JSON. |
| `PAYLOAD_TOO_LARGE` | 413 | Body exceeds 100 kB. |
| `UNAUTHENTICATED` | 401 | No `Authorization: Bearer` header. |
| `TOKEN_INVALID` | 401 | Access token is invalid, expired, or its user no longer exists. Refresh and retry once. |
| `FORBIDDEN` | 403 | The role is not allowed, the account is suspended, or the request origin is not allowed. |
| `NOT_FOUND` | 404 | Resource not found or not visible to you. |
| `ROUTE_NOT_FOUND` | 404 | No route matches the method and path. |
| `RATE_LIMITED` | 429 | Too many requests. Auth limits reset per 15 minutes; API limits per minute. |
| `INTERNAL_ERROR` | 500 | Unexpected failure. Retry later and quote `requestId`. |
| `NOT_READY` | 503 | `/ready` could not reach the database. |

**Authentication**

| Code | Status | Meaning |
| --- | --- | --- |
| `EMAIL_ALREADY_REGISTERED` | 409 | Email already has an account. |
| `INVALID_CREDENTIALS` | 401 | Wrong email or password. Same response for unknown emails. |
| `REFRESH_TOKEN_INVALID` | 401 | Refresh cookie is missing or unknown. |
| `REFRESH_TOKEN_EXPIRED` | 401 | Refresh cookie has expired. Sign in again. |
| `REFRESH_TOKEN_REUSED` | 401 | A rotated refresh token was presented again. All sessions for that user are revoked. Sign in again. |

**Cart and checkout**

| Code | Status | Meaning |
| --- | --- | --- |
| `CART_RESTAURANT_MISMATCH` | 409 | The cart holds items from another restaurant. Resend with `replaceExistingCart: true` to switch. |
| `QUANTITY_LIMIT_EXCEEDED` | 400 | Quantity over 50 for one line. |
| `ITEM_UNAVAILABLE` | 409 | An item is currently unavailable. |
| `CART_EMPTY` | 409 | Checkout attempted with an empty cart. |
| `DEFAULT_ADDRESS_REQUIRED` | 409 | You cannot unset the only default address. Set another address as default instead. |
| `RESTAURANT_UNAVAILABLE` | 409 | The restaurant is not active. |
| `RESTAURANT_CLOSED` | 409 | The restaurant is outside opening hours or not accepting orders. |
| `MINIMUM_ORDER_NOT_MET` | 409 | Subtotal is below the restaurant minimum. |
| `PAYMENT_METHOD_UNAVAILABLE` | 409 | The payment method is disabled on this server. |
| `INVALID_IDEMPOTENCY_KEY` | 400 | `Idempotency-Key` header is not 8–100 letters, digits, `-`, or `_`. |
| `IDEMPOTENCY_KEY_REUSED` | 409 | Same `Idempotency-Key` used with a different request body. |

**Orders, reviews, and admin**

| Code | Status | Meaning |
| --- | --- | --- |
| `INVALID_STATUS_TRANSITION` | 409 | The order cannot move to the requested status from its current status. |
| `ROLE_NOT_PERMITTED` | 403 | Reserved for the state machine. Over HTTP this surfaces as `FORBIDDEN` with a specific message. |
| `ORDER_NOT_CANCELLABLE` | 409 | Customer cancel is only allowed while the order is `PENDING_RESTAURANT_CONFIRMATION`. |
| `ORDER_NOT_REVIEWABLE` | 409 | Reviews are only allowed after `DELIVERED`. |
| `REVIEW_ALREADY_EXISTS` | 409 | This order already has a review. |
| `ORDER_NOT_ASSIGNABLE` | 409 | Couriers can only be assigned to `CONFIRMED`, `PREPARING`, or `READY_FOR_PICKUP` orders. |
| `INVALID_COURIER` | 409 | The user is not an active courier. |
| `SELF_MODIFICATION_NOT_ALLOWED` | 409 | An admin tried to suspend or demote their own account. |

## 4. Authentication

- **Access token**: a JWT (HS256) returned in the JSON body. Send it as `Authorization: Bearer <token>`. It lasts
  `expiresIn` seconds (900 by default). Keep it in memory, not in `localStorage`.
- **Refresh token**: an opaque value set as an HttpOnly cookie named `refresh_token`, with path `/api/v1/auth`. It is
  never in a response body and JavaScript cannot read it. The browser sends it automatically to `/auth/*` once
  requests use `credentials: 'include'`.
- **Rotation**: each `POST /auth/refresh` revokes the presented refresh token and sets a new cookie. Presenting a
  revoked token returns `REFRESH_TOKEN_REUSED` and revokes all of that user's sessions.
- **Role and status are checked on every request.** The server re-reads the user's role and status from the database,
  so a role change or suspension takes effect at the next request, not when the token expires.
- **Public registration creates only `CUSTOMER` accounts.** `RESTAURANT_OWNER`, `COURIER`, and `ADMIN` accounts are
  created or promoted by an administrator.
- **Cookie-endpoint origin check**: `/auth/refresh` and `/auth/logout` reject requests whose `Origin` header is not in
  `CORS_ORIGINS` (`403 FORBIDDEN`). Requests with no `Origin` (curl, server-to-server) are allowed.

Password rules: 8 to 72 bytes. Phone numbers: `^\+?[0-9]{10,15}$`.

## 5. Roles

| Role | Can do |
| --- | --- |
| `CUSTOMER` | Register, manage addresses, browse restaurants, use the cart, check out, view and cancel own orders, review delivered orders |
| `RESTAURANT_OWNER` | Manage own restaurants: details, categories, menu items, incoming orders (accept, reject, PREPARING, READY_FOR_PICKUP) |
| `COURIER` | View own assigned deliveries, record PICKED_UP, OUT_FOR_DELIVERY, DELIVERED |
| `ADMIN` | Manage users (role, status), restaurants (status, tax, accepting orders), assign couriers, cancel orders, read the audit log |

Anyone may call the public catalogue endpoints without a token (restaurants, menus, menu items, reviews).

## 6. Pagination, filtering, sorting

- Query params: `page` (default 1), `limit` (default 20, max 50).
- Lists return `meta: { page, limit, total, totalPages }`.
- Restaurant list: `q`, `cuisine`, `open=true|false`, `postalCode` (6 digits), `sort=rating|name|newest|minOrder`
  (default `rating`).
- Admin and owner lists accept `status` filters (see `openapi.yaml`).

## 7. Idempotency

`POST /checkout` accepts an `Idempotency-Key` header (8–100 characters: letters, digits, `-`, `_`).

- First request with a key: `201 Created` with the new order.
- Same key, same request body: `200 OK` with the original order and the response header `Idempotent-Replayed: true`.
- Same key, different body: `409 IDEMPOTENCY_KEY_REUSED`.

The header is optional in the API, but clients **must** send it: without it, a network retry can create a second order.
The frontend should generate one key per checkout attempt (for example a UUID v4) and reuse it for retries of that
attempt only.

## 8. Money and pricing

- The cart and checkout preview return a breakdown:
  `subtotalMinor`, `deliveryFeeMinor`, `taxMinor`, `discountMinor` (always 0 for now), `totalMinor`, `currency: "INR"`.
- `totalMinor = subtotalMinor + deliveryFeeMinor + taxMinor - discountMinor`.
- Tax is `subtotalMinor × taxBps / 10000`, rounded half-up to the nearest paisa. Each restaurant sets `taxBps`.
- Delivery fee comes from the restaurant.
- **The server always calculates prices.** Anything the client sends about prices is ignored. Checkout recalculates
  from current menu prices and returns the authoritative totals in the order.
- Cart totals are estimates. The order's `pricing` is final.

## 9. Order lifecycle

```
PENDING_RESTAURANT_CONFIRMATION ──accept (OWNER)──▶ CONFIRMED ──preparing (OWNER)──▶ PREPARING
        │                              │                                             │
        ├─reject (OWNER)──▶ REJECTED   └─cancel (ADMIN)──▶ CANCELLED                 ready (OWNER)
        └─cancel (CUSTOMER, ADMIN)──▶ CANCELLED                                       ▼
                                                                          READY_FOR_PICKUP
                                                                                      │ picked up (COURIER, ADMIN)
                                                                                      ▼
                                       DELIVERED ◀──delivered (COURIER, ADMIN)── OUT_FOR_DELIVERY ◀──out (COURIER, ADMIN)── PICKED_UP
```

- `REJECTED`, `CANCELLED`, and `DELIVERED` are terminal.
- Any move not in this table returns `409 INVALID_STATUS_TRANSITION`.
- Every move is recorded in `timeline` (status and timestamp, oldest first).
- Customers can cancel only while `PENDING_RESTAURANT_CONFIRMATION`. Admins can cancel while the order is pending or
  `CONFIRMED`.
- Courier assignment (admin) is allowed while the order is `CONFIRMED`, `PREPARING`, or `READY_FOR_PICKUP`.

Payment: **cash on delivery only** (`paymentMethod: "COD"`). `paymentStatus` is `COD_PENDING` until the courier
records delivery, then `COD_COLLECTED`.

## 10. Data shapes at a glance

Full schemas are in `openapi.yaml`. The most-used objects:

- `User`: `{ id, name, email, phone, role, status, createdAt }`
- `Session` (login, register, refresh): `{ accessToken, tokenType: "Bearer", expiresIn, user }`
- `RestaurantSummary`: `{ id, name, description, logoUrl, coverUrl, cuisines, city, postalCode, opensAt, closesAt, isOpen, minOrderMinor, deliveryFeeMinor, prepMinutes, deliveryMinutes, ratingAverage, ratingCount, currency }`
- `MenuCategory`: `{ id, name, description, displayOrder, items: [{ id, name, description, imageUrl, priceMinor, isVeg, dietaryLabels, isAvailable }] }`
- `Cart`: `{ restaurant, items: [{ id, menuItemId, name, unitPriceMinor, quantity, lineTotalMinor, isAvailable }], pricing, minimumOrderMinor, itemCount, warnings }`
- `OrderDetail`: `{ id, orderNumber, status, paymentMethod, paymentStatus, restaurant, deliveryAddress, customerNote, items, pricing, courier, timeline, createdAt, updatedAt, confirmedAt, deliveredAt, cancelledAt, cancelReason }`

## 11. Versioning and compatibility

- The path prefix `/api/v1` is the compatibility boundary. Breaking changes go to `/api/v2`.
- Additive changes (new optional fields, new endpoints, new enum values in responses) are non-breaking. Clients should
  ignore unknown fields and handle unknown enum values gracefully.
- Most request bodies are strict: unknown fields are rejected with `VALIDATION_ERROR`. Clients should send only the
  fields documented in `openapi.yaml`.
