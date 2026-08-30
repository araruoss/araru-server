import { query } from '../database/postgres.js';
import { getRedisClient } from './redisService.js';

export async function effectiveAccess(userId) { const cacheKey = `authz:user:${userId}`; const redis = getRedisClient(); if (redis) { const cached = await redis.get(cacheKey).catch(() => null); if (cached) return JSON.parse(cached); } const { rows } = await query(`SELECT u.id,u.role_id AS "roleId",r.name AS "roleName",r.is_system AS "isSystem",COALESCE((SELECT jsonb_agg(rp.permission) FROM role_permissions rp WHERE rp.role_id=r.id),'[]') permissions,COALESCE((SELECT jsonb_agg(jsonb_build_object('libraryId',rla.library_id,'accessLevel',rla.access_level)) FROM role_library_access rla WHERE rla.role_id=r.id),'[]') libraries FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=$1`, [userId]); const access = rows[0] || { permissions: [], libraries: [] }; if (access.roleName === 'Administrator') access.permissions = ['admin.access', ...new Set(['settings.read','settings.manage','users.read','users.create','users.update','users.delete','roles.read','roles.create','roles.update','roles.delete','libraries.read','libraries.manage','metadata.read','metadata.manage','jobs.read','jobs.execute','jobs.manage','backup.read','backup.create','backup.restore','security.read','security.manage','system.read'])]; if (redis) await redis.set(cacheKey, JSON.stringify(access), 'EX', 300).catch(() => {}); return access; }
export async function invalidateAuthorization(userId = null) { const redis = getRedisClient(); if (!redis) return; if (userId) await redis.del(`authz:user:${userId}`); else { /* individual invalidation is used by role mutations */ } }

const accessRank = { none: 0, read: 1, manage: 2 };

export function isAdministrator(access) {
  return access?.roleName === 'Administrator' || access?.permissions?.includes('admin.access');
}

export function accessibleLibraryIds(access, minimumLevel = 'read') {
  if (isAdministrator(access)) return null;
  const minimum = accessRank[minimumLevel] ?? accessRank.read;
  return [...new Set((access?.libraries || [])
    .filter((item) => (accessRank[item.accessLevel] ?? accessRank.none) >= minimum)
    .map((item) => String(item.libraryId))
    .filter(Boolean))];
}

export async function getAccessibleLibraries(userId, minimumLevel = 'read') {
  return accessibleLibraryIds(await effectiveAccess(userId), minimumLevel);
}

export async function canAccessLibrary(userId, libraryId, minimumLevel = 'read') {
  const ids = await getAccessibleLibraries(userId, minimumLevel);
  return ids === null || ids.includes(String(libraryId));
}

export async function canAccessSource(userId, source, minimumLevel = 'read') {
  return canAccessLibrary(userId, source, minimumLevel);
}

export async function buildLibraryScope(userId, { alias = 'lf', minimumLevel = 'read', offset = 0 } = {}) {
  const ids = await getAccessibleLibraries(userId, minimumLevel);
  if (ids === null) return { sql: 'TRUE', values: [] };
  const placeholder = `$${offset + 1}`;
  return {
    sql: `${alias}.status = 'active' AND COALESCE(${alias}.storage_provider, ${alias}.source) = ANY(${placeholder}::text[])`,
    values: [ids]
  };
}

export async function buildWorkScope(userId, { workAlias = 'w', offset = 0 } = {}) {
  const ids = await getAccessibleLibraries(userId);
  if (ids === null) return { sql: 'TRUE', values: [] };
  return {
    sql: `EXISTS (SELECT 1 FROM work_files scope_wf JOIN library_files scope_lf ON scope_lf.id = scope_wf.file_id WHERE scope_wf.work_id = ${workAlias}.id AND scope_lf.status = 'active' AND COALESCE(scope_lf.storage_provider, scope_lf.source) = ANY($${offset + 1}::text[]))`,
    values: [ids]
  };
}

export function filterAccessibleBooks(books, access) {
  const ids = accessibleLibraryIds(access);
  if (ids === null) return books;
  const allowed = new Set(ids);
  return books.filter((book) => allowed.has(String(book.source || book.fonte || book.libraryId || '')));
}
