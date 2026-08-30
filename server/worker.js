import { env } from './config/drive.js';
import { migratePostgres } from './database/postgresMigrations.js';
import { closePostgres } from './database/postgres.js';
import { closeRedis } from './services/redisService.js';
import { logger } from './services/logger.js';

if (!env.databaseUrl) throw new Error('DATABASE_URL is required in worker mode.');
await migratePostgres();
await import('./services/driveService.js');
await import('./services/readerService.js');
await import('./services/metadataService.js');
logger.info('worker.started', { application: 'Araru Server', workerId: process.pid });

async function shutdown(signal) {
  logger.info('worker.shutdown.started', { signal });
  await Promise.allSettled([closePostgres(), closeRedis()]);
  logger.info('worker.shutdown.completed');
  process.exit(0);
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
