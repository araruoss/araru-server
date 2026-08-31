import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

let app; let root; let cookie;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'araru-v1-'));
  await writeFile(path.join(root, 'Book.pdf'), '%PDF-1.4\nfixture\n%%EOF');
  Object.assign(process.env, { NODE_ENV: 'test', ENABLE_GOOGLE_DRIVE: 'false', LOCAL_LIBRARY_DIR: root, REDIS_ENABLED: 'false', ENRICH_ON_ACCESS: 'false', METADATA_ENRICH_CONCURRENCY: '0' });
  const { migratePostgres } = await import('../server/database/postgresMigrations.js');
  const { query } = await import('../server/database/postgres.js');
  await migratePostgres();
  await query('TRUNCATE TABLE user_sessions, user_profiles, users, system_settings RESTART IDENTITY CASCADE');
  await migratePostgres();
  ({ createApp: app } = await import('../server/app.js'));
  app = await app();
  const setup = await request(app).post('/api/v1/setup').send({ admin: { username: 'admin', password: 'strong-test-password' }, profile: { name: 'Principal' } });
  assert.equal(setup.status, 201);
  const login = await request(app).post('/api/v1/auth/login').send({ username: 'admin', password: 'strong-test-password' });
  assert.equal(login.status, 200); cookie = login.headers['set-cookie'];
});

after(async () => { await rm(root, { recursive: true, force: true }); });

test('expõe system, session e client config exclusivamente em v1', async () => {
  assert.equal((await request(app).get('/api/v1/system/info')).status, 200);
  assert.equal((await request(app).get('/api/v1/client-config')).status, 200);
  assert.equal((await request(app).get('/api/v1/session').set('Cookie', cookie)).status, 200);
  assert.equal((await request(app).get(`/api${'/system/info'}`)).status, 404);
});

test('NODE_ENV=test não transforma rota administrativa em endpoint público', async () => {
  const response = await request(app).get('/api/v1/admin/security');
  assert.equal(response.status, 401);
});

test('expõe works, filtros, content delivery e administração em v1', async () => {
  const works = await request(app).get('/api/v1/works').set('Cookie', cookie).query({ libraryId: 'library-local', format: 'pdf', favorite: 'false', completed: 'false', sort: 'title', order: 'asc' });
  assert.equal(works.status, 200); assert.ok(Array.isArray(works.body.items)); assert.ok(works.body.pagination);
  const libraries = await request(app).get('/api/v1/libraries').set('Cookie', cookie);
  assert.equal(libraries.status, 200); assert.ok(libraries.body.items.some((library) => library.id === 'library-local'));
  const sources = await request(app).get('/api/v1/admin/libraries/library-local/sources').set('Cookie', cookie);
  assert.equal(sources.status, 200); assert.ok(sources.body.data.some((source) => source.id === 'source-local'));
  assert.equal((await request(app).get('/api/v1/admin/system/status').set('Cookie', cookie)).status, 200);
  assert.equal((await request(app).get('/api/v1/admin/security').set('Cookie', cookie)).status, 200);
});

test('aplica cookies de sessão configuráveis e rejeita SameSite=None sem Secure', async () => {
  const initial = cookie.join(';');
  assert.match(initial, /HttpOnly/i);
  assert.match(initial, /SameSite=Lax/i);
  assert.doesNotMatch(initial, /; Secure/i);
  const config = await request(app).patch('/api/v1/admin/security/config').set('Cookie', cookie).send({ cookies: { secure: true, sameSite: 'strict' } });
  assert.equal(config.status, 200);
  const login = await request(app).post('/api/v1/auth/login').send({ username: 'admin', password: 'strong-test-password' });
  assert.equal(login.status, 200);
  assert.match(login.headers['set-cookie'].join(';'), /HttpOnly/i);
  assert.match(login.headers['set-cookie'].join(';'), /SameSite=Strict/i);
  assert.match(login.headers['set-cookie'].join(';'), /Secure/i);
  const invalid = await request(app).patch('/api/v1/admin/security/config').set('Cookie', cookie).send({ cookies: { secure: false, sameSite: 'none' } });
  assert.equal(invalid.status, 400);
});
