import { query } from '../database/postgres.js';
import { checkPostgres } from '../database/postgres.js';
import { checkRedis } from './redisService.js';
import { obterMetricasRuntime } from './runtimeMetrics.js';
import { obterResumoIndice } from './libraryIndexService.js';
import { estadoJobsManutencao } from './maintenanceJobs.js';
import { estadoFilaEnriquecimento } from './metadataService.js';

export async function recordAdminAudit(actorUserId, action, targetType = null, targetId = null, detail = {}) {
  const safeDetail = Object.fromEntries(Object.entries(detail || {}).filter(([key]) => !/password|secret|token|hash/i.test(key)));
  await query('INSERT INTO admin_audit_log(actor_user_id,action,target_type,target_id,detail) VALUES($1,$2,$3,$4,$5::jsonb)', [actorUserId || null, action, targetType, targetId ? String(targetId) : null, JSON.stringify(safeDetail)]);
}

export async function adminOverview() {
  const [users, profiles, database, redis, catalog, jobs] = await Promise.all([
    query('SELECT COUNT(*)::int total FROM users'),
    query('SELECT COUNT(*)::int total FROM profiles WHERE active=TRUE'),
    checkPostgres(), checkRedis(), obterResumoIndice(),
    query("SELECT status,COUNT(*)::int total FROM background_jobs GROUP BY status")
  ]);
  const catalogRows = Array.isArray(catalog) ? catalog : [];
  const activeCatalog = catalogRows.filter((row) => row.status === 'active');
  const catalogSummary = {
    total: activeCatalog.reduce((sum, row) => sum + Number(row.total || 0), 0),
    sources: Object.fromEntries(activeCatalog.map((row) => [row.source, Number(row.total || 0)])),
    rows: catalogRows
  };
  return {
    server: { status: 'ok', version: process.env.npm_package_version || '2.0.0', environment: process.env.NODE_ENV || 'development', ...obterMetricasRuntime() },
    users: Number(users.rows[0]?.total || 0), profiles: Number(profiles.rows[0]?.total || 0),
    libraries: new Set(activeCatalog.map((row) => row.source)).size, catalog: catalogSummary,
    database, redis,
    jobs: Object.fromEntries(jobs.rows.map((row) => [row.status, Number(row.total)])),
    maintenance: estadoJobsManutencao(), metadataQueue: estadoFilaEnriquecimento()
  };
}

export async function listAdminAudit(limit = 50) {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
  const { rows } = await query(`SELECT a.id,a.action,a.target_type AS "targetType",a.target_id AS "targetId",a.detail,a.created_at AS "createdAt",u.username AS actor FROM admin_audit_log a LEFT JOIN users u ON u.id=a.actor_user_id ORDER BY a.created_at DESC LIMIT $1`, [safeLimit]);
  return rows;
}
