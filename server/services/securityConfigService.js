import { env } from '../config/drive.js';
import { getSettings, setSettings } from './settingsService.js';

const pathValue = (items, key, fallback) => items.find((item) => item.key === key)?.effectiveValue ?? fallback;

function toConfig(items) {
  const value = (key, fallback) => pathValue(items, `security.${key}`, fallback);
  return {
    authentication: { maxLoginAttempts: value('authentication.maxLoginAttempts', 10), loginWindowSeconds: value('authentication.loginWindowSeconds', 900), lockoutSeconds: value('authentication.lockoutSeconds', 900), strongPassword: value('authentication.strongPassword', false), minPasswordLength: value('authentication.minPasswordLength', 4), requireUppercase: value('authentication.requireUppercase', false), requireLowercase: value('authentication.requireLowercase', false), requireNumber: value('authentication.requireNumber', false), requireSpecial: value('authentication.requireSpecial', false), requirePasswordChange: value('authentication.requirePasswordChange', false), passwordHistoryEnabled: value('authentication.passwordHistoryEnabled', false), passwordHistoryCount: value('authentication.passwordHistoryCount', 5), passwordExpirationEnabled: value('authentication.passwordExpirationEnabled', false), passwordExpirationDays: value('authentication.passwordExpirationDays', 90), passwordExpirationWarningDays: value('authentication.passwordExpirationWarningDays', 7), reauthSensitiveActions: value('authentication.reauthSensitiveActions', false) },
    sessions: { sessionSeconds: value('sessions.sessionSeconds', env.accessSessionSeconds), idleTimeoutSeconds: value('sessions.idleTimeoutSeconds', 0), renewal: value('sessions.renewal', false), maxConcurrentPerUser: value('sessions.maxConcurrentPerUser', 0) },
    rateLimit: { enabled: value('rateLimit.enabled', env.rateLimitEnabled), store: env.redisEnabled && env.redisUrl ? 'redis' : 'memory', profiles: { login: { max: value('rateLimit.profiles.login.max', 10), windowSeconds: value('rateLimit.profiles.login.windowSeconds', 900) }, api: { max: value('rateLimit.profiles.api.max', env.apiRateLimitPerMinute), windowSeconds: value('rateLimit.profiles.api.windowSeconds', 60) } } },
    cookies: { secure: value('cookies.secure', env.secureCookies), httpOnly: true, sameSite: value('cookies.sameSite', env.cookieSameSite), maxAgeSeconds: env.accessSessionSeconds },
    network: { trustProxy: env.trustProxy, allowedOrigins: env.allowedOrigins },
    headers: { contentSecurityPolicy: 'read-only', contentTypeOptions: true, referrerPolicy: 'strict-origin-when-cross-origin', frameProtection: 'SAMEORIGIN', hsts: false, permissionsPolicy: 'camera=(), microphone=(), geolocation=()' },
    reader: { scripts: 'blocked', externalContent: value('reader.externalContent', 'block'), externalLinks: 'confirm', iframes: 'blocked' },
    audit: { enabled: true, retentionDays: 90 }
  };
}

function metadata(items) { return Object.fromEntries(items.map((item) => [item.key.slice('security.'.length), { status: item.runtime ? 'RUNTIME' : item.restartRequired ? 'RESTART_REQUIRED' : item.editable ? 'RUNTIME' : item.source === 'env' ? 'DEPLOYMENT_ONLY' : 'READ_ONLY', source: item.source, managedBy: item.source === 'env' ? 'environment' : item.source, editable: item.editable, supported: item.supported }])); }

export async function getSecurityConfig() {
  const result = await getSettings('security');
  return { config: toConfig(result.settings), metadata: metadata(result.settings), settingsVersion: result.settingsVersion, pendingRestart: result.settings.filter((item) => item.restartRequired && item.configuredValue !== null && item.source !== 'env').map((item) => item.key) };
}

export async function saveSecurityConfig(input = {}, userId, requestId = null, expectedVersion = null) {
  expectedVersion = expectedVersion ?? null;
  const values = {};
  for (const [section, sectionValues] of Object.entries(input)) for (const [name, value] of Object.entries(sectionValues || {})) {
    if (section === 'rateLimit' && name === 'profiles') for (const [profile, profileValues] of Object.entries(value || {})) for (const [field, fieldValue] of Object.entries(profileValues || {})) values[`security.rateLimit.profiles.${profile}.${field}`] = fieldValue;
    else values[`security.${section}.${name}`] = value;
  }
  const currentCookies = (await getSecurityConfig()).config.cookies;
  if ((values['security.cookies.sameSite'] ?? currentCookies.sameSite) === 'none' && !(values['security.cookies.secure'] ?? currentCookies.secure)) throw Object.assign(new Error('SameSite=None exige Secure=true.'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  const result = await setSettings(values, userId, expectedVersion, requestId);
  return { config: toConfig(result.settings), metadata: metadata(result.settings), settingsVersion: result.settingsVersion, pendingRestart: result.settings.filter((item) => item.restartRequired && item.configuredValue !== null && item.source !== 'env').map((item) => item.key) };
}

export async function securityOverview() {
  const result = await getSecurityConfig();
  const alerts = [];
  if (!result.config.rateLimit.enabled) alerts.push({ severity: 'warning', key: 'rateLimit.disabled', message: 'Rate limiting está desativado.' });
  if (result.config.rateLimit.store === 'memory') alerts.push({ severity: 'warning', key: 'rateLimit.memory', message: 'Rate limiting em memória não é distribuído; configure Redis para múltiplas instâncias.' });
  if (!result.config.cookies.secure) alerts.push({ severity: 'warning', key: 'cookies.secure', message: 'Cookies Secure estão desativados pelo ambiente.' });
  return { status: alerts.length ? 'attention' : 'ok', alerts, recommendations: result.config.rateLimit.store === 'memory' ? ['Configure REDIS_URL antes de usar múltiplas instâncias.'] : [], pendingRestart: result.pendingRestart };
}
