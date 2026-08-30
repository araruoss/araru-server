import pg from 'pg';
import { env } from '../config/drive.js';
import { logger } from '../services/logger.js';

const { Pool } = pg;
let pool;
let initialized = false;
const advisoryClients = new Set();
const queryMetrics = { count: 0, totalDurationMs: 0, slow: 0, maxDurationMs: 0 };

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
  const started = process.hrtime.bigint();
  try { return await getPostgresPool().query(text, values); }
  finally {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    queryMetrics.count += 1; queryMetrics.totalDurationMs += durationMs; queryMetrics.maxDurationMs = Math.max(queryMetrics.maxDurationMs, durationMs);
    if (durationMs >= Number(process.env.SLOW_QUERY_MS || 250)) queryMetrics.slow += 1;
  }
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
  for (const client of advisoryClients) client.release();
  advisoryClients.clear();
  if (!pool) return;
  await pool.end();
  pool = undefined;
  initialized = false;
}

export async function acquireAdvisoryLock(key = 918273645) {
  const client = await getPostgresPool().connect();
  const result = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [key]);
  if (!result.rows[0]?.acquired) { client.release(); return null; }
  advisoryClients.add(client);
  return async () => { advisoryClients.delete(client); await client.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => {}); client.release(); };
}

export function isPostgresInitialized() {
  return initialized;
}

export function postgresPoolMetrics() {
  if (!pool) return { configured: Boolean(env.databaseUrl), created: false };
  return { configured: true, created: true, total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, max: env.databasePoolMax,
    queries: queryMetrics.count, averageQueryDurationMs: queryMetrics.count ? Number((queryMetrics.totalDurationMs / queryMetrics.count).toFixed(2)) : 0,
    slowQueries: queryMetrics.slow, maxQueryDurationMs: Number(queryMetrics.maxDurationMs.toFixed(2)) };
}

export function markPostgresInitialized() {
  initialized = true;
}
