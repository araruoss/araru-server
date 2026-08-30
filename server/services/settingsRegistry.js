// The registry is the schema for settings. PostgreSQL stores overrides only.
export const settingsRegistry = {
  'security.authentication.maxLoginAttempts': { type: 'integer', default: 10, min: 1, max: 100, category: 'security', runtime: true, description: 'Maximum failed login attempts per IP and username.' },
  'security.authentication.loginWindowSeconds': { type: 'integer', default: 900, min: 10, max: 86400, category: 'security', runtime: true, description: 'Window used to count failed login attempts.' },
  'security.authentication.lockoutSeconds': { type: 'integer', default: 900, min: 0, max: 604800, category: 'security', runtime: true, description: 'Lockout duration after the attempt limit is exceeded.' },
  'security.authentication.strongPassword': { type: 'boolean', default: false, category: 'security', runtime: true, description: 'Enable the configurable strong-password requirements.' },
  'security.authentication.minPasswordLength': { type: 'integer', default: 4, min: 4, max: 128, category: 'security', runtime: true, description: 'Minimum password length for new or changed passwords.' },
  'security.authentication.requireUppercase': { type: 'boolean', default: false, category: 'security', runtime: true, description: 'Require an uppercase letter in passwords.' },
  'security.authentication.requireLowercase': { type: 'boolean', default: false, category: 'security', runtime: true, description: 'Require a lowercase letter in passwords.' },
  'security.authentication.requireNumber': { type: 'boolean', default: false, category: 'security', runtime: true, description: 'Require a number in new or changed passwords.' },
  'security.authentication.requireSpecial': { type: 'boolean', default: false, category: 'security', runtime: true, description: 'Require a special character in new or changed passwords.' },
  'security.authentication.requirePasswordChange': { type: 'boolean', default: false, category: 'security', runtime: true, description: 'Mark newly created accounts for password change.' },
  'security.authentication.passwordHistoryEnabled': { type: 'boolean', default: false, category: 'security', runtime: true, description: 'Prevent reuse of recent passwords.' },
  'security.authentication.passwordHistoryCount': { type: 'integer', default: 5, min: 1, max: 24, category: 'security', runtime: true, description: 'Number of previous passwords to remember.' },
  'security.authentication.passwordExpirationEnabled': { type: 'boolean', default: false, category: 'security', runtime: true, description: 'Expire passwords after the configured period.' },
  'security.authentication.passwordExpirationDays': { type: 'integer', default: 90, min: 1, max: 365, category: 'security', runtime: true, description: 'Password lifetime in days.' },
  'security.authentication.passwordExpirationWarningDays': { type: 'integer', default: 7, min: 0, max: 30, category: 'security', runtime: true, description: 'Days before expiry when users should be warned.' },
  'security.authentication.reauthSensitiveActions': { type: 'boolean', default: false, category: 'security', runtime: false, restartRequired: false, supported: false, description: 'Requires a reauthentication flow that is not available yet.' },
  'security.sessions.sessionSeconds': { type: 'integer', default: 86400, min: 60, max: 2592000, category: 'security', runtime: false, restartRequired: true, description: 'Lifetime applied to new session cookies after restart.' },
  'security.sessions.idleTimeoutSeconds': { type: 'integer', default: 0, min: 0, max: 604800, category: 'security', runtime: false, supported: false, description: 'Idle timeout is not implemented by the current session model.' },
  'security.sessions.renewal': { type: 'boolean', default: false, category: 'security', runtime: false, supported: false, description: 'Session renewal is not implemented by the current session model.' },
  'security.sessions.maxConcurrentPerUser': { type: 'integer', default: 0, min: 0, max: 100, category: 'security', runtime: false, supported: false, description: 'Concurrent session limits are not implemented yet.' },
  'security.rateLimit.enabled': { type: 'boolean', default: false, category: 'security', runtime: true, description: 'Enable API and login rate limiting.' },
  'security.rateLimit.profiles.login.max': { type: 'integer', default: 10, min: 1, max: 100000, category: 'security', runtime: true, description: 'Login requests per window.' },
  'security.rateLimit.profiles.login.windowSeconds': { type: 'integer', default: 900, min: 1, max: 86400, category: 'security', runtime: true, description: 'Login rate-limit window.' },
  'security.rateLimit.profiles.api.max': { type: 'integer', default: 300, min: 1, max: 100000, category: 'security', runtime: true, description: 'API requests per window.' },
  'security.rateLimit.profiles.api.windowSeconds': { type: 'integer', default: 60, min: 1, max: 86400, category: 'security', runtime: true, description: 'API rate-limit window.' },
  'security.cookies.secure': { type: 'boolean', default: false, category: 'security', runtime: true, description: 'Set the Secure flag on new session cookies.' },
  'security.cookies.sameSite': { type: 'enum', default: 'lax', values: ['lax', 'strict', 'none'], category: 'security', runtime: true, description: 'SameSite policy for new session cookies.' },
  'security.reader.externalContent': { type: 'enum', default: 'block', values: ['block', 'ask', 'allow'], category: 'security', runtime: true, description: 'Policy for remote resources referenced by imported books.' },
  'security.audit.enabled': { type: 'boolean', default: true, category: 'security', runtime: false, supported: false, description: 'Audit logging is mandatory and cannot be disabled.' },
  'security.audit.retentionDays': { type: 'integer', default: 90, min: 1, max: 3650, category: 'security', runtime: false, supported: false, description: 'Audit retention worker is not implemented yet.' }
};

export function getSettingDefinition(key) { return settingsRegistry[key] || null; }
export function assertRegistryIntegrity() {
  const keys = Object.keys(settingsRegistry);
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate setting key in registry.');
  for (const [key, definition] of Object.entries(settingsRegistry)) {
    if (!definition.category || !definition.type || definition.default === undefined) throw new Error(`Invalid setting definition: ${key}`);
    if (definition.type === 'integer' && (!Number.isInteger(definition.default) || definition.default < definition.min || definition.default > definition.max)) throw new Error(`Invalid integer default: ${key}`);
    if (definition.type === 'enum' && !definition.values.includes(definition.default)) throw new Error(`Invalid enum default: ${key}`);
  }
  return true;
}
