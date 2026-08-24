import assert from 'node:assert/strict';
import test from 'node:test';
import { migratePostgres } from '../server/database/postgresMigrations.js';
import { query } from '../server/database/postgres.js';

test('aplica a fundação PostgreSQL de forma idempotente', async () => {
  await migratePostgres();
  await migratePostgres();
  const migration = await query("SELECT version,name FROM schema_migrations WHERE version=1");
  const tables = await query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1::text[])", [[
    'users', 'profiles', 'library_files', 'livros', 'reading_state',
    'background_jobs', 'secure_credentials', 'source_sync_state', 'backup_history', 'admin_audit_log'
  ]]);
  assert.deepEqual(migration.rows[0], { version: 1, name: 'postgres-foundation' });
  assert.equal(tables.rowCount, 10);
});

test('schema PostgreSQL possui busca textual e JSONB nativos', async () => {
  const columns = await query("SELECT table_name,column_name,data_type,udt_name FROM information_schema.columns WHERE table_schema='public' AND ((table_name='library_files' AND column_name IN ('search_vector','category_path','payload')) OR (table_name='livros' AND column_name IN ('autor','tags','metadados_completos')))");
  const types = new Map(columns.rows.map((row) => [`${row.table_name}.${row.column_name}`, row.udt_name]));
  assert.equal(types.get('library_files.search_vector'), 'tsvector');
  assert.equal(types.get('library_files.category_path'), 'jsonb');
  assert.equal(types.get('livros.metadados_completos'), 'jsonb');
});
