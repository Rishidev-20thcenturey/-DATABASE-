import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    // Test files share one PostgreSQL database and reset it between files, so run them sequentially.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:54329/food_test',
      JWT_ACCESS_SECRET: 'test-only-access-secret-that-is-long-enough-0123456789',
      CORS_ORIGINS: 'http://localhost:5173',
      COOKIE_SECURE: 'false',
      COOKIE_SAMESITE: 'lax',
      ENABLE_COD: 'true',
      DEV_SEED_PASSWORD: 'dev-password-123',
      // Generous limits so the functional tests are not throttled; rate limiting has its own test.
      AUTH_RATE_LIMIT_MAX: '10000',
      API_RATE_LIMIT_MAX: '100000',
    },
  },
});
