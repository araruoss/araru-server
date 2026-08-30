import { env } from './config/drive.js';
import { createApp } from './app.js';
import { iniciarObservadorBiblioteca } from './services/libraryWatcher.js';
import { iniciarJobsManutencao } from './services/maintenanceJobs.js';
import { logger } from './services/logger.js';
import { migratePostgres } from './database/postgresMigrations.js';
import { closePostgres } from './database/postgres.js';
import { closeRedis } from './services/redisService.js';
import { encerrarObservadorBiblioteca } from './services/libraryWatcher.js';
import { encerrarJobsManutencao } from './services/maintenanceJobs.js';
import { enfileirarAtualizacaoCatalogo } from './services/driveService.js';
import { startJobScheduler, stopJobScheduler } from './services/jobScheduler.js';

if (env.databaseUrl) await migratePostgres();
const app = await createApp();
await iniciarObservadorBiblioteca();
iniciarJobsManutencao();
startJobScheduler();
if (!env.useMockData) {
  void enfileirarAtualizacaoCatalogo({ priority: 'normal', reason: 'startup' }).catch((error) => {
    logger.warn('catalog.startup_scan_failed', { error });
  });
}

const server = app.listen(env.port, () => {
  logger.info('server.started', { application: 'Araru Server', port: env.port, url: `http://localhost:${env.port}` });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('server.shutdown.started', { signal });
  encerrarJobsManutencao();
  stopJobScheduler();
  await encerrarObservadorBiblioteca();
  await new Promise((resolve) => server.close(resolve));
  await Promise.allSettled([closePostgres(), closeRedis()]);
  logger.info('server.shutdown.completed');
}
process.once('SIGTERM', () => shutdown('SIGTERM').then(() => process.exit(0)));
process.once('SIGINT', () => shutdown('SIGINT').then(() => process.exit(0)));
