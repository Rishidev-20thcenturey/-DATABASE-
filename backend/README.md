# Food Delivery API (backend)

Node.js, TypeScript, Express 5, PostgreSQL, Zod. API base path `/api/v1`.

## Quick start

```bash
cp .env.example .env          # set JWT_ACCESS_SECRET (32+ chars), DATABASE_URL, DEV_SEED_PASSWORD
npm ci
npm run db:embedded           # optional local PostgreSQL on port 54330 (keep running)
npm run db:migrate
npm run db:seed               # sample accounts, restaurants, menus
npm run dev                   # http://localhost:4000
```

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Start the API with reload |
| `npm run build` / `npm start` | Compile to `dist/` and run it |
| `npm run typecheck` | TypeScript check, no output |
| `npm run lint` | ESLint |
| `npm test` | Vitest (starts its own embedded PostgreSQL on port 54329) |
| `npm run db:migrate` | Apply SQL migrations in `src/db/migrations` |
| `npm run db:seed` | Development seed (refuses to run in production) |
| `npm run db:embedded` | Local PostgreSQL for development |

## Documentation

- [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md): conventions, error codes, auth, order lifecycle
- [`docs/openapi.yaml`](docs/openapi.yaml): OpenAPI 3.1 spec (served at `/api/v1/openapi.yaml`, index at `/docs`)
- [`docs/FRONTEND_INTEGRATION.md`](docs/FRONTEND_INTEGRATION.md): flows, sample data, and browser setup for the frontend
- [`docs/INTEGRATION_STATUS.md`](docs/INTEGRATION_STATUS.md): what is built, what was tested, and what is open
