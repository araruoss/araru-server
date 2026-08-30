import { query } from '../database/postgres.js';

export async function buscarArquivos(termo, { limit = 100 } = {}) {
  const normalized = String(termo || '').trim();
  if (!normalized) return [];
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
  const { rows } = await query(`
    SELECT id, ts_rank_cd(search_vector, websearch_to_tsquery('simple', unaccent($1))) AS rank
    FROM library_files
    WHERE status = 'active' AND search_vector @@ websearch_to_tsquery('simple', unaccent($1))
    ORDER BY rank DESC, filename ASC
    LIMIT $2`, [normalized, safeLimit]);
  return rows.map((row) => row.id);
}
