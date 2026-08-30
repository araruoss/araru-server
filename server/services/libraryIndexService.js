import path from 'node:path';
import { env } from '../config/drive.js';
import { query, withTransaction } from '../database/postgres.js';
import { sincronizarObras } from './workService.js';

const relativePathOf = (book) => book.source === 'local' && book.filePath ? path.relative(env.localLibraryDir, book.filePath) : '';
const timestampOf = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const date = typeof value === 'number' || /^\d+$/.test(String(value)) ? new Date(Number(value)) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
export async function listarLivrosIndexados() { const { rows } = await query("SELECT payload FROM library_files WHERE status='active' ORDER BY LOWER(filename)"); return rows.map((row) => row.payload).filter(Boolean); }
export async function sincronizarIndiceLivros(livros, { reconciledSources = [] } = {}) {
  const seen = new Map();
  for (const book of livros) {
    const source = book.source || book.fonte || 'unknown';
    if (!seen.has(source)) seen.set(source, new Set());
    seen.get(source).add(book.id);
  }
  await withTransaction(async (client) => {
    for (const book of livros) {
      const source = book.source || book.fonte || 'unknown';
      const providerId = book.providerFileId || book.driveId || book.sourceId || book.id;
      await client.query(`INSERT INTO library_files(id,source,source_id,relative_path,filename,extension,format,size,mtime,fingerprint,category_path,status,payload,storage_provider,storage_key,provider_file_id,mime_type,etag,checksum,content_hash,pipeline_status,pipeline_stage,indexed_at,last_seen_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,'active',$12::jsonb,$13,$14,$15,$16,$17,$18,$19,'indexed','indexing',NOW(),NOW())
        ON CONFLICT(id) DO UPDATE SET source=EXCLUDED.source,source_id=EXCLUDED.source_id,relative_path=EXCLUDED.relative_path,filename=EXCLUDED.filename,extension=EXCLUDED.extension,format=EXCLUDED.format,size=EXCLUDED.size,mtime=EXCLUDED.mtime,fingerprint=EXCLUDED.fingerprint,category_path=EXCLUDED.category_path,status='active',payload=EXCLUDED.payload,storage_provider=EXCLUDED.storage_provider,storage_key=EXCLUDED.storage_key,provider_file_id=EXCLUDED.provider_file_id,mime_type=EXCLUDED.mime_type,etag=EXCLUDED.etag,checksum=EXCLUDED.checksum,content_hash=EXCLUDED.content_hash,pipeline_status='indexed',pipeline_stage='indexing',pipeline_error_code=NULL,pipeline_error=NULL,indexed_at=NOW(),last_seen_at=NOW()`,
        [book.id, source, book.sourceId || book.driveId || book.id, relativePathOf(book), book.nome || 'Sem título', path.extname(book.filePath || book.storageKey || '') || `.${book.formato || ''}`, book.formato || '', Number(book.fileSize || 0), timestampOf(book.fileMtime || book.modifiedTime), book.fileFingerprint || '', JSON.stringify(book.categoryPath || []), JSON.stringify(book), book.storageProvider || source, book.storageKey || relativePathOf(book) || book.driveId || book.sourceId || book.id, providerId, book.mimeType || null, book.etag || null, book.checksum || null, book.contentHash || null]);
    }
    for (const source of reconciledSources) {
      const ids = [...(seen.get(source) || [])];
      await client.query(ids.length ? `UPDATE library_files SET status='missing' WHERE source=$1 AND status='active' AND NOT (id = ANY($2::text[]))` : `UPDATE library_files SET status='missing' WHERE source=$1 AND status='active'`, ids.length ? [source, ids] : [source]);
    }
  });
  await sincronizarObras();
}
export async function atualizarMetadadosBusca(id, metadata = {}) {
  const { rows } = await query("SELECT filename,relative_path,category_path FROM library_files WHERE id=$1 AND status='active'", [id]);
  if (!rows[0]) return false;
  const authors = Array.isArray(metadata.autor) ? metadata.autor.join(' ') : String(metadata.autor || '');
  const tags = Array.isArray(metadata.tags) ? metadata.tags.join(' ') : String(metadata.tags || '');
  const primary = [metadata.nome || rows[0].filename, authors].filter(Boolean).join(' ');
  const identifiers = [metadata.editora, metadata.isbn, metadata.isbn10, metadata.isbn13, tags].filter(Boolean).join(' ');
  const context = [metadata.descricao, rows[0].relative_path, JSON.stringify(rows[0].category_path || [])].filter(Boolean).join(' ');
  await query(`UPDATE library_files SET search_vector =
    setweight(to_tsvector('simple', unaccent($2)), 'A') ||
    setweight(to_tsvector('simple', unaccent($3)), 'B') ||
    setweight(to_tsvector('simple', unaccent($4)), 'C'), last_seen_at=NOW() WHERE id=$1`, [id, primary, identifiers, context]);
  return true;
}
export async function buscarIdsIndexados(termo) { if(!String(termo||'').trim())return []; const {rows}=await query("SELECT id FROM library_files WHERE status='active' AND search_vector @@ websearch_to_tsquery('simple',unaccent($1)) ORDER BY ts_rank_cd(search_vector,websearch_to_tsquery('simple',unaccent($1))) DESC",[termo]); return rows.map((row)=>row.id); }
export async function removerItensAusentesExpirados() { const {rowCount}=await query("DELETE FROM library_files WHERE status='missing' AND last_seen_at < NOW() - ($1 * INTERVAL '1 day')",[Math.max(1,env.catalogMissingRetentionDays)]); return rowCount; }
export async function obterResumoIndice() { const {rows}=await query('SELECT source,status,COUNT(*)::int AS total FROM library_files GROUP BY source,status'); return rows; }
