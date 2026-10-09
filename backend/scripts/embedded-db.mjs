// Starts a local PostgreSQL server using the embedded-postgres package (no Docker or system install needed).
// Usage: node scripts/embedded-db.mjs [port] [dataDir]
// Keep this process running while you develop; it stops when you press Ctrl+C.
import EmbeddedPostgres from 'embedded-postgres';

const port = Number(process.argv[2] ?? 54329);
const databaseDir = process.argv[3] ?? '.local-pgdata';

const pg = new EmbeddedPostgres({
  databaseDir,
  user: 'postgres',
  password: 'postgres',
  port,
  persistent: true,
  onLog: () => {},
  onError: (message) => console.error(message),
});

const initialised = await import('node:fs').then((fs) => fs.existsSync(`${databaseDir}/PG_VERSION`));
if (!initialised) await pg.initialise();
await pg.start();
try {
  await pg.createDatabase('food_delivery');
} catch {
  // database already exists
}
console.log(`PostgreSQL is running on port ${port}.`);
console.log(`DATABASE_URL=postgres://postgres:postgres@127.0.0.1:${port}/food_delivery`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
