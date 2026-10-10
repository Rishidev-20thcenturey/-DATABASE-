# -DATABASE- — Food Delivery API

A REST API backend for a food-delivery platform, built with **Node.js, TypeScript, Express 5, PostgreSQL, and Zod**. The backend provides the core workflows for customers, restaurant owners, couriers, and administrators.

> This repository contains the backend API and database setup — it is not the frontend website. The API base path is `/api/v1`.

## Features

- **Authentication and access control:** customer registration, login, rotating refresh-token cookies, role-based permissions, and ownership checks.
- **Restaurant catalogue:** restaurant discovery, menus, categories, availability, and reviews.
- **Customer ordering:** saved delivery addresses, single-restaurant cart, server-side price calculation, checkout preview, and idempotent checkout.
- **Order lifecycle:** restaurant acceptance and preparation, courier assignment and delivery status, cancellation rules, order history, and status timeline.
- **Administration:** user and restaurant management, courier assignment, and audit logs.
- **API contracts:** OpenAPI 3.1 specification, consistent error responses, pagination, validation, and request IDs.

## Technology

| Area | Stack |
| --- | --- |
| Runtime | Node.js 20.19+ |
| Language | TypeScript |
| HTTP API | Express 5 |
| Database | PostgreSQL |
| Validation | Zod |
| Tests | Vitest |
| API specification | OpenAPI 3.1 |

## Project structure

```text
backend/
├── src/
│   ├── modules/          # Auth, restaurants, cart, checkout, orders, owner, courier, admin
│   ├── db/               # PostgreSQL connection, SQL migration, development seed
│   ├── middleware/       # Authentication, validation, rate limiting, request IDs
│   └── server.ts         # API server entry point
├── tests/                # Automated API and database tests
├── docs/
│   ├── openapi.yaml
│   ├── API_CONTRACT.md
│   ├── FRONTEND_INTEGRATION.md
│   └── INTEGRATION_STATUS.md
├── .env.example
└── package.json
```

## Run locally

### Requirements

- Node.js **20.19 or newer**
- npm
- A PostgreSQL database. For local development, the repository includes an embedded PostgreSQL helper.

### 1. Configure the environment

From the repository root:

```bash
cd backend
cp .env.example .env
```

Edit `.env` and set at least:

- `DATABASE_URL` — connection string for your PostgreSQL database.
- `JWT_ACCESS_SECRET` — a private random secret of at least 32 characters.
- `DEV_SEED_PASSWORD` — a development-only password of at least 8 characters for the seeded demo accounts.

**Never commit your real `.env` file or production secrets.** The example values are for local development only.

### 2. Install dependencies

```bash
npm ci
```

### 3. Start the local database

For the included development database, start this command in a terminal and leave it running:

```bash
npm run db:embedded
```

It starts a local PostgreSQL instance on port `54330`. Alternatively, configure `DATABASE_URL` to point to your own PostgreSQL instance.

### 4. Apply migrations and create sample data

In another terminal, from the `backend/` directory:

```bash
npm run db:migrate
npm run db:seed
```

The development seed creates sample customer, restaurant-owner, courier, and admin accounts, plus demo restaurants and menu items. The password is the value you configured in `DEV_SEED_PASSWORD`. The seed is designed to be safe to run more than once and refuses to run in production.

### 5. Start the API

```bash
npm run dev
```

The API is available at:

- API base URL: `http://localhost:4000/api/v1`
- Health check: `http://localhost:4000/api/v1/health`
- Readiness check: `http://localhost:4000/api/v1/ready`
- API documentation index: `http://localhost:4000/docs`
- OpenAPI specification: `http://localhost:4000/api/v1/openapi.yaml`

## Useful commands

Run these from the `backend/` directory:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the API with reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled API |
| `npm run typecheck` | Check TypeScript types |
| `npm run lint` | Run ESLint |
| `npm test` | Run Vitest tests using a separate test database |
| `npm run db:migrate` | Apply database migrations |
| `npm run db:seed` | Add development demo data |
| `npm run db:embedded` | Start the local development PostgreSQL instance |

## API overview

All routes are under `/api/v1` unless stated otherwise.

| Area | Example routes |
| --- | --- |
| Authentication | `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout` |
| Restaurants and menus | `GET /restaurants`, `GET /restaurants/{id}/menu`, `GET /restaurants/{id}/reviews` |
| Addresses and cart | `/me/addresses`, `/cart`, `/cart/items` |
| Checkout and orders | `POST /checkout/preview`, `POST /checkout`, `GET /orders`, `GET /orders/{id}` |
| Restaurant owner | `/owner/restaurants`, `/owner/orders` |
| Courier | `/courier/deliveries` |
| Administrator | `/admin/users`, `/admin/restaurants`, `/admin/orders`, `/admin/audit-logs` |

Consult the OpenAPI file for exact request and response schemas. Amounts are sent as integer **paise**; for example, `19900` represents ₹199.00. The server calculates authoritative prices.

## Frontend integration

Start here when connecting a web or mobile frontend:

- [Frontend integration guide](backend/docs/FRONTEND_INTEGRATION.md)
- [API contract and error conventions](backend/docs/API_CONTRACT.md)
- [OpenAPI 3.1 specification](backend/docs/openapi.yaml)
- [Integration status and known limitations](backend/docs/INTEGRATION_STATUS.md)

For browser requests, the refresh-token cookie requires credentialed requests (for example, Fetch's `credentials: "include"`) and the frontend origin must be configured in `CORS_ORIGINS`. The access token should be kept in memory rather than local storage.

## Verification status

The project's integration report records **125 passing tests across 9 test files**, with successful type-checking, linting, migration, and build checks. The GitHub Actions workflow is configured to run backend checks. See [Integration Status](backend/docs/INTEGRATION_STATUS.md) for the verification details and uncovered areas.

## Current limitations

This is an **MVP backend**, not a fully deployed production service.

- Cash on delivery (COD) is the only implemented payment method; online payments are not included.
- Order updates are not real-time; the frontend must refresh or poll order status.
- Coupons/discounts, email/phone verification, and image uploads are not implemented.
- The included embedded database helper is for local development only. Production should use managed PostgreSQL with suitable backups and monitoring.
- A production security review, load testing, and deployment configuration are still needed.

