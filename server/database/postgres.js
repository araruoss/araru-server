import pg from 'pg';
import { env } from '../config/drive.js';
import { logger } from '../services/logger.js';

const { Pool } = pg;
let pool;
let initialized = false;

function requireUrl() {
  if (!env.databaseUrl) throw new Error('DATABASE_URL não configurada.');
}

export function getPostgresPool() {
  requireUrl();
  if (!pool) {
    pool = new Pool({
      connectionString: env.databaseUrl,
      max: env.databasePoolMax,
      idleTimeoutMillis: env.databaseIdleTimeoutMs,
      connectionTimeoutMillis: env.databaseConnectionTimeoutMs,
      ssl: env.databaseSsl ? { rejectUnauthorized: false } : undefined
    });
    pool.on('error', (error) => logger.error('postgres.idle_connection_failed', { error }));
  }
  return pool;
}

export async function query(text, values = []) {
  return getPostgresPool().query(text, values);
}

export async function withTransaction(callback) {
  const client = await getPostgresPool().connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function checkPostgres() {
  if (!env.databaseUrl) return { configured: false, healthy: false };
  try {
    await query('SELECT 1');
    return { configured: true, healthy: true };
  } catch (error) {
    return { configured: true, healthy: false, error: error.message };
  }
}

export async function closePostgres() {
  if (!pool) return;
  await pool.end();
  pool = undefined;
  initialized = false;
}

export function isPostgresInitialized() {
  return initialized;
}

export function markPostgresInitialized() {
  initialized = true;
}
