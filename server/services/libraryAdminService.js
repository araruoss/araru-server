import { randomUUID } from 'node:crypto';
import { query } from '../database/postgres.js';

const clean = (value, fallback = '') => String(value ?? fallback).trim().slice(0, 160);
const allowedProviders = new Set(['local', 'drive', 'r2']);

export async function listLibrariesAdmin() {
  const { rows } = await query('SELECT id,name,provider,location,enabled,settings,created_at AS "createdAt",updated_at AS "updatedAt" FROM libraries ORDER BY LOWER(name)');
  return rows;
}

export async function getLibraryAdmin(id) {
  const { rows } = await query('SELECT id,name,provider,location,enabled,settings,created_at AS "createdAt",updated_at AS "updatedAt" FROM libraries WHERE id=$1', [id]);
  return rows[0] || null;
}

export async function createLibraryAdmin(input = {}) {
  const name = clean(input.name);
  const provider = clean(input.provider).toLowerCase();
  if (!name || !allowedProviders.has(provider)) throw Object.assign(new Error('A library name and a valid provider are required.'), { code: 'VALIDATION_ERROR', statusCode: 400 });
  const id = clean(input.id, `library-${randomUUID()}`);
  await query('INSERT INTO libraries(id,name,provider,location,enabled,settings) VALUES($1,$2,$3,$4,$5,$6::jsonb)', [id, name, provider, clean(input.location) || null, input.enabled !== false, JSON.stringify(input.settings || {})]);
  return getLibraryAdmin(id);
}

export async function updateLibraryAdmin(id, input = {}) {
  const current = await getLibraryAdmin(id); if (!current) return null;
  const provider = input.provider === undefined ? current.provider : clean(input.provider).toLowerCase();
  if (!allowedProviders.has(provider)) throw Object.assign(new Error('Invalid storage provider.'), { code: 'VALIDATION_ERROR', statusCode: 400 });
  await query('UPDATE libraries SET name=$1,provider=$2,location=$3,enabled=$4,settings=$5::jsonb,updated_at=NOW() WHERE id=$6', [clean(input.name, current.name), provider, clean(input.location, current.location) || null, typeof input.enabled === 'boolean' ? input.enabled : current.enabled, JSON.stringify(input.settings ?? current.settings ?? {}), id]);
  return getLibraryAdmin(id);
}

export async function deleteLibraryAdmin(id) { const result = await query('DELETE FROM libraries WHERE id=$1', [id]); return Boolean(result.rowCount); }
