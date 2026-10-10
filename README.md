<p align="center">
  <img src="https://capsule-render.vercel.app/api?type=waving&amp;color=0:0B1020,45:123B65,100:F97316&amp;height=250&amp;section=header&amp;text=FOOD%20DELIVERY%20API&amp;fontSize=42&amp;fontColor=FFFFFF&amp;fontAlignY=37&amp;desc=One%20API%20%E2%80%A2%20Four%20Roles%20%E2%80%A2%20End-to-End%20Ordering&amp;descAlignY=59&amp;descSize=17&amp;animation=fadeIn" alt="Food Delivery API — animated project header" width="100%" />
</p>

<p align="center">
  <img src="https://readme-typing-svg.demolab.com/?font=JetBrains+Mono&amp;weight=500&amp;size=17&amp;pause=1200&amp;color=F97316&amp;center=true&amp;vCenter=true&amp;width=760&amp;height=45&amp;lines=Browse+restaurants+and+menus;Cart%2C+checkout+%26+order+lifecycle;Customer+%7C+Owner+%7C+Courier+%7C+Admin" alt="Project features shown in animated text" />
</p>

<p align="center">
  <a href="https://github.com/Rishidev-20thcenturey/-DATABASE-/actions/workflows/backend.yml"><img src="https://github.com/Rishidev-20thcenturey/-DATABASE-/actions/workflows/backend.yml/badge.svg?branch=main" alt="Backend CI" /></a>
  <img src="https://img.shields.io/badge/Node.js-20.19%2B-339933?logo=node.js&amp;logoColor=white" alt="Node.js 20.19+" />
  <img src="https://img.shields.io/badge/TypeScript-typed-3178C6?logo=typescript&amp;logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Express-5-111827?logo=express&amp;logoColor=white" alt="Express 5" />
  <img src="https://img.shields.io/badge/PostgreSQL-database-4169E1?logo=postgresql&amp;logoColor=white" alt="PostgreSQL" />
  <img src="https://img.shields.io/badge/OpenAPI-3.1-6BA539?logo=swagger&amp;logoColor=white" alt="OpenAPI 3.1" />
</p>

<p align="center">
  <a href="#-quick-start"><img src="https://img.shields.io/badge/Quick_Start-0B1020?style=for-the-badge&amp;logo=rocket&amp;logoColor=white" alt="Quick start" /></a>
  <a href="backend/docs/openapi.yaml"><img src="https://img.shields.io/badge/API_Spec-123B65?style=for-the-badge&amp;logo=swagger&amp;logoColor=white" alt="API specification" /></a>
  <a href="backend/docs/FRONTEND_INTEGRATION.md"><img src="https://img.shields.io/badge/Frontend_Guide-EA580C?style=for-the-badge&amp;logo=readthedocs&amp;logoColor=white" alt="Frontend integration guide" /></a>
</p>

<p align="center">
  <strong>A typed REST API for a food-delivery platform.</strong><br/>
  Restaurant discovery, secure accounts, cart and checkout, order management, courier workflows, and admin tools — built with Node.js, TypeScript, Express 5, and PostgreSQL.
</p>

> [!NOTE]
> This repository contains the **backend API and database setup**, not the frontend website. It is an MVP backend and is not yet a fully deployed production service.

---

## ✨ Project at a glance

<table>
  <tr>
    <td align="center" width="33%">
      <h2>51</h2>
      <strong>Documented API operations</strong><br/>
      <sub>OpenAPI 3.1 contract</sub>
    </td>
    <td align="center" width="33%">
      <h2>125</h2>
      <strong>Tests recorded as passing</strong><br/>
      <sub>9 test files in the verification report</sub>
    </td>
    <td align="center" width="33%">
      <h2>4</h2>
      <strong>Access roles</strong><br/>
      <sub>Customer · Owner · Courier · Admin</sub>
    </td>
  </tr>
</table>

## 🧭 Contents

- [Features](#-features)
- [Architecture](#-architecture)
- [Technology stack](#-technology-stack)
- [Quick start](#-quick-start)
- [Useful commands](#-useful-commands)
- [API overview](#-api-overview)
- [Frontend integration](#-frontend-integration)
- [Verification](#-verification)
- [Limitations and roadmap](#-limitations-and-roadmap)
- [Project structure](#-project-structure)

## 🚀 Features

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>🔐 Authentication &amp; access</h3>
      Customer registration and login, rotating refresh-token cookies, role-based permissions, input validation, and ownership checks.
    </td>
    <td width="50%" valign="top">
      <h3>🍽️ Restaurant catalogue</h3>
      Browse restaurants, menus, categories, availability, and customer reviews.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>🛒 Cart &amp; checkout</h3>
      Delivery addresses, a single-restaurant cart, server-side pricing, checkout preview, and idempotency protection.
    </td>
    <td width="50%" valign="top">
      <h3>📦 Order lifecycle</h3>
      Owner accept/reject and preparation, courier assignment, delivery status timeline, cancellation rules, and order history.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>🛠️ Admin operations</h3>
      Manage users and restaurants, assign couriers, cancel eligible orders, and inspect audit logs.
    </td>
    <td width="50%" valign="top">
      <h3>📘 Developer experience</h3>
      OpenAPI 3.1, consistent errors, pagination, request IDs, SQL migrations, demo seeds, and automated tests.
    </td>
  </tr>
</table>

## 🏗️ Architecture

\`\`\`mermaid
flowchart TD
    Client["Web / Mobile Frontend"] --> API["Express 5 API<br/>/api/v1"]
    API --> Middleware["Security · Auth · Validation<br/>Rate limits · Request IDs"]
    Middleware --> Modules["API Modules<br/>Auth · Catalogue · Cart · Checkout<br/>Orders · Owner · Courier · Admin"]
    Modules --> DB[("PostgreSQL")]
    API -.-> Spec["OpenAPI 3.1<br/>/api/v1/openapi.yaml"]
    Docs["Frontend Integration Guide"] -.-> Client
\`\`\`

The server is the source of truth for prices and order rules. Monetary amounts use integer **paise** (\`19900\` means ₹199.00), not floating-point currency values.

## 🧰 Technology stack

| Layer | Technology |
| --- | --- |
| Runtime | Node.js 20.19+ |
| Language | TypeScript |
| HTTP server | Express 5 |
| Database | PostgreSQL |
| Validation | Zod |
| Automated tests | Vitest + Supertest |
| API documentation | OpenAPI 3.1 |

## 🚀 Quick start

### Prerequisites

- Node.js **20.19 or newer**
- npm
- PostgreSQL, or the included local embedded-PostgreSQL helper

### 1. Configure environment variables

From the repository root:

\`\`\`bash
cd backend
cp .env.example .env
\`\`\`

Edit \`.env\` and set:

- \`DATABASE_URL\` — PostgreSQL connection string.
- \`JWT_ACCESS_SECRET\` — a private random secret of at least 32 characters.
- \`DEV_SEED_PASSWORD\` — development-only password of at least 8 characters for demo accounts.

**Never commit real secrets or your \`.env\` file.** The example configuration is for local development only.

### 2. Install dependencies

\`\`\`bash
npm ci
\`\`\`

### 3. Start the local database

Open a terminal in \`backend/\` and run this command, leaving it running:

\`\`\`bash
npm run db:embedded
\`\`\`

This starts the development database on port \`54330\`. Alternatively, configure \`DATABASE_URL\` to use a PostgreSQL instance you manage.

### 4. Run migrations and seed demo data

In another terminal, still in \`backend/\`:

\`\`\`bash
npm run db:migrate
npm run db:seed
\`\`\`

The development seed creates sample customer, restaurant-owner, courier, and admin accounts, plus demo restaurants and menu items. Their shared demo password is the value you set in \`DEV_SEED_PASSWORD\`. The seed is idempotent and refuses to run in production.

### 5. Start the API

\`\`\`bash
npm run dev
\`\`\`

| Resource | Local URL |
| --- | --- |
| API base | [http://localhost:4000/api/v1](http://localhost:4000/api/v1) |
| Health | [http://localhost:4000/api/v1/health](http://localhost:4000/api/v1/health) |
| Readiness | [http://localhost:4000/api/v1/ready](http://localhost:4000/api/v1/ready) |
| Documentation index | [http://localhost:4000/docs](http://localhost:4000/docs) |
| OpenAPI specification | [http://localhost:4000/api/v1/openapi.yaml](http://localhost:4000/api/v1/openapi.yaml) |

## ⌨️ Useful commands

Run these in \`backend/\`:

| Command | What it does |
| --- | --- |
| \`npm run dev\` | Start API with reload |
| \`npm run build\` | Compile TypeScript to \`dist/\` |
| \`npm start\` | Run compiled API |
| \`npm run typecheck\` | Check TypeScript types |
| \`npm run lint\` | Run ESLint |
| \`npm test\` | Run tests using a separate test database |
| \`npm run db:migrate\` | Apply SQL migrations |
| \`npm run db:seed\` | Populate development demo data |
| \`npm run db:embedded\` | Start local development PostgreSQL |

## 🔌 API overview

Every route is under \`/api/v1\` unless noted otherwise.

| Area | Representative routes |
| --- | --- |
| Authentication | \`POST /auth/register\`, \`POST /auth/login\`, \`POST /auth/refresh\`, \`POST /auth/logout\` |
| Restaurants &amp; menus | \`GET /restaurants\`, \`GET /restaurants/{id}/menu\`, \`GET /restaurants/{id}/reviews\` |
| Addresses &amp; cart | \`/me/addresses\`, \`/cart\`, \`/cart/items\` |
| Checkout &amp; orders | \`POST /checkout/preview\`, \`POST /checkout\`, \`GET /orders\`, \`GET /orders/{id}\` |
| Restaurant owner | \`/owner/restaurants\`, \`/owner/orders\` |
| Courier | \`/courier/deliveries\` |
| Administrator | \`/admin/users\`, \`/admin/restaurants\`, \`/admin/orders\`, \`/admin/audit-logs\` |

See the [OpenAPI specification](backend/docs/openapi.yaml) for complete request and response schemas.

## 🤝 Frontend integration

Use these documents as the source of truth when connecting a web or mobile frontend:

| Guide | What it covers |
| --- | --- |
| [Frontend integration guide](backend/docs/FRONTEND_INTEGRATION.md) | Customer, owner, courier, and admin flows, browser setup, and sample data |
| [API contract](backend/docs/API_CONTRACT.md) | Authentication, errors, pricing, pagination, and order lifecycle |
| [OpenAPI 3.1](backend/docs/openapi.yaml) | Endpoint and schema reference |
| [Integration status](backend/docs/INTEGRATION_STATUS.md) | Test coverage, verification record, and open issues |

**Browser note:** Requests that use the refresh-token cookie must include credentials (for Fetch, \`credentials: "include"\`), and the frontend origin must be permitted by \`CORS_ORIGINS\`. Keep the access token in memory rather than local storage.

## ✅ Verification

The integration report records **125 passing tests across 9 test files**, along with successful type-checking, linting, database migration, and build checks. The workflow badge at the top links to the latest GitHub Actions status; see the [full verification report](backend/docs/INTEGRATION_STATUS.md) for details and areas still awaiting automated coverage.

## 🛣️ Limitations and roadmap

This is an **MVP backend**, not a fully deployed production service.

- **Payments:** cash on delivery only; online payments are not implemented.
- **Live tracking:** order status must be refreshed or polled; there are no push updates or WebSockets.
- **Promotions:** coupons and discounts are not implemented.
- **Account verification:** email and phone verification are not implemented.
- **Images:** image fields accept URLs; file uploads are not included.
- **Production hardening:** managed PostgreSQL, backups, monitoring, load testing, and an independent security review are still needed.

## 📁 Project structure

\`\`\`text
.
├── .github/
│   └── workflows/
│       └── backend.yml
└── backend/
    ├── src/
    │   ├── modules/       # Auth, restaurants, cart, checkout, orders, owner, courier, admin
    │   ├── db/            # PostgreSQL connection, migrations, development seed
    │   ├── middleware/    # Auth, validation, rate limiting, request IDs
    │   └── server.ts
    ├── tests/             # API and database tests
    ├── docs/
    │   ├── openapi.yaml
    │   ├── API_CONTRACT.md
    │   ├── FRONTEND_INTEGRATION.md
    │   └── INTEGRATION_STATUS.md
    ├── .env.example
    └── package.json
\`\`\`

---

<p align="center">
  <sub>Built with TypeScript, Express, and PostgreSQL · API v1</sub><br/>
  <a href="backend/docs/INTEGRATION_STATUS.md">Status &amp; verification</a> ·
  <a href="backend/docs/FRONTEND_INTEGRATION.md">Frontend guide</a> ·
  <a href="backend/docs/openapi.yaml">API specification</a>
</p>
