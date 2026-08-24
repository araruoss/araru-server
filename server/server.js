import { env } from './config/drive.js';
import { createApp } from './app.js';
import { iniciarObservadorBiblioteca } from './services/libraryWatcher.js';
import { iniciarJobsManutencao } from './services/maintenanceJobs.js';
import { logger } from './services/logger.js';
import { migratePostgres } from './database/postgresMigrations.js';

if (env.databaseUrl) await migratePostgres();
const app = await createApp();
iniciarObservadorBiblioteca();
iniciarJobsManutencao();

app.listen(env.port, () => {
  logger.info('server.started', { application: 'Araru Server', port: env.port, url: `http://localhost:${env.port}` });
});
