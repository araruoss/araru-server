import express, { Router } from 'express';
import { statfs } from 'node:fs/promises';
import { query } from '../database/postgres.js';
import { postgresPoolMetrics } from '../database/postgres.js';
import { checkRedis } from '../services/redisService.js';
import { env } from '../config/drive.js';
import { storageHealth, getStorageProviders } from '../storage/index.js';
import { obterMetricasRuntime } from '../services/runtimeMetrics.js';
import { listarObras, obterObra } from '../services/workService.js';
import { listarPerfis, criarPerfil, atualizarPerfil, removerPerfil } from '../services/profileService.js';
import { obterEstadoLeitura, salvarEstadoLeitura } from '../services/readingStateService.js';
import { listSeries, getSeries, syncSeries } from '../services/productService.js';
import { getGeneralSettings, saveGeneralSettings } from '../services/setupService.js';
import { adminOverview, listAdminAudit } from '../services/adminService.js';
import { listUsers, createUser, getUserById } from '../services/userAuthService.js';
import { requireAdmin, requirePermission } from '../middleware/security.js';
import { pagination, numberParam, enumParam, paged } from '../http/validation.js';
import { DomainError, errors } from '../http/apiErrors.js';
import { API_VERSION } from '../config/api.js';
import { listLibrariesAdmin, getLibraryAdmin, createLibraryAdmin, updateLibraryAdmin, deleteLibraryAdmin } from '../services/libraryAdminService.js';
import { listProviderSettings, saveProviderSettings, deleteProviderSettings } from '../services/storageAdminService.js';
import { enfileirarAtualizacaoCatalogo } from '../services/driveService.js';
import { baixarBackup, importarBackup, validarBackup } from '../controllers/backupController.js';
import { listarJobs, listarMetricas, cancelarJob, repetirJob, listarCache, limparCaches, listarIntegridade, verificarIntegridade, listarCircuitos, statusCacheCapas, gerarCapasAusentes, reconstruirCacheCapas, repetirCapasComErro } from '../controllers/operationsController.js';
import { getMetadataExport, postMetadataImport } from '../controllers/productController.js';
import { jobQueueMetrics } from '../services/jobQueueService.js';
import { logger } from '../services/logger.js';
import { servirConteudoLivro, servirCapaLivro, listarPaginasLeitura, obterManifestoLeituraController, servirPaginaLeitura, servirRecursoMobi, gerarUrlConteudoLivro, listarMetadadosLivro, atualizarMetadadosLivro, enriquecerMetadadosLivro, listarRevisoesMetadados } from '../controllers/livrosController.js';
import { getProfiles, postProfile, putProfile, deleteProfile, selectProfile } from '../controllers/profileController.js';
import { finalizarLogin, iniciarLogin, sairGoogleDrive } from '../controllers/authController.js';
import { completeR2Upload, createR2UploadUrl } from '../controllers/storageController.js';
import { getSecurityConfig, saveSecurityConfig, securityOverview } from '../services/securityConfigService.js';
import { getSettings, resetSettings, setSettings, settingsSchema } from '../services/settingsService.js';
import { listRoles, getRole, saveRole, deleteRole } from '../services/roleService.js';
import { permissionGroups } from '../services/permissionRegistry.js';
import { buildLibraryScope, buildWorkScope, effectiveAccess, invalidateAuthorization } from '../services/authorizationService.js';
import { listProviders, listConnections, getConnection, saveConnection, testConnection, deleteConnection, listSources, saveSource, deleteSource } from '../services/connectionService.js';
import { jobCenterOverview, listJobDefinitions, listJobSchedules, saveJobSchedule, deleteJobSchedule, runJob, jobExecution } from '../services/jobCenterService.js';

const router = Router();
const profileId = (req) => req.profileId || req.sessionContext?.activeProfile?.id || 'default';
async function requireAccessibleWork(req, res) {
  const work = await obterObra(req.params.id, { userId: req.user.id });
  if (!work) {
    res.status(404).json({ message: 'Obra nao encontrada.' });
    return null;
  }
  return work;
}
const parseJson = (value, fallback = []) => {
  if (Array.isArray(value) || (value && typeof value === 'object')) return value;
  try { return JSON.parse(value); } catch { return fallback; }
};
const capabilityReaders = { pdf: true, epub: true, mobi: true, cbz: true, cbr: true };

router.get('/auth/drive/login', iniciarLogin);
router.get('/auth/callback', finalizarLogin);
router.post('/auth/drive/logout', sairGoogleDrive);
router.post('/admin/storage/r2/upload-url', requireAdmin, createR2UploadUrl);
router.post('/admin/storage/r2/complete', requireAdmin, completeR2Upload);

router.get('/system/info', (_req, res) => res.json({
  server: { name: 'Araru', version: process.env.ARARU_SERVER_VERSION || '0.1.0', uptimeSeconds: Math.floor(process.uptime()) },
  api: { version: API_VERSION },
  capabilities: {
    readers: capabilityReaders,
    storage: { local: true, googleDrive: Boolean(env.enableGoogleDrive), r2: Boolean(env.r2Configured) },
    features: { profiles: true, offline: true, annotations: false, favorites: true, history: true, range: true }
  }
}));

router.get('/client-config', (_req, res) => res.json({
  serverName: 'Araru', defaultLanguage: 'en', branding: { name: 'Araru' },
  supportedFeatures: { profiles: true, offline: true, favorites: true, history: true, range: true },
  limits: { pageSize: 100, readerMaxInMemoryMb: env.readerMaxInMemoryBytes / 1024 / 1024 }
}));

router.get('/session', async (req, res, next) => {
  try {
    if (!req.sessionContext) return next(new DomainError('Authentication required.', { code: 'UNAUTHORIZED', statusCode: 401 }));
    const context = req.sessionContext;
    return res.json({ user: { id: context.user.id, username: context.user.username, displayName: context.user.displayName, role: context.user.role, roleId: context.user.roleId, roleName: context.user.roleName, active: context.user.active }, profile: context.activeProfile, permissions: (await effectiveAccess(context.user.id)).permissions });
  } catch (error) { return next(error); }
});
router.get('/auth/me', async (req, res, next) => { if (!req.sessionContext) return next(new DomainError('Authentication required.', { code: 'UNAUTHORIZED', statusCode: 401 })); return res.json({ user: req.sessionContext.user, profile: req.sessionContext.activeProfile, permissions: (await effectiveAccess(req.sessionContext.user.id)).permissions }); });

router.get('/libraries', async (_req, res, next) => {
  try {
    const scope = await buildLibraryScope(_req.user.id, { alias: 'lf' });
    const { rows } = await query(`SELECT COALESCE(lf.storage_provider, lf.source) AS id, COALESCE(lf.storage_provider, lf.source) AS type, COUNT(*)::int AS "fileCount", COUNT(*) FILTER (WHERE lf.status='active')::int AS "activeFileCount" FROM library_files lf WHERE ${scope.sql} GROUP BY 1 ORDER BY 1`, scope.values);
    return res.json({ items: rows, pagination: { page: 1, pageSize: rows.length || 1, total: rows.length, pages: rows.length ? 1 : 0 } });
  } catch (error) { return next(error); }
});
router.get('/libraries/:id', async (req, res, next) => {
  try { const scope = await buildLibraryScope(req.user.id, { alias: 'lf', offset: 1 }); const { rows } = await query(`SELECT COALESCE(lf.storage_provider, lf.source) AS id, COALESCE(lf.storage_provider, lf.source) AS type, COUNT(*)::int AS "fileCount", COUNT(*) FILTER (WHERE lf.status='active')::int AS "activeFileCount" FROM library_files lf WHERE COALESCE(lf.storage_provider, lf.source)=$1 AND ${scope.sql} GROUP BY 1`, [req.params.id, ...scope.values]); return rows[0] ? res.json({ data: rows[0] }) : next(errors.notFound('Library not found.')); } catch (error) { return next(error); }
});

router.get('/works', async (req, res, next) => {
  try {
    const { page, pageSize } = pagination(req.query);
    const search = String(req.query.search || req.query.q || '').trim();
    const offset = (page - 1) * pageSize;
    const values = [];
    const filters = [];
    const profile = profileId(req);
    const scope = await buildWorkScope(req.user.id, { workAlias: 'w', offset: values.length });
    values.push(...scope.values);
    filters.push(scope.sql);
    if (search) { values.push(`%${search}%`); filters.push(`(w.canonical_title ILIKE $${values.length} OR w.authors::text ILIKE $${values.length} OR w.description ILIKE $${values.length})`); }
    if (req.query.libraryId) { values.push(String(req.query.libraryId)); filters.push(`EXISTS (SELECT 1 FROM work_files wf0 JOIN library_files lf0 ON lf0.id=wf0.file_id WHERE wf0.work_id=w.id AND COALESCE(lf0.storage_provider,lf0.source)=$${values.length})`); }
    if (req.query.author) { values.push(`%${String(req.query.author)}%`); filters.push(`w.authors::text ILIKE $${values.length}`); }
    if (req.query.category) { values.push(`%${String(req.query.category)}%`); filters.push(`EXISTS (SELECT 1 FROM work_files wf0 JOIN library_files lf0 ON lf0.id=wf0.file_id WHERE wf0.work_id=w.id AND (lf0.category_path::text ILIKE $${values.length} OR lf0.payload::text ILIKE $${values.length}))`); }
    if (req.query.format) { values.push(String(req.query.format).toLowerCase()); filters.push(`EXISTS (SELECT 1 FROM work_files wf0 WHERE wf0.work_id=w.id AND LOWER(wf0.format)=$${values.length})`); }
    if (req.query.series) { values.push(String(req.query.series)); filters.push(`EXISTS (SELECT 1 FROM work_series ws WHERE ws.work_id=w.id AND ws.series_id=$${values.length})`); }
    if (req.query.favorite !== undefined) { values.push(profile); const favoriteFilter = `EXISTS (SELECT 1 FROM reading_state rs WHERE rs.profile_id=$${values.length} AND rs.favorites @> jsonb_build_array(w.id))`; filters.push(String(req.query.favorite) === 'true' ? favoriteFilter : `NOT (${favoriteFilter})`); }
    if (req.query.completed !== undefined) { values.push(profile); const p = values.length; values.push(String(req.query.completed) === 'true'); const b = values.length; filters.push(`COALESCE(((SELECT rs.progress->(w.id)->>'completed' FROM reading_state rs WHERE rs.profile_id=$${p})::boolean),false)=$${b}`); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const count = await query(`SELECT COUNT(*)::int AS total FROM works w ${where}`, values);
    const sortFields = { title: 'LOWER(w.canonical_title)', createdAt: 'w.created_at', updatedAt: 'w.updated_at', author: 'LOWER(w.authors::text)' };
    const sort = sortFields[String(req.query.sort || 'title')] || sortFields.title;
    const order = String(req.query.order || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    values.push(pageSize, offset);
    const { rows } = await query(`SELECT w.*, COUNT(wf.file_id)::int AS "fileCount", MAX(wf.format) FILTER (WHERE wf.is_primary) AS format, MAX(wf.source) FILTER (WHERE wf.is_primary) AS source FROM works w LEFT JOIN work_files wf ON wf.work_id=w.id ${where} GROUP BY w.id ORDER BY ${sort} ${order} LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    return res.json(paged(rows.map((row) => ({ ...row, authors: parseJson(row.authors) })), page, pageSize, count.rows[0].total));
  } catch (error) { return next(error); }
});
router.get('/works/recent', async (req, res, next) => { try { const limit = numberParam(req.query.limit, { name: 'limit', defaultValue: 20, min: 1, max: 100 }); const scope = await buildWorkScope(req.user.id, { workAlias: 'w', offset: 1 }); const { rows } = await query(`SELECT w.* FROM works w WHERE ${scope.sql} ORDER BY w.created_at DESC LIMIT $1`, [limit, ...scope.values]); return res.json({ items: rows }); } catch (error) { return next(error); } });
router.get('/works/:id', async (req, res, next) => { try { const data = await obterObra(req.params.id, { userId: req.user.id }); return data ? res.json({ data: { ...data, reading: await obterEstadoLeitura(profileId(req)) } }) : next(errors.notFound('Work not found.')); } catch (error) { return next(error); } });
router.get('/works/:id/content', servirConteudoLivro);
router.head('/works/:id/content', servirConteudoLivro);
router.get('/works/:id/content/url', gerarUrlConteudoLivro);
router.get('/works/:id/cover', servirCapaLivro);
router.get('/works/:id/pages', listarPaginasLeitura);
router.get('/works/:id/manifest', obterManifestoLeituraController);
router.get('/works/:id/pages/:page', servirPaginaLeitura);
router.get('/works/:id/resources/mobi/:recindex', servirRecursoMobi);
router.get('/works/:id/metadata', listarMetadadosLivro);
router.post('/admin/works/:id/metadata', requireAdmin, atualizarMetadadosLivro);
router.post('/admin/works/:id/enrich', requireAdmin, enriquecerMetadadosLivro);
router.get('/admin/metadata/reviews', requireAdmin, listarRevisoesMetadados);

router.get('/series', async (req, res, next) => { try { await syncSeries(); const all = await listSeries(); const visible = []; for (const series of all) { if ((await buildWorkScope(req.user.id, { workAlias: 'w', offset: 1 })).sql === 'TRUE') { visible.push(series); continue; } const scope = await buildWorkScope(req.user.id, { workAlias: 'w', offset: 2 }); const result = await query(`SELECT 1 FROM work_series ws JOIN works w ON w.id=ws.work_id WHERE ws.series_id=$1 AND ${scope.sql} LIMIT 1`, [series.id, ...scope.values]); if (result.rows[0]) visible.push(series); } const { page, pageSize } = pagination(req.query); return res.json(paged(visible.slice((page - 1) * pageSize, page * pageSize), page, pageSize, visible.length)); } catch (error) { return next(error); } });
router.get('/series/:id', async (req, res, next) => { try { const data = await getSeries(req.params.id); if (!data) return next(errors.notFound('Series not found.')); const scope = await buildWorkScope(req.user.id, { workAlias: 'w', offset: 1 }); const result = await query(`SELECT 1 FROM work_series ws JOIN works w ON w.id=ws.work_id WHERE ws.series_id=$1 AND ${scope.sql} LIMIT 1`, [req.params.id, ...scope.values]); return result.rows[0] ? res.json({ data }) : next(errors.notFound('Series not found.')); } catch (error) { return next(error); } });
router.get('/series/:id/works', async (req, res, next) => { try { const data = await getSeries(req.params.id); if (!data) return next(errors.notFound('Series not found.')); const { page, pageSize } = pagination(req.query); const ids = (data.volumes || []).map((item) => item.id).filter(Boolean); const visible = []; for (const id of ids) { const work = await obterObra(id, { userId: req.user.id }); if (work) visible.push(work); } return res.json(paged(visible.slice((page - 1) * pageSize, page * pageSize), page, pageSize, visible.length)); } catch (error) { return next(error); } });

router.get('/authors', async (req, res, next) => { try { const scope = await buildWorkScope(req.user.id, { workAlias: 'w', offset: 0 }); const { rows } = await query(`SELECT DISTINCT jsonb_array_elements_text(w.authors) AS name FROM works w WHERE ${scope.sql} ORDER BY 1`, scope.values); const { page, pageSize } = pagination(req.query); const items = rows.map((row) => ({ id: Buffer.from(row.name).toString('base64url'), name: row.name })); return res.json(paged(items.slice((page - 1) * pageSize, page * pageSize), page, pageSize, items.length)); } catch (error) { return next(error); } });
router.get('/authors/:id/works', async (req, res, next) => { try { const name = Buffer.from(req.params.id, 'base64url').toString(); const { page, pageSize } = pagination(req.query); const scope = await buildWorkScope(req.user.id, { workAlias: 'w', offset: 1 }); const count = await query(`SELECT COUNT(*)::int AS total FROM works w WHERE w.authors @> $1::jsonb AND ${scope.sql}`, [JSON.stringify([name]), ...scope.values]); const { rows } = await query(`SELECT w.* FROM works w WHERE w.authors @> $1::jsonb AND ${scope.sql} ORDER BY LOWER(w.canonical_title) LIMIT $${scope.values.length + 2} OFFSET $${scope.values.length + 3}`, [JSON.stringify([name]), ...scope.values, pageSize, (page - 1) * pageSize]); return res.json(paged(rows, page, pageSize, count.rows[0].total)); } catch (error) { return next(error); } });
router.get('/authors/:id', async (req, res, next) => { try { const name = Buffer.from(req.params.id, 'base64url').toString(); const scope = await buildWorkScope(req.user.id, { workAlias: 'w', offset: 1 }); const result = await query(`SELECT COUNT(*)::int AS total FROM works w WHERE w.authors @> $1::jsonb AND ${scope.sql}`, [JSON.stringify([name]), ...scope.values]); return result.rows[0].total ? res.json({ data: { id: req.params.id, name, workCount: result.rows[0].total } }) : next(errors.notFound('Author not found.')); } catch (error) { return next(error); } });

router.get('/search', async (req, res, next) => {
  try {
    const term = String(req.query.q || req.query.search || '').trim();
    if (!term) throw errors.validation('The q parameter is required.');
    const { page, pageSize } = pagination(req.query);
    const offset = (page - 1) * pageSize;
    const scope = await buildWorkScope(req.user.id, { workAlias: 'w', offset: 2 });
    const count = await query(`WITH search_query AS (SELECT plainto_tsquery('simple', unaccent($1)) AS query)
      SELECT COUNT(DISTINCT w.id)::int AS total
      FROM works w CROSS JOIN search_query sq
      LEFT JOIN work_files wf ON wf.work_id=w.id
      LEFT JOIN library_files lf ON lf.id=wf.file_id
      WHERE (${scope.sql}) AND (w.search_vector @@ sq.query OR lf.search_vector @@ sq.query OR w.canonical_title ILIKE $2)`, [term, `%${term}%`, ...scope.values]);
    const { rows } = await query(`WITH search_query AS (SELECT plainto_tsquery('simple', unaccent($1)) AS query), matched AS (
      SELECT w.*, GREATEST(COALESCE(ts_rank_cd(w.search_vector, sq.query), 0), COALESCE(MAX(ts_rank_cd(lf.search_vector, sq.query)), 0)) AS "searchRank"
      FROM works w CROSS JOIN search_query sq
      LEFT JOIN work_files wf ON wf.work_id=w.id
      LEFT JOIN library_files lf ON lf.id=wf.file_id
      WHERE (${scope.sql}) AND (w.search_vector @@ sq.query OR lf.search_vector @@ sq.query OR w.canonical_title ILIKE $2)
      GROUP BY w.id, sq.query
    ) SELECT * FROM matched ORDER BY "searchRank" DESC, LOWER(canonical_title) LIMIT $${scope.values.length + 3} OFFSET $${scope.values.length + 4}`, [term, `%${term}%`, ...scope.values, pageSize, offset]);
    const { rows: series } = await query(`SELECT DISTINCT s.id, s.name FROM series s LEFT JOIN work_series ws ON ws.series_id=s.id LEFT JOIN works w ON w.id=ws.work_id CROSS JOIN (SELECT plainto_tsquery('simple', unaccent($1)) AS query) sq WHERE to_tsvector('simple', unaccent(s.name)) @@ sq.query OR s.name ILIKE $2 ORDER BY s.name LIMIT 50`, [term, `%${term}%`]);
    const { rows: authors } = await query(`SELECT DISTINCT c.id, c.name FROM creators c JOIN work_creators wc ON wc.creator_id=c.id JOIN works w ON w.id=wc.work_id WHERE to_tsvector('simple', unaccent(c.name)) @@ plainto_tsquery('simple', unaccent($1)) OR c.name ILIKE $2 ORDER BY c.name LIMIT 50`, [term, `%${term}%`]);
    return res.json({ works: paged(rows.map((row) => ({ ...row, authors: parseJson(row.authors), tags: parseJson(row.tags) })), page, pageSize, count.rows[0].total).items, series, authors });
  } catch (error) { return next(error); }
});

router.get('/reading/continue', async (req, res, next) => { try { const state = await obterEstadoLeitura(profileId(req)); const ids = Object.entries(state.progress || {}).filter(([, value]) => Number(value?.progress ?? value ?? 0) > 0).sort((a, b) => Number(b[1]?.lastReadAt || 0) - Number(a[1]?.lastReadAt || 0)).map(([id]) => id); const items = []; for (const id of ids.slice(0, 100)) { const work = await obterObra(id, { userId: req.user.id }); if (work) items.push({ ...work, reading: state.progress[id] }); } return res.json({ items }); } catch (error) { return next(error); } });
router.get('/history', async (req, res, next) => { try { const state = await obterEstadoLeitura(profileId(req)); const { page, pageSize } = pagination(req.query); const items = (state.history || []).slice((page - 1) * pageSize, page * pageSize); return res.json(paged(items, page, pageSize, (state.history || []).length)); } catch (error) { return next(error); } });
router.get('/favorites', async (req, res, next) => { try { const state = await obterEstadoLeitura(profileId(req)); const { page, pageSize } = pagination(req.query); return res.json(paged(state.favorites || [], page, pageSize, (state.favorites || []).length)); } catch (error) { return next(error); } });
router.get('/works/:id/reading-state', async (req, res, next) => { try { if (!await requireAccessibleWork(req, res)) return; const state = await obterEstadoLeitura(profileId(req)); return res.json({ data: { workId: req.params.id, ...(state.progress?.[req.params.id] || {}) }, version: state.version }); } catch (error) { return next(error); } });
router.put('/works/:id/reading-state', async (req, res, next) => { try { if (!await requireAccessibleWork(req, res)) return; const state = await obterEstadoLeitura(profileId(req)); const nextState = { ...state, progress: { ...state.progress, [req.params.id]: req.body?.position ? { ...req.body, updatedAt: Date.now() } : req.body }, version: req.body?.version ?? state.version }; return res.json({ data: await salvarEstadoLeitura(nextState, profileId(req)) }); } catch (error) { return next(error); } });
router.put('/works/:id/favorite', async (req, res, next) => { try { if (!await requireAccessibleWork(req, res)) return; const state = await obterEstadoLeitura(profileId(req)); const favorites = [...new Set([...(state.favorites || []), req.params.id])]; return res.json({ data: await salvarEstadoLeitura({ ...state, favorites, version: req.body?.version ?? state.version }, profileId(req)) }); } catch (error) { return next(error); } });
router.delete('/works/:id/favorite', async (req, res, next) => { try { if (!await requireAccessibleWork(req, res)) return; const state = await obterEstadoLeitura(profileId(req)); const favorites = (state.favorites || []).filter((id) => id !== req.params.id); return res.json({ data: await salvarEstadoLeitura({ ...state, favorites, version: req.body?.version ?? state.version }, profileId(req)) }); } catch (error) { return next(error); } });

router.get('/home', async (req, res, next) => { try { const state = await obterEstadoLeitura(profileId(req)); const scope = await buildWorkScope(req.user.id, { workAlias: 'w', offset: 1 }); const { rows: recent } = await query(`SELECT * FROM works w WHERE ${scope.sql} ORDER BY w.created_at DESC LIMIT $1`, [20, ...scope.values]); return res.json({ sections: [{ type: 'continue-reading', items: state.progress || {} }, { type: 'favorites', items: state.favorites || [] }, { type: 'recently-added', items: recent }] }); } catch (error) { return next(error); } });
router.get('/profiles', (req, res, next) => getProfiles(req, res, next));
router.post('/profiles', requireAdmin, postProfile);
router.put('/profiles/:id', requireAdmin, putProfile);
router.delete('/profiles/:id', requireAdmin, deleteProfile);
router.post('/profiles/:id/select', selectProfile);

router.get('/admin/system/status', requireAdmin, async (_req, res, next) => { try { return res.json({ data: { version: process.env.ARARU_SERVER_VERSION || '0.1.0', uptimeSeconds: Math.floor(process.uptime()), database: 'configured', redis: 'configured', storage: await storageHealth(), jobs: await adminOverview() } }); } catch (error) { return next(error); } });
router.get('/admin/system/metrics', requireAdmin, async (_req, res, next) => { try { return res.json({ data: { runtime: obterMetricasRuntime(), postgres: postgresPoolMetrics(), redis: await checkRedis(), storage: await storageHealth() } }); } catch (error) { return next(error); } });
router.get('/admin/storage/providers', requireAdmin, async (_req, res, next) => { try { const health = await storageHealth(); const providers = Object.values(getStorageProviders()).map((provider) => ({ type: provider.type, capabilities: provider.capabilities, configured: health[provider.type]?.configured ?? true, healthy: health[provider.type]?.healthy ?? true })); const disk = await statfs(env.dataDir); const blockSize = Number(disk.bsize); return res.json({ items: providers, settings: await listProviderSettings(), disk: { totalBytes: Number(disk.blocks) * blockSize, availableBytes: Number(disk.bavail) * blockSize, freeBytes: Number(disk.bfree) * blockSize, usedBytes: (Number(disk.blocks) - Number(disk.bfree)) * blockSize } }); } catch (error) { return next(error); } });
router.get('/admin/connections/providers', requireAdmin, (_req, res) => res.json({ data: listProviders() }));
router.get('/admin/connections', requireAdmin, async (_req, res, next) => { try { return res.json({ data: await listConnections() }); } catch (error) { return next(error); } });
router.post('/admin/connections', requireAdmin, async (req, res, next) => { try { return res.status(201).json({ data: await saveConnection(req.body, req.user.id) }); } catch (error) { return next(error); } });
router.get('/admin/connections/:id', requireAdmin, async (req, res, next) => { try { const data = await getConnection(req.params.id); return data ? res.json({ data }) : next(errors.notFound('Connection not found.')); } catch (error) { return next(error); } });
router.patch('/admin/connections/:id', requireAdmin, async (req, res, next) => { try { return res.json({ data: await saveConnection({ ...req.body, id: req.params.id }, req.user.id) }); } catch (error) { return next(error); } });
router.post('/admin/connections/:id/test', requireAdmin, async (req, res, next) => { try { return res.json({ data: await testConnection(req.params.id) }); } catch (error) { return next(error); } });
router.delete('/admin/connections/:id', requireAdmin, async (req, res, next) => { try { return (await deleteConnection(req.params.id)) ? res.status(204).end() : next(errors.notFound('Connection not found.')); } catch (error) { return next(error); } });
router.post('/admin/storage/providers', requireAdmin, async (req, res, next) => { try { return res.status(201).json({ data: await saveProviderSettings(String(req.body?.provider || ''), req.body, req.user.id) }); } catch (error) { return next(error); } });
router.get('/admin/storage/providers/:id', requireAdmin, (req, res, next) => { const provider = getStorageProviders()[req.params.id]; return provider ? res.json({ data: { type: provider.type, capabilities: provider.capabilities } }) : next(errors.notFound('Storage provider not found.')); });
router.patch('/admin/storage/providers/:id', requireAdmin, async (req, res, next) => { try { return res.json({ data: await saveProviderSettings(req.params.id, req.body, req.user.id) }); } catch (error) { return next(error); } });
router.delete('/admin/storage/providers/:id', requireAdmin, async (req, res, next) => { try { return await deleteProviderSettings(req.params.id) ? res.status(204).end() : next(errors.notFound('Storage provider settings not found.')); } catch (error) { return next(error); } });
router.post('/admin/storage/providers/:id/test', requireAdmin, async (req, res, next) => { try { const provider = getStorageProviders()[req.params.id]; if (!provider) return next(errors.notFound('Storage provider not found.')); const result = typeof provider.health === 'function' ? await provider.health() : { provider: provider.type, configured: true, healthy: true }; return res.json({ data: result }); } catch (error) { return next(error); } });
router.get('/admin/settings/schema', requireAdmin, (req, res) => res.json({ sections: [{ id: 'security', fields: settingsSchema(req.query.category || 'security') }] }));
router.get('/admin/settings/security', requireAdmin, async (_req, res, next) => { try { return res.json({ data: await getSettings('security') }); } catch (error) { return next(error); } });
router.patch('/admin/settings/security', requireAdmin, async (req, res, next) => { try { return res.json({ data: await setSettings(req.body?.settings || req.body, req.user.id, req.body?.expectedVersion, req.requestId) }); } catch (error) { return next(error); } });
router.post('/admin/settings/reset', requireAdmin, async (req, res, next) => { try { return res.json({ data: await resetSettings(req.body?.keys, req.user.id, req.body?.expectedVersion, req.requestId) }); } catch (error) { return next(error); } });
router.get('/admin/libraries', requireAdmin, async (_req, res, next) => { try { return res.json({ items: await listLibrariesAdmin() }); } catch (error) { return next(error); } });
router.post('/admin/libraries', requireAdmin, async (req, res, next) => { try { return res.status(201).json({ data: await createLibraryAdmin(req.body) }); } catch (error) { return next(error); } });
router.get('/admin/libraries/:id/sources', requireAdmin, async (req, res, next) => { try { return res.json({ data: await listSources(req.params.id) }); } catch (error) { return next(error); } });
router.post('/admin/libraries/:id/sources', requireAdmin, async (req, res, next) => { try { return res.status(201).json({ data: await saveSource(req.params.id, req.body) }); } catch (error) { return next(error); } });
router.patch('/admin/libraries/:id/sources/:sourceId', requireAdmin, async (req, res, next) => { try { return res.json({ data: await saveSource(req.params.id, { ...req.body, id: req.params.sourceId }) }); } catch (error) { return next(error); } });
router.delete('/admin/libraries/:id/sources/:sourceId', requireAdmin, async (req, res, next) => { try { return (await deleteSource(req.params.id, req.params.sourceId)) ? res.status(204).end() : next(errors.notFound('Source not found.')); } catch (error) { return next(error); } });
router.post('/admin/libraries/scan', requireAdmin, async (_req, res, next) => { try { const job = enfileirarAtualizacaoCatalogo({ priority: 'high', reason: 'admin-scan' }); void job.catch((error) => logger.error('catalog.admin_scan_failed', { error })); return res.status(202).json({ data: { status: 'queued' } }); } catch (error) { return next(error); } });
router.get('/admin/libraries/:id', requireAdmin, async (req, res, next) => { try { const data = await getLibraryAdmin(req.params.id); return data ? res.json({ data }) : next(errors.notFound('Library not found.')); } catch (error) { return next(error); } });
router.patch('/admin/libraries/:id', requireAdmin, async (req, res, next) => { try { const data = await updateLibraryAdmin(req.params.id, req.body); return data ? res.json({ data }) : next(errors.notFound('Library not found.')); } catch (error) { return next(error); } });
router.delete('/admin/libraries/:id', requireAdmin, async (req, res, next) => { try { return await deleteLibraryAdmin(req.params.id) ? res.status(204).end() : next(errors.notFound('Library not found.')); } catch (error) { return next(error); } });
router.get('/admin/settings', requireAdmin, async (req, res, next) => { try { return req.query.category ? res.json({ data: await getSettings(String(req.query.category)) }) : res.json({ data: await getGeneralSettings() }); } catch (error) { return next(error); } });
router.patch('/admin/settings', requireAdmin, async (req, res, next) => { try { return req.body?.settings || req.query.category ? res.json({ data: await setSettings(req.body?.settings || req.body, req.user.id, req.body?.expectedVersion, req.requestId) }) : res.json({ data: await saveGeneralSettings(req.body, req.user.id) }); } catch (error) { return next(error); } });
router.get('/admin/users', requireAdmin, async (req, res, next) => { try { const { page, pageSize } = pagination(req.query); const search = String(req.query.search || '').trim().toLowerCase(); const all = (await listUsers()).filter((user) => !search || [user.displayName, user.username, user.email].filter(Boolean).some((value) => String(value).toLowerCase().includes(search))); return res.json(paged(all.slice((page - 1) * pageSize, page * pageSize), page, pageSize, all.length)); } catch (error) { return next(error); } });
router.post('/admin/users', requireAdmin, async (req, res, next) => { try { return res.status(201).json({ data: await createUser({ ...req.body, roleId: req.body.roleId, mustChangePassword: Boolean(req.body.mustChangePassword) }) }); } catch (error) { return next(error); } });
router.get('/admin/users/:id', requireAdmin, async (req, res, next) => { try { const data = await getUserById(req.params.id); return data ? res.json({ data }) : next(errors.notFound('User not found.')); } catch (error) { return next(error); } });
router.patch('/admin/users/:id', requireAdmin, async (req, res, next) => { try { const target = await getUserById(req.params.id); if (!target) return next(errors.notFound('User not found.')); if ((req.body.active === false || req.body.roleId === 'role-reader') && target.roleId === 'role-administrator') { const count = await query("SELECT COUNT(*)::int AS total FROM users WHERE role_id='role-administrator' AND active=TRUE AND id<>$1", [target.id]); if (!Number(count.rows[0].total)) throw errors.conflict('The last active administrator cannot be disabled or demoted.'); } await query('UPDATE users SET display_name=COALESCE($1,display_name),email=COALESCE($2,email),role_id=COALESCE($3,role_id),role=CASE WHEN $3=\'role-administrator\' THEN \'admin\' ELSE \'user\' END,active=COALESCE($4,active),updated_at=NOW() WHERE id=$5', [req.body.displayName ?? null, req.body.email ?? null, req.body.roleId || null, typeof req.body.active === 'boolean' ? req.body.active : null, target.id]); return res.json({ data: await getUserById(target.id) }); } catch (error) { return next(error); } });
router.delete('/admin/users/:id', requireAdmin, async (req, res, next) => { try { const target = await getUserById(req.params.id); if (!target) return next(errors.notFound('User not found.')); if (target.id === req.user.id) throw errors.conflict('You cannot delete your own account.'); if (target.role === 'admin') { const count = await query("SELECT COUNT(*)::int AS total FROM users WHERE role='admin' AND active=TRUE AND id<>$1", [target.id]); if (!Number(count.rows[0].total)) throw errors.conflict('The last active administrator cannot be deleted.'); } await query('DELETE FROM users WHERE id=$1', [target.id]); return res.status(204).end(); } catch (error) { return next(error); } });
router.get('/permissions', async (req, res) => res.json({ data: permissionGroups }));
router.get('/me/permissions', async (req, res, next) => { try { return req.user ? res.json({ data: await effectiveAccess(req.user.id) }) : res.status(401).json({ message: 'Autenticação necessária.' }); } catch (error) { return next(error); } });
router.get('/admin/roles', requireAdmin, async (_req, res, next) => { try { return res.json({ data: await listRoles() }); } catch (error) { return next(error); } });
router.get('/admin/roles/:id', requireAdmin, async (req, res, next) => { try { const data = await getRole(req.params.id); return data ? res.json({ data }) : next(errors.notFound('Role not found.')); } catch (error) { return next(error); } });
router.post('/admin/roles', requireAdmin, async (req, res, next) => { try { return res.status(201).json({ data: await saveRole(req.body, req.user.id) }); } catch (error) { return next(error); } });
router.patch('/admin/roles/:id', requireAdmin, async (req, res, next) => { try { const data = await saveRole({ ...req.body, id: req.params.id }, req.user.id); await invalidateAuthorization(); return res.json({ data }); } catch (error) { return next(error); } });
router.delete('/admin/roles/:id', requireAdmin, async (req, res, next) => { try { return res.json({ data: await deleteRole(req.params.id, req.body?.replacementRoleId, req.user.id) }); } catch (error) { return next(error); } });
router.get('/admin/profiles', requireAdmin, async (req, res, next) => { try { const { page, pageSize } = pagination(req.query); const search = String(req.query.search || '').trim().toLowerCase(); const all = (await listarPerfis(null, true)).filter((profile) => !search || [profile.name, ...(profile.users || []).map((user) => `${user.displayName} ${user.username}`)].join(' ').toLowerCase().includes(search)); return res.json(paged(all.slice((page - 1) * pageSize, page * pageSize), page, pageSize, all.length)); } catch (error) { return next(error); } });
router.post('/admin/profiles', requireAdmin, async (req, res, next) => { try { return res.status(201).json({ data: await criarPerfil(req.body) }); } catch (error) { return next(error); } });
router.patch('/admin/profiles/:id', requireAdmin, async (req, res, next) => { try { const data = await atualizarPerfil(req.params.id, req.body); return data ? res.json({ data }) : next(errors.notFound('Profile not found.')); } catch (error) { return next(error); } });
router.delete('/admin/profiles/:id', requireAdmin, async (req, res, next) => { try { return (await removerPerfil(req.params.id)) ? res.status(204).end() : next(errors.notFound('Profile not found.')); } catch (error) { return next(error); } });
router.get('/admin/overview', requireAdmin, async (_req, res, next) => { try { return res.json({ data: await adminOverview() }); } catch (error) { return next(error); } });
router.get('/admin/audit', requireAdmin, async (req, res, next) => { try { return res.json({ items: await listAdminAudit(req.query.limit) }); } catch (error) { return next(error); } });
router.get('/admin/jobs', requireAdmin, async (req, res, next) => { try { const { page, pageSize } = pagination(req.query); const type = req.query.type ? String(req.query.type).slice(0, 120) : null; const search = req.query.search ? `%${String(req.query.search).slice(0, 120)}%` : null; const status = req.query.status && ['queued', 'running', 'completed', 'failed', 'cancelled'].includes(String(req.query.status)) ? String(req.query.status) : null; const where = '($1::text IS NULL OR type=$1) AND ($2::text IS NULL OR type ILIKE $2 OR error ILIKE $2) AND ($3::text IS NULL OR status=$3)'; const count = await query(`SELECT COUNT(*)::int AS total FROM background_jobs WHERE ${where}`, [type, search, status]); const summary = await query('SELECT status,COUNT(*)::int AS total FROM background_jobs GROUP BY status'); const availableTypes = await query('SELECT DISTINCT type FROM background_jobs WHERE type IS NOT NULL ORDER BY type'); const metrics = Object.fromEntries(summary.rows.map((row) => [row.status, row.total])); const { rows } = await query(`SELECT id,type,status,attempts,max_attempts AS "maxAttempts",worker_id AS "workerId",lease_until AS "leaseUntil",heartbeat_at AS "heartbeatAt",created_at AS "createdAt",started_at AS "startedAt",completed_at AS "completedAt",error,CASE WHEN status='queued' THEN EXTRACT(EPOCH FROM (NOW()-created_at))*1000 ELSE 0 END AS "queueAgeMs" FROM background_jobs WHERE ${where} ORDER BY created_at DESC LIMIT $4 OFFSET $5`, [type, search, status, pageSize, (page - 1) * pageSize]); return res.json({ ...paged(rows, page, pageSize, count.rows[0].total), metrics: { ...jobQueueMetrics(), ...metrics }, types: availableTypes.rows.map((row) => row.type) }); } catch (error) { return next(error); } });
router.get('/admin/jobs/center', requireAdmin, async (req, res, next) => { try { return res.json({ data: await jobCenterOverview({ recentPage: req.query.recentPage, recentPageSize: req.query.recentPageSize }) }); } catch (error) { return next(error); } });
router.get('/admin/jobs/definitions', requireAdmin, async (_req, res, next) => { try { return res.json({ data: await listJobDefinitions() }); } catch (error) { return next(error); } });
router.post('/admin/jobs/run', requireAdmin, async (req, res, next) => { try { const execution = runJob(String(req.body?.type || ''), req.body?.payload || {}, { priority: req.body?.priority || 'normal' }); return res.status(202).json({ data: { id: execution.jobId, type: req.body.type, status: 'queued' } }); } catch (error) { return next(error); } });
router.get('/admin/jobs/schedules', requireAdmin, async (_req, res, next) => { try { return res.json({ data: await listJobSchedules() }); } catch (error) { return next(error); } });
router.post('/admin/jobs/schedules', requireAdmin, async (req, res, next) => { try { return res.status(201).json({ data: await saveJobSchedule(req.body, req.user.id) }); } catch (error) { return next(error); } });
router.delete('/admin/jobs/schedules/:id', requireAdmin, async (req, res, next) => { try { return res.json({ data: await deleteJobSchedule(req.params.id) }); } catch (error) { return next(error); } });
router.get('/admin/jobs/:id', requireAdmin, async (req, res, next) => { try { const data = await jobExecution(req.params.id); return data ? res.json({ data }) : res.status(404).json({ message: 'Job not found.' }); } catch (error) { return next(error); } });
router.post('/admin/jobs/:id/cancel', requireAdmin, cancelarJob);
router.post('/admin/jobs/:id/retry', requireAdmin, repetirJob);
router.get('/admin/jobs/metrics', requireAdmin, listarMetricas);
router.get('/admin/metadata/summary', requireAdmin, async (_req, res, next) => { try { const { rows } = await query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE NULLIF(TRIM(nome),'') IS NOT NULL AND jsonb_array_length(CASE WHEN jsonb_typeof(autor)='array' THEN autor ELSE '[]'::jsonb END)>0 AND NULLIF(TRIM(categoria),'') IS NOT NULL AND NULLIF(TRIM(descricao),'') IS NOT NULL)::int AS complete, COUNT(*) FILTER (WHERE needs_review)::int AS review, COUNT(*) FILTER (WHERE NULLIF(TRIM(nome),'') IS NULL)::int AS missing_title, COUNT(*) FILTER (WHERE jsonb_array_length(CASE WHEN jsonb_typeof(autor)='array' THEN autor ELSE '[]'::jsonb END)=0)::int AS missing_author, COUNT(*) FILTER (WHERE NULLIF(TRIM(categoria),'') IS NULL)::int AS missing_category, COUNT(*) FILTER (WHERE NULLIF(TRIM(descricao),'') IS NULL)::int AS missing_description, COUNT(*) FILTER (WHERE metadata_confidence < 0.5)::int AS low_confidence, COUNT(*) FILTER (WHERE jsonb_array_length(CASE WHEN jsonb_typeof(candidate_matches)='array' THEN candidate_matches ELSE '[]'::jsonb END)>0)::int AS duplicates FROM livros`); return res.json({ data: { ...rows[0], incomplete: Number(rows[0].total) - Number(rows[0].complete), gaps: { title: rows[0].missing_title, author: rows[0].missing_author, category: rows[0].missing_category, description: rows[0].missing_description, lowConfidence: rows[0].low_confidence, duplicates: rows[0].duplicates } } }); } catch (error) { return next(error); } });
router.get('/admin/metadata/providers', requireAdmin, async (_req, res) => res.json({ data: [{ id: 'embedded', name: 'Embedded metadata', enabled: true }, { id: 'filename', name: 'Filename parser', enabled: true }, { id: 'google', name: 'Google Books', enabled: Boolean(env.googleBooksApiKey || env.metadataProvidersEnabled !== false) }, { id: 'open_library', name: 'Open Library', enabled: true }] }));
router.get('/admin/metadata/export', requireAdmin, getMetadataExport);
router.post('/admin/metadata/import', requireAdmin, postMetadataImport);
router.get('/admin/metadata/review', requireAdmin, async (req, res, next) => { try { const { page, pageSize } = pagination(req.query); const count = await query('SELECT COUNT(*)::int AS total FROM livros WHERE needs_review=TRUE'); const { rows } = await query("SELECT id,nome AS title,metadata_status AS status,metadata_confidence AS confidence,needs_review AS \"needsReview\" FROM livros WHERE needs_review=TRUE ORDER BY metadata_confidence ASC,updated_at DESC LIMIT $1 OFFSET $2", [pageSize, (page - 1) * pageSize]); return res.json(paged(rows, page, pageSize, count.rows[0].total)); } catch (error) { return next(error); } });
router.get('/admin/covers/status', requireAdmin, statusCacheCapas);
router.post('/admin/covers/generate-missing', requireAdmin, gerarCapasAusentes);
router.post('/admin/covers/rebuild', requireAdmin, express.json(), reconstruirCacheCapas);
router.post('/admin/covers/retry-failed', requireAdmin, repetirCapasComErro);
router.get('/admin/backup', requireAdmin, baixarBackup);
router.post('/admin/backup/verify', requireAdmin, express.raw({ type: ['application/gzip', 'application/octet-stream'], limit: '100mb' }), validarBackup);
router.post('/admin/backup/restore', requireAdmin, express.raw({ type: ['application/gzip', 'application/octet-stream'], limit: '100mb' }), importarBackup);
router.get('/admin/security/config', requireAdmin, async (_req, res, next) => { try { const data = await getSecurityConfig(); return res.json({ data: { ...data.config, metadata: data.metadata, pendingRestart: data.pendingRestart } }); } catch (error) { return next(error); } });
router.patch('/admin/security/config', requireAdmin, async (req, res, next) => { try { const data = await saveSecurityConfig(req.body, req.user.id, req.requestId, req.body?.expectedVersion); return res.json({ data: { ...data.config, metadata: data.metadata, settingsVersion: data.settingsVersion, pendingRestart: data.pendingRestart } }); } catch (error) { return next(error); } });
router.get('/admin/security', requireAdmin, async (_req, res, next) => { try { const [config, overview] = await Promise.all([getSecurityConfig(), securityOverview()]); return res.json({ data: { ...config, overview, sessionCookie: 'araru_session', secretsExposed: false } }); } catch (error) { return next(error); } });

export default router;
