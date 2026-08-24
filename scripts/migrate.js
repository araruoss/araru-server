import { closePostgres } from '../server/database/postgres.js';
import { migratePostgres } from '../server/database/postgresMigrations.js';
try { await migratePostgres(); console.log('PostgreSQL migrations applied.'); } finally { await closePostgres(); }
