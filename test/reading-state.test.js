import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { migratePostgres } from '../server/database/postgresMigrations.js';
import { query } from '../server/database/postgres.js';
import { obterEstadoLeitura, salvarEstadoLeitura } from '../server/services/readingStateService.js';

test('persiste favoritos, histórico, progresso e estatísticas no PostgreSQL', async () => {
  await migratePostgres();
  const profileId = `reading-test-${randomUUID()}`;
  await query('INSERT INTO profiles(id,name) VALUES($1,$2)', [profileId, 'Teste de leitura']);
  try {
    await salvarEstadoLeitura({ favorites: ['a'], history: [{ id: 'a' }], progress: { a: { page: 4 } }, stats: { openedBookIds: ['a'] }, clientUpdatedAt: 10 }, profileId);
    const state = await obterEstadoLeitura(profileId);
    assert.deepEqual(state.favorites, ['a']);
    assert.equal(state.progress.a.page, 4);
    assert.equal(state.clientUpdatedAt, 10);
  } finally {
    await query('DELETE FROM profiles WHERE id=$1', [profileId]);
  }
});
