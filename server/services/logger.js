const REDACTED = '[redacted]';
const secretPattern = /token|secret|password|authorization|cookie|credential/i;

function sanitize(value, key = '', depth = 0, allowTemporaryPassword = false) {
  if (secretPattern.test(key) && !(allowTemporaryPassword && key === 'temporaryPassword')) return REDACTED;
  if (depth > 5) return '[truncated]';
  if (value instanceof Error) return { name: value.name, message: value.message, code: value.code, stack: process.env.NODE_ENV === 'development' ? value.stack : undefined };
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, '', depth + 1, allowTemporaryPassword));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, sanitize(child, childKey, depth + 1, allowTemporaryPassword)]));
  if (typeof value === 'string' && value.length > 4000) return `${value.slice(0, 4000)}…`;
  return value;
}

export function log(level, event, fields = {}) {
  const exposeTemporaryPassword = event === 'auth.admin.initialized' || event === 'auth.admin.bootstrap_pending';
  const entry = sanitize({ timestamp: new Date().toISOString(), level, event, ...fields }, '', 0, exposeTemporaryPassword);
  const output = JSON.stringify(entry);
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(output);
}

export const logger = {
  debug: (event, fields) => process.env.LOG_LEVEL === 'debug' && log('debug', event, fields),
  info: (event, fields) => log('info', event, fields),
  warn: (event, fields) => log('warn', event, fields),
  error: (event, fields) => log('error', event, fields)
};
