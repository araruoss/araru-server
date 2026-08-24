import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { closePostgres, query, withTransaction } from '../server/database/postgres.js';
import { migratePostgres } from '../server/database/postgresMigrations.js';

const total = Math.max(1, Number(process.env.BENCHMARK_BOOKS || 10000));
const runId = `benchmark-${randomUUID()}`;
const heapBefore = process.memoryUsage().heapUsed;

try {
  await migratePostgres();
  const startedIndex = performance.now();
  await withTransaction(async (client) => {
    for (let offset = 0; offset < total; offset += 500) {
      const count = Math.min(500, total - offset);
      const values = [];
      const placeholders = [];
      for (let index = 0; index < count; index += 1) {
        const number = offset + index;
        const position = values.length;
        values.push(
          `${runId}-${number}`, runId, String(number), `Livro técnico de Java ${number}`,
          '.pdf', 'pdf', `benchmark-${number}`, JSON.stringify(['Livros Técnicos', 'Tecnologia', 'Java']),
          JSON.stringify({ id: `${runId}-${number}`, nome: `Livro técnico de Java ${number}` })
        );
        placeholders.push(`($${position + 1},$${position + 2},$${position + 3},$${position + 4},$${position + 5},$${position + 6},$${position + 7},$${position + 8}::jsonb,$${position + 9}::jsonb)`);
      }
      await client.query(`INSERT INTO library_files
        (id,source,source_id,filename,extension,format,fingerprint,category_path,payload)
        VALUES ${placeholders.join(',')}`, values);
    }
  });
  const indexMs = performance.now() - startedIndex;

  const startedSearch = performance.now();
  const result = await query(`SELECT id FROM library_files
    WHERE source=$1 AND search_vector @@ websearch_to_tsquery('simple',$2)
    ORDER BY ts_rank_cd(search_vector,websearch_to_tsquery('simple',$2)) DESC LIMIT 50`, [runId, 'tecnico java']);
  const searchMs = performance.now() - startedSearch;

  const startedCachedSearch = performance.now();
  for (let index = 0; index < 20; index += 1) {
    await query(`SELECT id FROM library_files WHERE source=$1
      AND search_vector @@ websearch_to_tsquery('simple',$2) LIMIT 50`, [runId, 'tecnico java']);
  }
  const cachedSearchMs = (performance.now() - startedCachedSearch) / 20;
  const heapDelta = process.memoryUsage().heapUsed - heapBefore;
  const report = {
    engine: 'postgresql', books: total, indexedInMs: Math.round(indexMs),
    searchInMs: Number(searchMs.toFixed(2)), cachedSearchAvgMs: Number(cachedSearchMs.toFixed(2)),
    heapDeltaMb: Number((heapDelta / 1024 / 1024).toFixed(2)), results: result.rowCount
  };
  console.log(JSON.stringify(report));
  if (indexMs > 60000 || searchMs > 1500 || heapDelta > 256 * 1024 * 1024 || result.rowCount === 0) process.exitCode = 1;
} finally {
  await query('DELETE FROM library_files WHERE source=$1', [runId]).catch(() => {});
  await closePostgres();
}
