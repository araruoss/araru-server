import assert from 'node:assert/strict';
import test from 'node:test';

test('criptografa OAuth e persiste cursor incremental no PostgreSQL', async () => {
  Object.assign(process.env, {
    APP_ACCESS_SECRET: 'segredo-de-teste-com-entropia-suficiente',
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    ENABLE_GOOGLE_DRIVE: 'false'
  });
  const { migratePostgres } = await import('../server/database/postgresMigrations.js');
  const { query } = await import('../server/database/postgres.js');
  const service = await import('../server/services/drivePersistenceService.js');
  const config = await import('../server/config/drive.js');
  await migratePostgres();
  await query("DELETE FROM secure_credentials WHERE provider='google-drive'");
  await query("DELETE FROM source_sync_state WHERE source='drive-test'");

  await service.salvarCredenciaisOAuth({ access_token: 'access-secret', refresh_token: 'refresh-secret', expiry_date: 123 });
  const { rows } = await query("SELECT encrypted_payload FROM secure_credentials WHERE provider='google-drive'");
  assert.ok(rows[0].encrypted_payload);
  assert.equal(rows[0].encrypted_payload.includes('access-secret'), false);
  assert.equal(rows[0].encrypted_payload.includes('refresh-secret'), false);

  config.oauth2Client.setCredentials({});
  const restored = await service.carregarCredenciaisOAuth();
  assert.equal(restored.refresh_token, 'refresh-secret');
  assert.equal(config.oauth2Client.credentials.access_token, 'access-secret');

  await service.salvarEstadoSincronizacao('drive-test', { cursor: 'token-42', mode: 'incremental' });
  const state = await service.obterEstadoSincronizacao('drive-test');
  assert.equal(state.cursor, 'token-42');
  assert.equal(state.mode, 'incremental');
  assert.ok(state.lastSyncAt);

  await service.removerCredenciaisOAuth();
  assert.equal(await service.carregarCredenciaisOAuth(), null);
  await query("DELETE FROM source_sync_state WHERE source='drive-test'");
});
