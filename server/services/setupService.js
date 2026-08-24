import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '../database/postgres.js';
import { hashPassword } from './userAuthService.js';

const allowedLanguages = new Set(['pt-BR', 'en']);
const allowedThemes = new Set(['system', 'dark', 'light']);

export async function getSetupStatus() {
  const { rows } = await query("SELECT value FROM system_settings WHERE key='setup.completed'");
  const users = await query('SELECT COUNT(*)::int total FROM users');
  const completed = rows[0]?.value === true || Number(users.rows[0]?.total) > 0;
  const settings = completed ? await getGeneralSettings() : null;
  return { setupRequired: !completed, completed, supportedLanguages: [...allowedLanguages], supportedThemes: [...allowedThemes], publicSettings: settings ? { language: settings.language, theme: settings.theme, libraryName: settings.libraryName } : null };
}

export async function completeSetup(input = {}) {
  const language = allowedLanguages.has(input.language) ? input.language : 'pt-BR';
  const theme = allowedThemes.has(input.theme) ? input.theme : 'system';
  const username = String(input.admin?.username || '').trim().toLowerCase();
  const password = String(input.admin?.password || '');
  const email = String(input.admin?.email || '').trim().toLowerCase() || null;
  const profileName = String(input.profile?.name || '').trim().slice(0, 60);
  if (!/^[a-z0-9._@+-]{3,120}$/.test(username)) throw Object.assign(new Error('Nome de usuário inválido.'), { statusCode: 400 });
  if (password.length < 8) throw Object.assign(new Error('A senha deve ter pelo menos 8 caracteres.'), { statusCode: 400 });
  if (!profileName) throw Object.assign(new Error('Nome do perfil é obrigatório.'), { statusCode: 400 });
  return withTransaction(async (client) => {
    await client.query('LOCK TABLE users IN EXCLUSIVE MODE');
    const existing = await client.query('SELECT COUNT(*)::int total FROM users');
    const done = await client.query("SELECT value FROM system_settings WHERE key='setup.completed'");
    if (Number(existing.rows[0].total) > 0 || done.rows[0]?.value === true) throw Object.assign(new Error('A configuração inicial já foi concluída.'), { statusCode: 409 });
    const userId = randomUUID(); const profileId = randomUUID();
    await client.query('INSERT INTO profiles(id,name,color,is_default,language,theme,preferences) VALUES($1,$2,$3,TRUE,$4,$5,$6::jsonb)', [profileId, profileName, input.profile?.color || '#0891B2', language, theme, JSON.stringify(input.preferences || {})]);
    await client.query("UPDATE profiles SET is_default=FALSE, active=FALSE WHERE id='default'");
    await client.query('INSERT INTO users(id,username,email,display_name,password_hash,role,profile_id,must_change_password,active) VALUES($1,$2,$3,$4,$5,$6,$7,FALSE,TRUE)', [userId, username, email, input.admin?.displayName || username, hashPassword(password), 'admin', profileId]);
    await client.query('INSERT INTO user_profiles(user_id,profile_id,is_default) VALUES($1,$2,TRUE)', [userId, profileId]);
    const settings = { language, theme, libraryName: String(input.server?.libraryName || 'Araru').slice(0, 80), allowRegistration: false };
    await client.query("INSERT INTO system_settings(key,value,updated_by) VALUES('general',$1::jsonb,$2),('setup.completed','true'::jsonb,$2)", [JSON.stringify(settings), userId]);
    return { completed: true, userId, profileId, settings };
  });
}

export async function getGeneralSettings() { const { rows } = await query("SELECT value FROM system_settings WHERE key='general'"); return rows[0]?.value || { language: 'pt-BR', theme: 'system', libraryName: 'Araru' }; }
export async function saveGeneralSettings(settings = {}, userId) {
  const current = await getGeneralSettings();
  const libraryName = String(settings.libraryName ?? current.libraryName ?? 'Araru').trim().slice(0, 80) || 'Araru';
  const timezone = String(settings.timezone ?? current.timezone ?? 'UTC').slice(0, 80);
  try { new Intl.DateTimeFormat('pt-BR', { timeZone: timezone }).format(); } catch { throw Object.assign(new Error('Fuso horário inválido.'), { statusCode: 400 }); }
  const value = {
    libraryName,
    language: allowedLanguages.has(settings.language) ? settings.language : (current.language || 'pt-BR'),
    theme: allowedThemes.has(settings.theme) ? settings.theme : (current.theme || 'system'),
    timezone,
    dateFormat: ['locale', 'iso'].includes(settings.dateFormat) ? settings.dateFormat : (current.dateFormat || 'locale'),
    allowRegistration: typeof settings.allowRegistration === 'boolean' ? settings.allowRegistration : Boolean(current.allowRegistration)
  };
  await query("INSERT INTO system_settings(key,value,updated_by) VALUES('general',$1::jsonb,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=NOW()", [JSON.stringify(value), userId]);
  return value;
}
