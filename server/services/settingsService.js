import { withTransaction, query } from '../database/postgres.js';
import { getRedisClient } from './redisService.js';
import { settingsRegistry, getSettingDefinition } from './settingsRegistry.js';
import { recordAdminAudit } from './adminService.js';

const cachePrefix = 'settings:global:';
const cacheKey = (category) => `${cachePrefix}${category}`;

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function validateValue(key, value) {
  const definition = getSettingDefinition(key);
  if (!definition) throw Object.assign(new Error(`Configuração desconhecida: ${key}`), { statusCode: 400, code: 'VALIDATION_ERROR' });
  if (definition.supported === false && value !== definition.default) throw Object.assign(new Error(`Configuração não suportada: ${key}`), { statusCode: 422, code: 'UNSUPPORTED_SETTING' });
  if (definition.type === 'integer' && (!Number.isInteger(value) || value < definition.min || value > definition.max)) throw Object.assign(new Error(`Valor inválido para ${key}.`), { statusCode: 400, code: 'VALIDATION_ERROR' });
  if (definition.type === 'boolean' && typeof value !== 'boolean') throw Object.assign(new Error(`Valor inválido para ${key}.`), { statusCode: 400, code: 'VALIDATION_ERROR' });
  if (definition.type === 'enum' && !definition.values.includes(value)) throw Object.assign(new Error(`Valor inválido para ${key}.`), { statusCode: 400, code: 'VALIDATION_ERROR' });
  return value;
}
function sourceFor(key) {
  return 'database';
}
function effectiveValue(key, configuredValue, definition) {
  return configuredValue === undefined ? definition.default : configuredValue;
}
function isEditable(definition, key) { return definition.supported !== false && sourceFor(key) !== 'env'; }

async function readRows(category, useCache = true) {
  const redis = getRedisClient();
  const key = cacheKey(category || 'all');
  if (useCache && redis) { const cached = await redis.get(key); if (cached) return JSON.parse(cached); }
  const values = category ? [category] : [];
  const result = await query(`SELECT key,value,value_type,category,scope,scope_id,updated_by,updated_at,version FROM app_settings ${category ? 'WHERE category=$1' : ''} ORDER BY key`, values);
  const rows = result.rows;
  if (redis) await redis.set(key, JSON.stringify(rows), 'EX', 300);
  return rows;
}

function materialize(category, rows) {
  const selected = Object.entries(settingsRegistry).filter(([, definition]) => !category || definition.category === category);
  const persisted = new Map(rows.map((row) => [row.key, row]));
  const settings = selected.map(([key, definition]) => {
    const row = persisted.get(key);
    const configuredValue = row ? row.value : undefined;
    const source = sourceFor(key) === 'env' ? 'env' : row ? 'database' : 'default';
    return { key, value: effectiveValue(key, configuredValue, definition), configuredValue: configuredValue === undefined ? null : configuredValue, effectiveValue: effectiveValue(key, configuredValue, definition), defaultValue: definition.default, type: definition.type, category: definition.category, scope: 'global', runtime: definition.runtime === true, restartRequired: definition.restartRequired === true, editable: isEditable(definition, key), supported: definition.supported !== false, source, description: definition.description, values: definition.values, updatedAt: row?.updated_at || null, version: Number(row?.version || 0) };
  });
  return { settings, settingsVersion: rows.reduce((max, row) => Math.max(max, Number(row.version || 0)), 0) };
}

export async function getSettings(category = null) { return materialize(category, await readRows(category)); }
export async function getSetting(key) { const category = getSettingDefinition(key)?.category; if (!category) throw Object.assign(new Error(`Configuração desconhecida: ${key}`), { statusCode: 400, code: 'VALIDATION_ERROR' }); return (await getSettings(category)).settings.find((item) => item.key === key); }
export async function getEffectiveSettings(category = null) { return (await getSettings(category)).settings.reduce((result, item) => { result[item.key] = item.effectiveValue; return result; }, {}); }

export async function setSettings(input = {}, actorUserId, expectedVersion = null, requestId = null) {
  const entries = Object.entries(input);
  if (!entries.length) throw Object.assign(new Error('Nenhuma configuração informada.'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  const validated = entries.map(([key, value]) => [key, validateValue(key, value)]);
  const result = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [728391]);
    const locked = await client.query('SELECT key,value,version FROM app_settings WHERE scope=$1 FOR UPDATE', ['global']);
    const lockedVersion = locked.rows.reduce((max, row) => Math.max(max, Number(row.version || 0)), 0);
    if (expectedVersion !== null && Number(expectedVersion) !== lockedVersion) throw Object.assign(new Error('As configurações foram alteradas por outro administrador.'), { statusCode: 409, code: 'SETTINGS_CONFLICT', details: { expectedVersion, currentVersion: lockedVersion } });
    for (const [key, value] of validated) {
      const definition = getSettingDefinition(key);
      if (!isEditable(definition, key)) throw Object.assign(new Error(`Configuração gerenciada pelo ambiente: ${key}`), { statusCode: 409, code: 'MANAGED_SETTING' });
      const old = locked.rows.find((row) => row.key === key)?.value;
      await client.query(`INSERT INTO app_settings(key,value,value_type,category,scope,scope_id,description,default_value,is_runtime,restart_required,updated_by,version) VALUES($1,$2::jsonb,$3,$4,'global','',$5,$6::jsonb,$7,$8,$9,1) ON CONFLICT(key,scope,scope_id) DO UPDATE SET value=EXCLUDED.value,value_type=EXCLUDED.value_type,description=EXCLUDED.description,default_value=EXCLUDED.default_value,is_runtime=EXCLUDED.is_runtime,restart_required=EXCLUDED.restart_required,updated_by=EXCLUDED.updated_by,updated_at=NOW(),version=app_settings.version+1`, [key, JSON.stringify(value), definition.type, definition.category, definition.description || '', JSON.stringify(definition.default), definition.runtime === true, definition.restartRequired === true, actorUserId]);
      await recordAdminAudit(actorUserId, key.startsWith('security.') ? 'security.settings.updated' : 'settings.updated', 'setting', key, { key, oldValue: old, newValue: value, requestId }, client);
    }
    return lockedVersion + 1;
  });
  await invalidateSettings();
  return { ...(await getSettings()), committedVersion: result };
}

export async function resetSettings(keys, actorUserId, expectedVersion = null, requestId = null) {
  const selected = Array.isArray(keys) ? keys : [keys];
  if (!selected.length || selected.some((key) => !getSettingDefinition(key))) throw Object.assign(new Error('Configuração desconhecida.'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  const result = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [728391]);
    const current = await client.query('SELECT key,value,version FROM app_settings WHERE scope=$1 FOR UPDATE', ['global']);
    const currentVersion = current.rows.reduce((max, row) => Math.max(max, Number(row.version || 0)), 0);
    if (expectedVersion !== null && Number(expectedVersion) !== currentVersion) throw Object.assign(new Error('As configurações foram alteradas por outro administrador.'), { statusCode: 409, code: 'SETTINGS_CONFLICT' });
    for (const key of selected) {
      if (!isEditable(getSettingDefinition(key), key)) throw Object.assign(new Error(`Configuração gerenciada ou não editável: ${key}`), { statusCode: 409, code: 'MANAGED_SETTING' });
      const oldValue = current.rows.find((row) => row.key === key)?.value;
      await client.query('DELETE FROM app_settings WHERE key=$1 AND scope=$2', [key, 'global']);
      await recordAdminAudit(actorUserId, 'settings.reset', 'setting', key, { key, oldValue, newValue: getSettingDefinition(key).default, requestId }, client);
    }
    return currentVersion + 1;
  });
  await invalidateSettings();
  return { ...(await getSettings()), committedVersion: result };
}

export async function invalidateSettings(category = null) { const redis = getRedisClient(); if (!redis) return; await redis.del(cacheKey(category || 'all'), cacheKey('security')); }
export function settingsSchema(category = null) { return Object.entries(settingsRegistry).filter(([, definition]) => !category || definition.category === category).map(([key, definition]) => ({ key, ...clone(definition), source: sourceFor(key), editable: isEditable(definition, key), restartRequired: definition.restartRequired === true })); }
