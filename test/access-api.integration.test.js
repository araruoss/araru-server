import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

test('protege a API remota e cria sessão HttpOnly após login', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'araru-access-'));
  const library = path.join(root, 'library');
  await mkdir(library, { recursive: true });
  await writeFile(path.join(root, 'categorias.json'), '{"defaults":{"categoria":"Outros"},"livros":{}}');
  await writeFile(path.join(root, 'drive-folders.json'), '[]');
  Object.assign(process.env, {
    ENABLE_GOOGLE_DRIVE: 'false', LOCAL_LIBRARY_DIR: library,
    DATA_DIR: root,
    MANUAL_CATEGORIAS_PATH: path.join(root, 'categorias.json'),
    DRIVE_FOLDERS_CONFIG: path.join(root, 'drive-folders.json'), COVER_CACHE_DIR: path.join(root, 'covers'),
    APP_ACCESS_SECRET: 'segredo-forte-de-teste', METADATA_ENRICH_CONCURRENCY: '0'
  });

  const { createApp } = await import('../server/app.js');
  const app = await createApp();
  const setup = await request(app).post('/api/setup').send({ language: 'pt-BR', theme: 'dark', admin: { username: 'admin', password: 'segredo-forte-de-teste' }, profile: { name: 'Principal' } });
  assert.equal(setup.status, 201);
  const system = await request(app).get('/api/system/status');
  assert.equal(system.status, 200);
  assert.deepEqual(system.body.publicSettings, { language: 'pt-BR', theme: 'dark', libraryName: 'Araru' });
  const denied = await request(app).get('/api/livros');
  assert.equal(denied.status, 401);
  const hiddenDetails = await request(app).get('/api/health/details');
  assert.equal(hiddenDetails.status, 401);

  const login = await request(app).post('/api/access/login').send({ username: 'admin', password: 'segredo-forte-de-teste' });
  assert.equal(login.status, 200);
  assert.match(login.headers['set-cookie'][0], /araru_session=.*HttpOnly/);

  const allowed = await request(app).get('/api/livros').set('Cookie', login.headers['set-cookie']);
  assert.equal(allowed.status, 200);

  const saved = await request(app).put('/api/reading-state').set('Cookie', login.headers['set-cookie']).send({
    favorites: ['livro-1'], history: [], progress: { 'livro-1': { page: 7, updatedAt: 20 } }, stats: {}, clientUpdatedAt: 20
  });
  assert.equal(saved.status, 200);
  const restored = await request(app).get('/api/reading-state').set('Cookie', login.headers['set-cookie']);
  assert.deepEqual(restored.body.data.favorites, ['livro-1']);
  assert.equal(restored.body.data.progress['livro-1'].page, 7);
  const overview = await request(app).get('/api/admin/overview').set('Cookie', login.headers['set-cookie']);
  assert.equal(overview.status, 200);
  assert.equal(overview.body.data.users, 1);
  const createdUser = await request(app).post('/api/access/users').set('Cookie', login.headers['set-cookie']).send({ username: 'reader', displayName: 'Reader', password: 'senha-segura-reader', role: 'user' });
  assert.equal(createdUser.status, 201);
  const createdProfile = await request(app).post('/api/profiles').set('Cookie', login.headers['set-cookie']).send({ name: 'Estudos', userIds: [createdUser.body.data.id] });
  assert.equal(createdProfile.status, 201);
  const savedSettings = await request(app).put('/api/settings/general').set('Cookie', login.headers['set-cookie']).send({ libraryName: 'Araru Teste', language: 'en', theme: 'light', timezone: 'America/Sao_Paulo', dateFormat: 'locale' });
  assert.equal(savedSettings.status, 200);
  const loadedSettings = await request(app).get('/api/settings/general').set('Cookie', login.headers['set-cookie']);
  assert.equal(loadedSettings.body.data.libraryName, 'Araru Teste');
  assert.equal(loadedSettings.body.data.language, 'en');
  const protectedAdmin = await request(app).patch(`/api/access/users/${setup.body.userId}`).set('Cookie', login.headers['set-cookie']).send({ role: 'user' });
  assert.equal(protectedAdmin.status, 409);
  const readerLogin = await request(app).post('/api/access/login').send({ username: 'reader', password: 'senha-segura-reader' });
  assert.equal(readerLogin.status, 200);
  assert.ok(readerLogin.body.profiles.some((profile) => profile.id === createdProfile.body.data.id));
  const forbiddenAdmin = await request(app).get('/api/admin/overview').set('Cookie', readerLogin.headers['set-cookie']);
  assert.equal(forbiddenAdmin.status, 403);
  const forbiddenSettings = await request(app).put('/api/settings/general').set('Cookie', readerLogin.headers['set-cookie']).send({ libraryName: 'Inválido' });
  assert.equal(forbiddenSettings.status, 403);
  const audit = await request(app).get('/api/admin/audit').set('Cookie', login.headers['set-cookie']);
  assert.equal(audit.status, 200);
  assert.ok(audit.body.data.some((entry) => entry.action === 'USER_CREATED'));
  assert.ok(audit.body.data.some((entry) => entry.action === 'PROFILE_CREATED'));
  await request(app).delete(`/api/profiles/${createdProfile.body.data.id}`).set('Cookie', login.headers['set-cookie']);
  const changed = await request(app).post('/api/access/change-password').set('Cookie', login.headers['set-cookie']).send({ password: 'nova-senha-segura' });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.user.mustChangePassword, false);
  await assert.rejects(access(path.join(root, '.araru-admin-bootstrap.json')), { code: 'ENOENT' });
  const { query } = await import('../server/database/postgres.js');
  await query("DELETE FROM users WHERE username IN ('admin','reader')");
  await query("DELETE FROM system_settings WHERE key IN ('setup.completed','general')");
  delete process.env.APP_ACCESS_SECRET;
  await rm(root, { recursive: true, force: true });
});
