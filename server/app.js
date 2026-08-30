import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import { env, hasDriveConfig, hasGoogleApiKey, hasGoogleCredentials, validateEnvironment } from './config/drive.js';
import { prepararBibliotecaLocal } from './services/driveService.js';
import { configureAccessV1, createDynamicRateLimiter, createRateLimiter, requireAdmin, securityHeaders } from './middleware/security.js';
import { metricsMiddleware, obterMetricasRuntime, registrarErro } from './services/runtimeMetrics.js';
import { obterResumoIndice } from './services/libraryIndexService.js';
import { estadoObservadorBiblioteca } from './services/libraryWatcher.js';
import { estadoJobsManutencao } from './services/maintenanceJobs.js';
import { estadoFilaEnriquecimento } from './services/metadataService.js';
import { carregarCredenciaisOAuth, obterEstadoSincronizacao } from './services/drivePersistenceService.js';
import { logger } from './services/logger.js';
import { historicoTrabalhos } from './services/backgroundJobs.js';
import { userCount } from './services/userAuthService.js';
import { checkPostgres } from './database/postgres.js';
import { checkRedis } from './services/redisService.js';
import { storageHealth } from './storage/index.js';
import v1Routes from './routes/v1Routes.js';
import { v1ErrorResponse } from './http/apiErrors.js';

const errorCodes = {
  400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND',
  409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 416: 'RANGE_NOT_SATISFIABLE',
  422: 'UNPROCESSABLE_CONTENT', 429: 'RATE_LIMITED', 500: 'INTERNAL_ERROR'
};

function normalizeErrorResponses(req, res, next) {
  const sendJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 400 && body && typeof body === 'object' && !Array.isArray(body) && !body.code) {
      return sendJson({ ...body, code: errorCodes[res.statusCode] || 'REQUEST_ERROR' });
    }
    return sendJson(body);
  };
  next();
}

export async function createApp() {
  await carregarCredenciaisOAuth();
  validateEnvironment();
  await prepararBibliotecaLocal();

  const app = express();
  if (env.trustProxy) app.set('trust proxy', 1);

  app.use(securityHeaders);
  app.use(cors((req, callback) => {
    const origin = req.get('origin');
    const forwardedHost = req.get('x-forwarded-host')?.split(',')[0]?.trim();
    const requestHosts = new Set([req.get('host'), forwardedHost].filter(Boolean));
    let sameHost = false;
    try { sameHost = requestHosts.has(new URL(origin).host); } catch { /* Origin ausente ou inválida. */ }
    const allowed = !origin || sameHost || env.allowedOrigins.includes(origin.replace(/\/$/, ''));
    callback(null, {
      credentials: true,
      origin: allowed,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Accept', 'Authorization', 'Content-Type', 'Range', 'X-Confirm-Restore'],
      exposedHeaders: ['Accept-Ranges', 'Content-Disposition', 'Content-Length', 'Content-Range', 'ETag', 'Last-Modified', 'X-Total-Paginas']
    });
  }));
  app.use(normalizeErrorResponses);
  app.use(express.json());
  app.use(cookieParser());
  app.use(metricsMiddleware);
  app.use('/api/v1', createDynamicRateLimiter('api'));
  await configureAccessV1(app, {
    secret: env.appAccessSecret,
    sessionSeconds: env.accessSessionSeconds,
    secureCookies: env.secureCookies,
    sameSite: env.cookieSameSite
  });
  app.get('/health/details', (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: 'Autenticação necessária.' });
    return requireAdmin(req, res, next);
  }, async (req, res) => {
    try {
      const [database, redis, storage] = await Promise.all([checkPostgres(), checkRedis(), storageHealth()]);
      return res.json({ application: 'Araru Server', status: 'ok', runtime: obterMetricasRuntime(), mock: env.useMockData,
        database, redis, storage, googleDriveEnabled: env.enableGoogleDrive, googleDriveConfigured: hasDriveConfig(),
        googleDriveAuthenticated: hasGoogleCredentials(), googleDriveApiKeyConfigured: hasGoogleApiKey(),
        driveFoldersConfig: env.driveFoldersConfigPath, localLibraryDir: env.localLibraryDir,
        catalog: await obterResumoIndice(), metadataQueue: estadoFilaEnriquecimento(), watcher: estadoObservadorBiblioteca(),
        jobs: estadoJobsManutencao(), recentJobs: await historicoTrabalhos({ limit: 10 }), driveSync: await obterEstadoSincronizacao() });
    } catch (error) { return res.status(503).json({ status: 'degraded', database: { healthy: false, error: error.message } }); }
  });
  app.use(env.localFilesRoute, express.static(env.localLibraryDir, { index: false }));

  app.get('/health', async (req, res) => {
    res.json({
      application: 'Araru Server',
      status: 'ok',
      uptimeSeconds: obterMetricasRuntime().uptimeSeconds,
      accessProtected: Boolean(env.appAccessSecret) || Boolean(await userCount())
    });
  });
  app.get('/live', (_req, res) => res.json({ status: 'ok', liveness: true }));
  app.get('/ready', async (_req, res) => {
    const [database, redis, storage] = await Promise.all([checkPostgres(), checkRedis(), storageHealth()]);
    const redisRequired = env.redisEnabled;
    const storageReady = Object.values(storage).every((provider) => provider.healthy !== false);
    const ready = database.healthy && (!redisRequired || redis.healthy) && storageReady;
    return res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'degraded', readiness: ready, database, redis, storage });
  });

  app.use('/api/v1', v1Routes);

  // Instalações antigas registravam o PWA na porta da API. Este worker limpa
  // apenas esse estado legado e direciona a aba para o frontend atual.
  app.get('/sw.js', (req, res) => {
    const frontendUrl = JSON.stringify(`${env.frontendUrl}/`);
    const cleanupWorker = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('biblioteca-digital-')).map((key) => caches.delete(key)));
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    await Promise.all(windows.map((client) => client.navigate(${frontendUrl})));
    await self.registration.unregister();
  })());
});
`;
    return res
      .type('application/javascript')
      .set({ 'Cache-Control': 'no-store', 'Service-Worker-Allowed': '/' })
      .send(cleanupWorker);
  });

  app.use((req, res) => {
    if (req.path.startsWith('/api/v1')) return res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found.', requestId: req.requestId } });
    res.status(404).json({ message: 'Rota nao encontrada.' });
  });

  app.use((error, req, res, next) => {
    const status = error.statusCode || error.status || 500;
    const message = status >= 500 ? 'Erro interno no servidor.' : error.message;

    if (status >= 500) {
      registrarErro();
      logger.error('http.request.failed', { requestId: req.requestId, method: req.method, path: req.originalUrl, status, error });
    }

    if (req.path.startsWith('/api/v1')) return res.status(status).json(v1ErrorResponse(error, req.requestId));
    res.status(status).json({
      message,
      code: error.code || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'),
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  });

  return app;
}
