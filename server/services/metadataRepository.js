import { query } from '../database/postgres.js';

const json = (value, fallback) => value ?? fallback;
const mapBook = (row) => row ? ({
  ...row, drive_id: row.drive_id, autor: json(row.autor, []), tags: json(row.tags, []), subcategorias: json(row.subcategorias, []),
  capa: row.capa_url || '', capaCor: row.capa_cor || '', numeroPaginas: row.numero_paginas ?? null,
  linkDrive: row.link_drive || '', previewUrl: row.preview_url || row.link_drive || '', filePath: row.file_path || '',
  dataAdicao: row.data_adicao || row.created_at || null, ultimaLeitura: row.ultima_leitura || null,
  metadadosCompletos: json(row.metadados_completos, {}), metadataProvenance: json(row.metadata_provenance, {}),
  manualFields: json(row.manual_fields, []), candidateMatches: json(row.candidate_matches, []), categoryPath: json(row.category_path, []),
  normalizedTitle: row.normalized_title || '', normalizedAuthor: row.normalized_author || '', metadataStatus: row.metadata_status,
  metadataConfidence: Number(row.metadata_confidence || 0), metadataSource: row.metadata_source || '',
  metadataLastChecked: row.metadata_last_checked || null, coverSource: row.cover_source || '', needsReview: Boolean(row.needs_review),
  enrichmentAttempts: Number(row.enrichment_attempts || 0), enrichmentError: row.enrichment_error || '',
  fileSize: Number(row.file_size || 0), fileMtime: row.file_mtime || '', fileFingerprint: row.file_fingerprint || '',
  coverPath: row.cover_path || '', coverGeneratedAt: row.cover_generated_at || null, coverFingerprint: row.cover_fingerprint || ''
}) : null;

export async function findBook(id) { const { rows } = await query('SELECT * FROM livros WHERE id = $1 LIMIT 1', [id]); return mapBook(rows[0]); }
export async function findBookByIsbn(isbn) { const { rows } = await query('SELECT * FROM livros WHERE isbn = $1 OR isbn10 = $1 OR isbn13 = $1 LIMIT 1', [isbn]); return mapBook(rows[0]); }
export async function listBooksForReview() { const { rows } = await query('SELECT * FROM livros WHERE needs_review = TRUE ORDER BY metadata_confidence ASC, updated_at DESC'); return rows.map(mapBook); }
export async function listBooks() { const { rows } = await query('SELECT * FROM livros ORDER BY COALESCE(ano, 0) DESC, nome ASC'); return rows.map(mapBook); }
export async function bookExists(id) { const { rows } = await query('SELECT 1 FROM livros WHERE id = $1', [id]); return Boolean(rows[0]); }

export async function saveBook(book) {
  const values = [book.id, book.drive_id || book.driveId || null, book.nome || '', book.categoria || '', JSON.stringify(book.subcategorias || []), JSON.stringify(Array.isArray(book.autor) ? book.autor : book.autor ? [book.autor] : []), book.editora || '', book.ano || null, book.isbn || '', book.isbn10 || null, book.isbn13 || null, book.descricao || '', book.capa || '', book.capaCor || '', book.avaliacao || null, book.numeroPaginas || null, book.idioma || '', book.linkDrive || '', book.previewUrl || '', book.fonte || 'local', book.filePath || '', book.dataAdicao || new Date().toISOString(), book.ultimaLeitura || null, Boolean(book.favorito), JSON.stringify(book.tags || []), JSON.stringify(book.metadadosCompletos || {}), book.normalizedTitle || null, book.normalizedAuthor || null, book.metadataStatus || 'pending', Number(book.metadataConfidence || 0), book.metadataSource || '', JSON.stringify(book.metadataProvenance || {}), book.metadataLastChecked || null, book.coverSource || '', book.originalFilename || '', JSON.stringify(book.manualFields || []), Boolean(book.needsReview), Number(book.enrichmentAttempts || 0), book.enrichmentError || null, JSON.stringify(book.candidateMatches || []), Number(book.fileSize || 0), String(book.fileMtime || ''), book.fileFingerprint || '', book.coverPath || '', book.coverGeneratedAt || null, book.coverFingerprint || '', JSON.stringify(book.categoryPath || [])];
  await query(`INSERT INTO livros(id,drive_id,nome,categoria,subcategorias,autor,editora,ano,isbn,isbn10,isbn13,descricao,capa_url,capa_cor,avaliacao,numero_paginas,idioma,link_drive,preview_url,fonte,file_path,data_adicao,ultima_leitura,favorito,tags,metadados_completos,normalized_title,normalized_author,metadata_status,metadata_confidence,metadata_source,metadata_provenance,metadata_last_checked,cover_source,original_filename,manual_fields,needs_review,enrichment_attempts,enrichment_error,candidate_matches,file_size,file_mtime,file_fingerprint,cover_path,cover_generated_at,cover_fingerprint,category_path) VALUES (${values.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT(id) DO UPDATE SET nome=EXCLUDED.nome,categoria=EXCLUDED.categoria,subcategorias=EXCLUDED.subcategorias::jsonb,autor=EXCLUDED.autor::jsonb,editora=EXCLUDED.editora,ano=EXCLUDED.ano,isbn=EXCLUDED.isbn,isbn10=EXCLUDED.isbn10,isbn13=EXCLUDED.isbn13,descricao=EXCLUDED.descricao,capa_url=EXCLUDED.capa_url,capa_cor=EXCLUDED.capa_cor,numero_paginas=EXCLUDED.numero_paginas,tags=EXCLUDED.tags::jsonb,metadados_completos=EXCLUDED.metadados_completos::jsonb,metadata_status=EXCLUDED.metadata_status,metadata_confidence=EXCLUDED.metadata_confidence,metadata_source=EXCLUDED.metadata_source,metadata_provenance=EXCLUDED.metadata_provenance::jsonb,needs_review=EXCLUDED.needs_review,updated_at=NOW()`, values);
  return findBook(book.id);
}

export async function updateManualBook(id, patch) { const current = await findBook(id); if (!current) return null; return saveBook({ ...current, ...patch, id, metadataStatus: 'completed', metadataSource: 'manual', needsReview: false, metadataLastChecked: new Date().toISOString() }); }
export async function updateLastRead(id, timestamp = new Date().toISOString()) { const { rows } = await query('UPDATE livros SET ultima_leitura=$1,updated_at=NOW() WHERE id=$2 RETURNING *', [timestamp, id]); return mapBook(rows[0]); }
export async function listCategories() { const { rows } = await query('SELECT nome,icone,cor FROM categorias ORDER BY LOWER(nome)'); return rows; }
export async function upsertCategory(nome, icone = '', cor = '') { await query('INSERT INTO categorias(nome,icone,cor) VALUES($1,$2,$3) ON CONFLICT(nome) DO UPDATE SET icone=EXCLUDED.icone,cor=EXCLUDED.cor', [nome, icone, cor]); }
export { mapBook };
