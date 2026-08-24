import { createHash } from 'node:crypto';
import { query, withTransaction } from '../database/postgres.js';
import { isbnForms } from './metadata/isbn.js';

const parse = (value, fallback = {}) => { if (value && typeof value === 'object') return value; try { return JSON.parse(value); } catch { return fallback; } };
function workId(fileId, metadata = {}) { const forms = isbnForms(metadata.isbn13 || metadata.isbn10 || metadata.isbn); const isbn = forms.isbn13 || forms.isbn10; return { id: isbn ? `isbn-${isbn}` : `file-${createHash('sha256').update(fileId).digest('hex').slice(0, 24)}`, forms }; }

export async function sincronizarObraArquivo(fileId, metadata = {}) {
  const { rows } = await query("SELECT id, filename, format, source, payload FROM library_files WHERE id = $1 AND status = 'active'", [fileId]);
  const file = rows[0]; if (!file) return null;
  const payload = parse(file.payload); const { id, forms } = workId(fileId, metadata); const title = metadata.nome || file.filename || 'Sem título'; const authors = Array.isArray(metadata.autor) ? metadata.autor : (metadata.autor ? [metadata.autor] : []);
  await withTransaction(async (client) => {
    await client.query(`INSERT INTO works(id, canonical_title, authors, isbn10, isbn13, publisher, description, cover_file_id, updated_at) VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,NOW()) ON CONFLICT(id) DO UPDATE SET canonical_title=EXCLUDED.canonical_title, authors=EXCLUDED.authors, publisher=EXCLUDED.publisher, description=EXCLUDED.description, cover_file_id=COALESCE(works.cover_file_id, EXCLUDED.cover_file_id), updated_at=NOW()`, [id, title, JSON.stringify(authors), forms.isbn10 || null, forms.isbn13 || null, metadata.editora || '', metadata.descricao || '', fileId]);
    await client.query(`INSERT INTO work_files(work_id,file_id,format,source,is_primary) VALUES ($1,$2,$3,$4,TRUE) ON CONFLICT(file_id) DO UPDATE SET work_id=EXCLUDED.work_id, format=EXCLUDED.format, source=EXCLUDED.source`, [id, fileId, file.format || payload.formato || '', file.source || payload.fonte || '']);
    await client.query('DELETE FROM works WHERE id NOT IN (SELECT DISTINCT work_id FROM work_files)');
  });
  return id;
}

export async function sincronizarObras() {
  const { rows } = await query(`SELECT f.id,f.payload,l.nome,l.autor,l.editora,l.descricao,l.isbn,l.isbn10,l.isbn13,l.tags
    FROM library_files f LEFT JOIN livros l ON l.id=f.id WHERE f.status='active'`);
  for (const row of rows) {
    const payload = parse(row.payload);
    const persisted = row.nome ? { nome:row.nome, autor:parse(row.autor,[]), editora:row.editora, descricao:row.descricao, isbn:row.isbn, isbn10:row.isbn10, isbn13:row.isbn13, tags:parse(row.tags,[]) } : {};
    await sincronizarObraArquivo(row.id, { ...payload, ...persisted });
  }
  await query("DELETE FROM work_files WHERE file_id NOT IN (SELECT id FROM library_files WHERE status='active')");
  await query('DELETE FROM works WHERE id NOT IN (SELECT DISTINCT work_id FROM work_files)');
  return rows.length;
}
export async function listarObras() { const { rows } = await query('SELECT w.*, COUNT(wf.file_id)::int AS "fileCount" FROM works w LEFT JOIN work_files wf ON wf.work_id=w.id GROUP BY w.id ORDER BY LOWER(w.canonical_title)'); return rows.map((row) => ({ ...row, authors: parse(row.authors, []) })); }
export async function obterObra(id) { const { rows: works } = await query('SELECT * FROM works WHERE id=$1', [id]); const work = works[0]; if (!work) return null; const { rows: files } = await query('SELECT wf.*, f.payload FROM work_files wf JOIN library_files f ON f.id=wf.file_id WHERE wf.work_id=$1 ORDER BY wf.is_primary DESC, wf.format', [id]); return { ...work, authors: parse(work.authors, []), files: files.map((row) => ({ ...parse(row.payload), workId: row.work_id, isPrimary: row.is_primary })) }; }
export async function agruparCatalogoPorObra(livros, preferredFormats = ['epub', 'mobi', 'pdf', 'cbz', 'cbr']) { const byId = new Map(livros.map((livro) => [livro.id, livro])); const { rows } = await query("SELECT wf.work_id AS \"workId\", wf.file_id AS \"fileId\", wf.format, wf.source, wf.is_primary AS \"isPrimary\" FROM work_files wf JOIN library_files f ON f.id=wf.file_id WHERE f.status='active' ORDER BY wf.work_id"); const grouped = new Map(); for (const row of rows) { const livro=byId.get(row.fileId); if (!livro) continue; if (!grouped.has(row.workId)) grouped.set(row.workId, []); grouped.get(row.workId).push({ ...livro, workId: row.workId, isPrimary: row.isPrimary }); } const consumed=new Set(), result=[]; for (const [id,files] of grouped) { const rank=(file)=>{const index=preferredFormats.indexOf(String(file.formato||'').toLowerCase());return index<0?999:index;}; files.sort((a,b)=>rank(a)-rank(b)||Number(b.fileSize||0)-Number(a.fileSize||0)); result.push({...files[0],workId:id,files,availableFormats:[...new Set(files.map((file)=>String(file.formato||'').toLowerCase()))]}); files.forEach((file)=>consumed.add(file.id)); } for (const livro of livros) if(!consumed.has(livro.id)) result.push(livro); return result; }
