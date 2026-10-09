import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

// Port and database are fixed in vitest.config.ts (DATABASE_URL) so every test worker connects to this instance.
const TEST_PORT = 54329;

export default async function setup() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'food-test-pg-'));
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port: TEST_PORT,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('food_test');

  // Apply migrations once, using the same runner as production.
  process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${TEST_PORT}/food_test`;
  const { migrate } = await import('../src/db/migrate.js');
  const { closePool } = await import('../src/db/pool.js');
  await migrate();
  await closePool();

  return async () => {
    await pg.stop();
  };
}
