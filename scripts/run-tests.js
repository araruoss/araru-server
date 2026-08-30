import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL || 'postgresql://araru:araru@localhost:5432/araru_test';
const parsed = new URL(databaseUrl);
const databaseName = parsed.pathname.replace(/^\//, '');
if (!/^[a-zA-Z0-9_]+_test$/.test(databaseName)) {
  throw new Error('TEST_DATABASE_URL deve apontar para um banco cujo nome termine em _test.');
}

const adminUrl = new URL(databaseUrl);
adminUrl.pathname = '/postgres';
const admin = new Client({ connectionString: adminUrl.toString() });
await admin.connect();
const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [databaseName]);
if (!exists.rowCount) await admin.query(`CREATE DATABASE "${databaseName}"`);
await admin.end();

process.env.DATABASE_URL = databaseUrl;
process.env.REDIS_ENABLED = 'false';
const testDatabase = new Client({ connectionString: databaseUrl });
await testDatabase.connect();
await testDatabase.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
await testDatabase.end();

const { migratePostgres } = await import('../server/database/postgresMigrations.js');
const { closePostgres } = await import('../server/database/postgres.js');
await migratePostgres();
await closePostgres();

const backendRoot = fileURLToPath(new URL('../', import.meta.url));
const testFiles = readdirSync(new URL('../test/', import.meta.url)).filter((name) => name.endsWith('.test.js')).sort().map((name) => `test/${name}`);
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...testFiles], {
  cwd: backendRoot,
  env: {
    ...process.env, DATABASE_URL: databaseUrl, REDIS_ENABLED: 'false',
    DATABASE_IDLE_TIMEOUT_MS: '100', APP_ACCESS_SECRET: '',
    ADMIN_INITIAL_PASSWORD: '', NODE_ENV: 'test'
  },
  stdio: 'inherit',
  shell: false
});
process.exitCode = result.status ?? 1;
