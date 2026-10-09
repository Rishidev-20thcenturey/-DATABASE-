import { loadEnv } from './config/env.js';
import { closePool } from './db/pool.js';
import { createApp } from './app.js';

const env = loadEnv();
const app = createApp(env);

const server = app.listen(env.PORT, '0.0.0.0', () => {
  console.log(`Food delivery API listening on port ${env.PORT} (${env.NODE_ENV})`);
});

const shutdown = (signal: string) => {
  console.log(`${signal} received, shutting down.`);
  server.close(() => {
    closePool().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
