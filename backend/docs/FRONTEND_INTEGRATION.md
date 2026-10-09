# Frontend Integration Guide

This guide is for whoever builds the frontend. You only need this document, [`API_CONTRACT.md`](./API_CONTRACT.md), and
[`openapi.yaml`](./openapi.yaml). The OpenAPI file is served by the running API at `/api/v1/openapi.yaml`, so you can
generate a typed client from it.

Status of each endpoint and what has been tested: [`INTEGRATION_STATUS.md`](./INTEGRATION_STATUS.md).

## 1. Running the API locally

```bash
cd backend
cp .env.example .env            # then set JWT_ACCESS_SECRET (32+ chars) and DATABASE_URL
npm ci
npm run db:embedded             # local PostgreSQL on port 54330 (keep this running), or use your own PostgreSQL
npm run db:migrate
npm run db:seed                 # sample users, restaurants, and menus (needs DEV_SEED_PASSWORD in .env)
npm run dev                     # API on http://localhost:4000
```

- Base URL: `http://localhost:4000/api/v1`
- Set `CORS_ORIGINS` in `backend/.env` to your frontend origin (default `http://localhost:5173`).
- Health: `GET /api/v1/health`, readiness: `GET /api/v1/ready`.
- Human-readable docs index: `GET /docs`. Raw spec: `GET /api/v1/openapi.yaml`.

## 2. Sample data

After `npm run db:seed`, these accounts exist. The password is whatever you set in `DEV_SEED_PASSWORD`.

| Role | Email | Use it for |
| --- | --- | --- |
| `CUSTOMER` | `customer@dev.local` | Browsing, cart, checkout, order tracking, reviews |
| `RESTAURANT_OWNER` | `owner@dev.local` | Owner dashboard (menus, incoming orders) |
| `COURIER` | `courier@dev.local` | Courier deliveries |
| `ADMIN` | `admin@dev.local` | Admin screens |

Seeded restaurants (both open for demos at any hour, prices in paise):

| Restaurant | Min order | Delivery fee | Sample items |
| --- | --- | --- | --- |
| Bihari Bhoj | 15000 (Rs 150) | 3000 (Rs 30) | Veg Thali 14900, Litti Chokha (2 pcs) 9900, Tilkut 4900 |
| Chai Corner | 5000 (Rs 50) | 1500 (Rs 15) | Samosa (2 pcs) 4000, Kulhad Masala Chai 2000 |

Each seeded customer has one default address in Patna. Get the ID from `GET /me/addresses`.

The seed is idempotent: running `db:seed` again does not create duplicates. It refuses to run when `NODE_ENV=production`.

## 3. Calling the API from the browser

Every request needs these settings:

```ts
const API = import.meta.env.VITE_API_URL ?? '/api/v1';   // see section 3.1
async function api(path: string, init: RequestInit & { token?: string } = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    credentials: 'include',                      // required: sends and stores the refresh cookie
    headers: {
      'Content-Type': 'application/json',
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      ...init.headers,
    },
  });
  if (res.status === 204) return null;
  const body = await res.json();
  if (!res.ok) throw new ApiError(res.status, body.error);   // { code, message, details, requestId }
  return body;                                  // { data } or { data, meta }
}
```

### 3.1 Local development: use the dev server proxy

For local work, point the frontend dev server at the API so requests are same-origin and cookies just work. For example,
in Vite:

```ts
// vite.config.ts (frontend)
export default { server: { proxy: { '/api': 'http://localhost:4000' } } };
```

Then the frontend uses relative URLs (`/api/v1/...`). The browser never needs to call `localhost:4000` directly. If you
do call the API cross-origin, your origin must be listed in `CORS_ORIGINS`.

### 3.2 Cookies in production

The refresh cookie is `HttpOnly`, `Path=/api/v1/auth`, and `SameSite=Lax` by default. If the frontend and API are on
different sites over HTTPS, the backend needs `COOKIE_SAMESITE=none` and `COOKIE_SECURE=true`. If the API sits behind
a proxy, set `TRUST_PROXY=true`. Coordinate these with the backend owner.

## 4. Auth flow

1. **Register** (`POST /auth/register`) with `{ name, email, password, phone? }`. Creates a `CUSTOMER` and signs them in.
2. **Login** (`POST /auth/login`) with `{ email, password }`.
3. Both return `data: { accessToken, tokenType, expiresIn, user }`. Keep `accessToken` in memory. The refresh token is
   set as a cookie by the browser and is not readable from JavaScript.
4. **Load the session on app start**: call `POST /auth/refresh` (no body). If it returns 200, store the new
   `accessToken` and `user`. If it returns 401 (`REFRESH_TOKEN_INVALID` or `REFRESH_TOKEN_EXPIRED`), show the signed-out state.
5. **On a 401 `TOKEN_INVALID`** from any call: call `POST /auth/refresh` once, retry the original request with the new
   token, and if the refresh also fails, sign out. Do not loop.
6. **If `REFRESH_TOKEN_REUSED` is returned**, sign the user out and ask them to sign in again. This happens when another
   tab or device has rotated the session.
7. **Logout** (`POST /auth/logout`): clears the refresh cookie and revokes it. Then drop the access token from memory.
8. **`GET /auth/me`** returns the current user. Use it to check role and status.

Only one refresh should run at a time. If several requests fail with 401 together, share one in-flight refresh promise.

## 5. Customer flow

### 5.1 Browse

```
GET /restaurants?q=litti&cuisine=Bihari&open=true&sort=rating&page=1&limit=20
GET /restaurants/{restaurantId}              → restaurant detail (includes address)
GET /restaurants/{restaurantId}/menu         → categories with items (only active items)
GET /restaurants/{restaurantId}/reviews      → paginated reviews
GET /menu-items/{itemId}
```

Show `isOpen` and `minOrderMinor` on restaurant cards. Show `isAvailable: false` items as unavailable, not hidden.

### 5.2 Cart

Cart calls return the **full cart**, so the UI can replace its state with each response.

```
GET    /cart
POST   /cart/items          { "menuItemId": "…", "quantity": 2, "replaceExistingCart": false }   → 201
PATCH  /cart/items/{itemId} { "quantity": 3 }
DELETE /cart/items/{itemId}
DELETE /cart
```

- `{itemId}` in the cart routes is the **cart item ID** (`cart.items[].id`), not the menu item ID.
- The cart holds items from one restaurant only. If `POST /cart/items` returns `409 CART_RESTAURANT_MISMATCH`, ask the
  user whether to replace the cart, then resend with `replaceExistingCart: true`.
- `warnings` lists unavailable items (`ITEM_UNAVAILABLE`) and a subtotal below the minimum (`MINIMUM_ORDER_NOT_MET`).
  Disable the checkout button when there are warnings.
- The totals in the cart are estimates. Checkout recalculates them.

### 5.3 Addresses

```
GET    /me/addresses
POST   /me/addresses        { recipientName, recipientPhone, line1, city, state, postalCode, label?, landmark?, instructions?, isDefault? }
PATCH  /me/addresses/{id}   (any subset of the fields above)
DELETE /me/addresses/{id}   → 204
```

- The first address is the default automatically. Setting `isDefault: true` moves the default.
- You cannot clear the default flag directly (`409 DEFAULT_ADDRESS_REQUIRED`). Set another address as default instead.
- Postal code is 6 digits. Phone is `^\+?[0-9]{10,15}$`.

### 5.4 Checkout

Always preview first, then place the order with an idempotency key.

```
POST /checkout/preview   { "addressId": "…" }
POST /checkout           { "addressId": "…", "paymentMethod": "COD", "customerNote": "Less spice" }
                          Idempotency-Key: <uuid generated for this checkout attempt>
```

- Preview returns `pricing`, `minimumOrderMinor`, `availablePaymentMethods` (`["COD"]`), `blockers`, and
  `canPlaceOrder`. Show `blockers` to the user when `canPlaceOrder` is false.
- Checkout returns **201** with the new order. A retry with the same key returns **200** with the same order and the header
  `Idempotent-Replayed: true`. Show the same confirmation screen in both cases.
- Generate a new key for each new checkout attempt. Reuse the key only when retrying the same attempt, such as after a
  network error.
- On success the cart is emptied. Refetch the cart if you show a mini-cart.
- Business errors (409): `CART_EMPTY`, `ITEM_UNAVAILABLE`, `RESTAURANT_UNAVAILABLE`, `RESTAURANT_CLOSED`,
  `MINIMUM_ORDER_NOT_MET`, `PAYMENT_METHOD_UNAVAILABLE`. Show the `message` and send the user back to the cart or
  address step.

### 5.5 Orders

```
GET  /orders?status=…&page=1&limit=20     → your orders, newest first
GET  /orders/{orderId}                    → detail, including timeline and courier
POST /orders/{orderId}/cancel             { "reason": "…" }   (only while PENDING_RESTAURANT_CONFIRMATION)
POST /orders/{orderId}/review             { "rating": 1-5, "comment": "…" }   (only after DELIVERED, once)
```

- Poll `GET /orders/{orderId}` every 15 to 30 seconds while the order is active (not in a terminal status), or refetch on
  screen focus. There are no push notifications yet.
- Show the **timeline** as the progress bar. Terminal statuses: `REJECTED`, `CANCELLED`, `DELIVERED`.
- Show the **Cancel** button only when `status === "PENDING_RESTAURANT_CONFIRMATION"`. Otherwise the call returns
  `409 ORDER_NOT_CANCELLABLE`.
- Show the review form only when `status === "DELIVERED"`. A second review returns `409 REVIEW_ALREADY_EXISTS`.
- Other users' orders return `404`, not `403`.

### 5.6 Restaurant status labels for the UI

| `status` | Meaning for the UI |
| --- | --- |
| `PENDING_RESTAURANT_CONFIRMATION` | "Waiting for the restaurant to accept" |
| `CONFIRMED` | "Accepted" |
| `PREPARING` | "Being prepared" |
| `READY_FOR_PICKUP` | "Ready, waiting for a courier" |
| `PICKED_UP` | "Picked up" |
| `OUT_FOR_DELIVERY` | "On the way" |
| `DELIVERED` | "Delivered" |
| `REJECTED` | "Rejected by the restaurant" (show `cancelReason`) |
| `CANCELLED` | "Cancelled" (show `cancelReason`) |

## 6. Restaurant owner flow

```
GET   /owner/restaurants                                   → restaurants you own (any status)
GET   /owner/restaurants/{rid}
PATCH /owner/restaurants/{rid}      { name?, description?, cuisines?, addressLine?, city?, state?, postalCode?,
                                      opensAt?, closesAt?, minOrderMinor?, deliveryFeeMinor?, prepMinutes?,
                                      deliveryMinutes?, isAcceptingOrders? }
GET   /owner/restaurants/{rid}/menu                        → full menu, including inactive and unavailable items
POST  /owner/restaurants/{rid}/categories          { name, description?, displayOrder?, isActive? }
PATCH /owner/restaurants/{rid}/categories/{cid}    (any subset)
POST  /owner/restaurants/{rid}/menu-items          { categoryId, name, priceMinor, description?, imageUrl?, isVeg?, dietaryLabels?, isAvailable? }
PATCH /owner/restaurants/{rid}/menu-items/{iid}    (any subset; use isAvailable for "sold out")
DELETE /owner/restaurants/{rid}/menu-items/{iid}   → deactivates the item (kept for order history)
GET   /owner/restaurants/{rid}/orders?status=…     → incoming orders
POST  /owner/orders/{oid}/accept                   → CONFIRMED
POST  /owner/orders/{oid}/reject    { reason? }    → REJECTED
PATCH /owner/orders/{oid}/status    { status: "PREPARING" | "READY_FOR_PICKUP" }
```

- Owners cannot change status, tax, or ratings. Admins control those.
- Owners see only their own restaurants. Other IDs return `404`.
- Use `isAvailable: false` to mark items sold out. Use `DELETE` only to remove an item from the menu.
- Order actions must follow the status table in `API_CONTRACT.md` section 9. Any other move returns
  `409 INVALID_STATUS_TRANSITION`, so disable buttons that do not apply to the current status.

## 7. Courier flow

```
GET   /courier/deliveries?status=ASSIGNED|COMPLETED|CANCELLED&page=1&limit=20
GET   /courier/deliveries/{orderId}                    → order details (only if assigned to you)
PATCH /courier/deliveries/{orderId}/status   { status: "PICKED_UP" | "OUT_FOR_DELIVERY" | "DELIVERED" }
```

- Pickup is only allowed from `READY_FOR_PICKUP`. Use the order status to decide which button to show.
- `amountToCollectMinor` is the cash to collect. Show it prominently before delivery.
- `DELIVERED` marks the cash as collected (`paymentStatus: "COD_COLLECTED"`).

## 8. Admin flow

```
GET   /admin/users?role=…&status=ACTIVE|SUSPENDED&q=…       → users
PATCH /admin/users/{uid}          { role? | status? }        → SUSPENDED blocks sign-in and access immediately
GET   /admin/restaurants?status=PENDING_APPROVAL|ACTIVE|SUSPENDED
PATCH /admin/restaurants/{rid}    { status?, taxBps?, isAcceptingOrders? }   → approve restaurants here
GET   /admin/orders?status=…
POST  /admin/orders/{oid}/assign-courier   { courierId }      → only active couriers
POST  /admin/orders/{oid}/cancel           { reason }         → only while pending or CONFIRMED
GET   /admin/audit-logs                                       → every admin change, newest first
```

- Admins cannot suspend or demote themselves (`409 SELF_MODIFICATION_NOT_ALLOWED`).
- New restaurants start as `PENDING_APPROVAL` and are not visible to customers until an admin sets them to `ACTIVE`.
- `taxBps` is in basis points: `500` = 5%.
- To find couriers for assignment, use `GET /admin/users?role=COURIER&status=ACTIVE`.

## 9. Errors and what to show

Every error has `error.code`, `error.message`, `error.details`, and `error.requestId`.

- Show `error.message` for business errors (409, 403). These messages are written for end users.
- For `VALIDATION_ERROR`, map `details[].field` to the form field. The field name is the request body key.
- For `500` or unknown codes, show a generic message and include the `requestId` so support can find the log.
- `RATE_LIMITED` (429): show a "try again in a few minutes" message. Auth limits reset per 15 minutes.

## 10. Money formatting

All amounts are integers in paise. Format them only in the UI:

```ts
const formatINR = (minor: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(minor / 100);
// formatINR(23790) → "₹237.90"
```

Never do arithmetic on floats. The server's `pricing` object is authoritative. Show `taxMinor` and `deliveryFeeMinor`
separately, and never recompute the total in the browser.

## 11. Things that are not built yet

- **Online payments.** Only cash on delivery is accepted. Do not build a payment step.
- **Real-time updates.** Poll order details. There are no WebSockets or push notifications.
- **Coupons and discounts.** `discountMinor` is always 0.
- **Email and phone verification.** Accounts are active as soon as they register.
- **Geocoding.** `latitude` and `longitude` on addresses are optional and not filled in automatically.
- **Image uploads.** `logoUrl`, `coverUrl`, `imageUrl` are plain URLs. Host the images yourself or use a separate service.

If you need one of these, ask the backend owner first so the contract can change in an agreed way.

## 12. Checklist before you ship a screen

- [ ] Requests use `credentials: 'include'`, and the access token is in memory only.
- [ ] A 401 `TOKEN_INVALID` triggers one refresh and one retry, then sign-out.
- [ ] Checkout sends an `Idempotency-Key` and handles both 201 and 200 replays.
- [ ] Every money value is formatted from paise, never computed as a float.
- [ ] Cart item actions use the cart item ID, not the menu item ID.
- [ ] Buttons are shown only for actions that the current status and role allow.
- [ ] Error screens show the `message` and log the `requestId`.
