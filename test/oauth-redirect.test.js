import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('callback OAuth permanece no backend e redireciona para o frontend configurado', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'araru-oauth-'));
  Object.assign(process.env, {
    FRONTEND_URL: 'https://biblioteca.example.com',
    GOOGLE_REDIRECT_URI: 'https://api.biblioteca.example.com/api/v1/auth/callback',
    APP_ACCESS_SECRET: 'oauth-test-secret',
    ENABLE_GOOGLE_DRIVE: 'false'
  });

  const { env, oauth2Client } = await import('../server/config/drive.js');
  const { finalizarLogin } = await import('../server/controllers/authController.js');
  const originalGetToken = oauth2Client.getToken;
  oauth2Client.getToken = async (code) => ({ tokens: { access_token: `token-${code}`, refresh_token: 'refresh-token' } });
  let redirect = '';
  let forwardedError = null;

  try {
    await finalizarLogin(
      { query: { code: 'codigo' } },
      { redirect(value) { redirect = value; return this; }, status() { return this; }, json() { return this; } },
      (error) => { forwardedError = error; }
    );
    assert.equal(forwardedError, null);
  assert.equal(env.googleRedirectUri, 'https://api.biblioteca.example.com/api/v1/auth/callback');
    assert.equal(redirect, 'https://biblioteca.example.com/?auth=success');
  } finally {
    oauth2Client.getToken = originalGetToken;
    await rm(directory, { recursive: true, force: true });
  }
});
