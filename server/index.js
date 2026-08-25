import config from './config.js';
import { createApp } from './app.js';
import { migrate } from './db/migrate.js';
import { closeDb } from './db/index.js';

migrate({ quiet: true });

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`Dynamic Test Generator API listening on http://localhost:${config.port} (${config.env})`);
});

const shutdown = (signal) => {
  console.log(`\n${signal} received — shutting down.`);
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  // Don't hang forever on a stuck connection.
  setTimeout(() => process.exit(1), 10000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export default server;
