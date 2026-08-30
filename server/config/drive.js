import './loadEnv.js';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { logger } from '../services/logger.js';

const backendRoot = fileURLToPath(new URL('../../', import.meta.url));
const projectRoot = backendRoot;
const resolveProjectPath = (value, fallback) => path.resolve(projectRoot, value || fallback);
const dataDir = resolveProjectPath(process.env.DATA_DIR, 'storage');
const configuredSameSite = String(process.env.COOKIE_SAME_SITE || 'lax').toLowerCase();
const configuredOrigins = String(process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',').map((item) => item.trim().replace(/\/$/, '')).filter(Boolean);

export const env = {
  port: Number(process.env.PORT || 3001),
  databaseUrl: process.env.DATABASE_URL || '',
  databasePassword: process.env.DATABASE_PASSWORD || '',
  databaseSsl: String(process.env.DATABASE_SSL || 'false') === 'true',
  databasePoolMax: Number(process.env.DATABASE_POOL_MAX || 10),
  databaseIdleTimeoutMs: Number(process.env.DATABASE_IDLE_TIMEOUT_MS || 30000),
  databaseConnectionTimeoutMs: Number(process.env.DATABASE_CONNECTION_TIMEOUT_MS || 5000),
  redisUrl: process.env.REDIS_URL || '',
  redisPassword: process.env.REDIS_PASSWORD || '',
  redisEnabled: String(process.env.REDIS_ENABLED || 'true') === 'true',
  redisKeyPrefix: process.env.REDIS_KEY_PREFIX || 'araru:',
  frontendUrl: (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, ''),
  publicBackendUrl:
    (process.env.PUBLIC_BACKEND_URL || `http://localhost:${Number(process.env.PORT || 3001)}`).replace(/\/$/, ''),
  dataDir,
  enableGoogleDrive: String(process.env.ENABLE_GOOGLE_DRIVE || 'true') === 'true',
  googleBooksApiKey: process.env.GOOGLE_BOOKS_API_KEY || '',
  googleApiKey: process.env.GOOGLE_API_KEY || '',
  driveRequestTimeout: Number(process.env.DRIVE_REQUEST_TIMEOUT || 15000),
  driveConcurrency: Number(process.env.DRIVE_CONCURRENCY || 6),
  metadataRequestTimeout: Number(process.env.METADATA_REQUEST_TIMEOUT || 10000),
  metadataEnrichConcurrency: Number(process.env.METADATA_ENRICH_CONCURRENCY || 3),
  metadataMaxRetries: Number(process.env.METADATA_MAX_RETRIES || 3),
  metadataReviewThreshold: Number(process.env.METADATA_REVIEW_THRESHOLD || 0.65),
  metadataAutoApplyThreshold: Number(process.env.METADATA_AUTO_APPLY_THRESHOLD || 0.85),
  metadataPdfPages: Number(process.env.METADATA_PDF_PAGES || 5),
  metadataApiCacheDays: Number(process.env.METADATA_API_CACHE_DAYS || 60),
  metadataNegativeCacheDays: Number(process.env.METADATA_NEGATIVE_CACHE_DAYS || 3),
  coverRenderConcurrency: Number(process.env.COVER_RENDER_CONCURRENCY || 2),
  coverWidth: Number(process.env.COVER_WIDTH || 500),
  coverMaxInMemoryBytes: Number(process.env.COVER_MAX_IN_MEMORY_MB || 128) * 1024 * 1024,
  coverMaxSourceImageBytes: Number(process.env.COVER_MAX_SOURCE_IMAGE_MB || 100) * 1024 * 1024,
  coverRenderTimeout: Number(process.env.COVER_RENDER_TIMEOUT || 30000),
  readerMaxInMemoryBytes: Number(process.env.READER_MAX_IN_MEMORY_MB || 128) * 1024 * 1024,
  openLibraryApiUrl: process.env.OPENLIBRARY_API_URL || 'https://openlibrary.org/api/books',
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  googleRedirectUri:
    process.env.GOOGLE_REDIRECT_URI ||
    'http://localhost:3001/api/v1/auth/callback',
  driveFolderId: process.env.DRIVE_FOLDER_ID,
  driveFoldersConfigPath:
    resolveProjectPath(process.env.DRIVE_FOLDERS_CONFIG, path.relative(projectRoot, path.join(dataDir, 'drive-folders.json'))),
  localLibraryDir: resolveProjectPath(process.env.LOCAL_LIBRARY_DIR, path.relative(projectRoot, path.join(dataDir, 'pdfs'))),
  coverCacheDir: resolveProjectPath(process.env.COVER_CACHE_DIR, path.relative(projectRoot, path.join(dataDir, 'cache', 'covers'))),
  cacheMaxBytes: Number(process.env.CACHE_MAX_GB || 2) * 1024 * 1024 * 1024,
  coverPipelineVersion: Number(process.env.COVER_PIPELINE_VERSION || 2),
  manualCategoriesPath: resolveProjectPath(process.env.MANUAL_CATEGORIAS_PATH, path.relative(projectRoot, path.join(dataDir, 'categorias.json'))),
  enrichOnAccess: String(process.env.ENRICH_ON_ACCESS || 'true') === 'true',
  cacheMetadata: String(process.env.CACHE_METADATA || 'true') === 'true',
  refreshMetadataDays: Number(process.env.REFRESH_METADATA_DAYS || 30),
  useFallbackCategoria: process.env.USE_FALLBACK_CATEGORIA || 'Outros',
  localFilesRoute: process.env.LOCAL_FILES_ROUTE || '/arquivos',
  cacheTtl: Number(process.env.CACHE_TTL || 3600),
  libraryWatchEnabled: String(process.env.LIBRARY_WATCH_ENABLED || 'true') === 'true',
  libraryWatchDebounceMs: Number(process.env.LIBRARY_WATCH_DEBOUNCE_MS || 1200),
  jobsEnabled: String(process.env.JOBS_ENABLED || 'true') === 'true',
  catalogRefreshIntervalMinutes: Number(process.env.CATALOG_REFRESH_INTERVAL_MINUTES || 60),
  maintenanceIntervalMinutes: Number(process.env.MAINTENANCE_INTERVAL_MINUTES || 1440),
  catalogMissingRetentionDays: Number(process.env.CATALOG_MISSING_RETENTION_DAYS || 30),
  allowedOrigins: configuredOrigins.filter((origin) => origin !== '*'),
  hasWildcardOrigin: configuredOrigins.includes('*'),
  trustProxy: String(process.env.TRUST_PROXY || 'false') === 'true',
  rateLimitEnabled: String(process.env.RATE_LIMIT_ENABLED || 'false') === 'true',
  rateLimitWindowMs: Math.max(1000, Number(process.env.RATE_LIMIT_WINDOW_MS || 60000)),
  apiRateLimitPerMinute: Number(process.env.API_RATE_LIMIT_PER_MINUTE || 300),
  appAccessSecret: process.env.APP_ACCESS_SECRET || '',
  accessSessionSeconds: Number(process.env.ACCESS_SESSION_SECONDS || 86400),
  secureCookies: String(process.env.SECURE_COOKIES || 'false') === 'true',
  cookieSameSite: ['lax', 'strict', 'none'].includes(configuredSameSite) ? configuredSameSite : 'lax',
  useMockData: String(process.env.USE_MOCK_DATA || 'false') === 'true'
};

env.storageProvider = process.env.STORAGE_PROVIDER || 'local';
env.r2 = {
  endpoint: process.env.R2_ENDPOINT || '', accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '', bucket: process.env.R2_BUCKET || '',
  region: process.env.R2_REGION || 'auto', publicUrl: process.env.R2_PUBLIC_URL || '', signedUrlTtl: Number(process.env.R2_SIGNED_URL_TTL || 300), prefix: process.env.R2_PREFIX || ''
};
env.r2Configured = Boolean(env.r2.endpoint && env.r2.accessKeyId && env.r2.secretAccessKey && env.r2.bucket);

export function validateEnvironment() {
  const localDevelopment = ['development', 'test'].includes(String(process.env.NODE_ENV || 'development').toLowerCase());
  const weakCredentials = new Set(['araru', 'password', 'postgres', 'redis', 'changeme', 'change-me', '']);
  let databasePassword = env.databasePassword;
  let redisPassword = env.redisPassword;
  try { databasePassword ||= new URL(env.databaseUrl).password; } catch { /* URL ausente ou inválida é tratado abaixo. */ }
  try { redisPassword ||= new URL(env.redisUrl).password; } catch { /* URL ausente ou inválida é tratado abaixo. */ }
  const databaseUnsafe = !env.databaseUrl || weakCredentials.has(String(databasePassword).toLowerCase());
  const redisUnsafe = env.redisEnabled && (!env.redisUrl || weakCredentials.has(String(redisPassword).toLowerCase()));
  if (!localDevelopment && (databaseUnsafe || redisUnsafe)) {
    throw new Error('Credenciais de banco/Redis ausentes ou fracas fora de desenvolvimento/teste.');
  }
  if (!valorConfigurado(env.databaseUrl)) {
    logger.warn('config.database.url_missing', { expected: 'DATABASE_URL' });
  }
  if (env.redisEnabled && !valorConfigurado(env.redisUrl)) {
    logger.warn('config.redis.url_missing', { expected: 'REDIS_URL' });
  }
  if (env.cookieSameSite === 'none' && !env.secureCookies) {
    logger.warn('config.cookie.same_site_none_without_secure');
  }
  if (env.hasWildcardOrigin) logger.warn('config.cors.wildcard_ignored_with_credentials');
  if (env.storageProvider === 'r2' && !env.r2Configured) logger.warn('config.r2.incomplete', { expected: ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] });
  if (env.useMockData) {
    logger.info('config.mock_mode.enabled');
    return;
  }

  if (!env.enableGoogleDrive) {
    return;
  }

  const required = valorConfigurado(env.googleApiKey)
    ? []
    : [
        ['GOOGLE_CLIENT_ID', env.googleClientId],
        ['GOOGLE_CLIENT_SECRET', env.googleClientSecret],
        ['GOOGLE_REDIRECT_URI', env.googleRedirectUri]
      ];

  const missing = required
    .filter(([, value]) => !valorConfigurado(value))
    .map(([key]) => key);

  if (missing.length > 0) {
    // A biblioteca tambem pode funcionar somente com os PDFs locais. A
    // ausencia da configuracao do Drive nao deve impedir o servidor de
    // iniciar nem esconder a fonte local.
    logger.warn('config.google_drive.incomplete', { missing, localLibraryAvailable: true });
  }
}

export function hasDriveConfig() {
  const hasFoldersFile = fs.existsSync(env.driveFoldersConfigPath);
  return Boolean(
    (valorConfigurado(env.googleApiKey) ||
      (valorConfigurado(env.googleClientId) && valorConfigurado(env.googleClientSecret))) &&
      (env.driveFolderId || hasFoldersFile)
  );
}

function valorConfigurado(value) {
  return Boolean(value && !['seu_client_id', 'seu_client_secret', 'id_da_pasta_raiz'].includes(String(value).trim()));
}

export const oauth2Client = new google.auth.OAuth2(
  env.googleClientId,
  env.googleClientSecret,
  env.googleRedirectUri
);

export function createDriveClient() {
  const options = { version: 'v3', timeout: env.driveRequestTimeout };

  // OAuth e a chave de API podem coexistir. O token OAuth tem prioridade
  // quando a sessao foi autenticada; caso contrario, a chave consulta apenas
  // arquivos/pastas publicos.
  if (hasGoogleCredentials()) {
    options.auth = oauth2Client;
  } else if (valorConfigurado(env.googleApiKey)) {
    // O cliente googleapis espera a chave de API em `auth`. O campo `key`
    // fica sem efeito neste cliente e faz a API tratar a chamada como anonima.
    options.auth = env.googleApiKey;
  }

  return google.drive(options);
}

export function createAuthUrl() {
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/drive.readonly']
  });
}

export function hasGoogleCredentials() {
  const credentials = oauth2Client.credentials || {};
  return Boolean(credentials.access_token || credentials.refresh_token);
}

export function hasGoogleApiKey() {
  return valorConfigurado(env.googleApiKey);
}
