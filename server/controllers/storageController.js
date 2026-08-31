import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { query } from '../database/postgres.js';
import { getStorageProvider } from '../storage/index.js';

function r2() { return getStorageProvider('r2'); }
function safeName(value) { return path.posix.basename(String(value || 'upload.bin')).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180) || 'upload.bin'; }
async function requireR2Binding(libraryId, librarySourceId) {
  const result = await query(`SELECT ls.library_id AS "libraryId",ls.id AS "librarySourceId"
    FROM library_sources ls JOIN storage_connections sc ON sc.id=ls.connection_id
    WHERE ls.id=$1 AND ls.library_id=$2 AND ls.enabled=TRUE AND sc.provider='cloudflare_r2' AND sc.enabled=TRUE`, [librarySourceId, libraryId]);
  if (!result.rows[0]) throw Object.assign(new Error('Library e source R2 ativas são obrigatórias.'), { statusCode: 422, code: 'R2_LIBRARY_SOURCE_REQUIRED' });
  return result.rows[0];
}

export async function createR2UploadUrl(req, res, next) {
  try {
    const provider = r2();
    const libraryId = String(req.body?.libraryId || '');
    const librarySourceId = String(req.body?.librarySourceId || '');
    await requireR2Binding(libraryId, librarySourceId);
    const filename = safeName(req.body?.filename);
    const key = `uploads/${randomUUID()}/${filename}`;
    const url = await provider.signedUploadUrl(key, { contentType: req.body?.contentType || 'application/octet-stream' });
    return res.status(201).json({ data: { key, url, expiresIn: provider.signedUrlTtl, provider: 'r2', libraryId, librarySourceId } });
  } catch (error) { return next(error); }
}

export async function completeR2Upload(req, res, next) {
  try {
    const provider = r2();
    const key = String(req.body?.key || '');
    if (!key.startsWith('uploads/')) return res.status(400).json({ message: 'Chave de upload inválida.' });
    const libraryId = String(req.body?.libraryId || '');
    const librarySourceId = String(req.body?.librarySourceId || '');
    await requireR2Binding(libraryId, librarySourceId);
    const object = await provider.stat(key);
    const filename = safeName(req.body?.filename || path.posix.basename(key));
    const id = `r2-${Buffer.from(key).toString('base64url')}`;
    const formato = path.extname(filename).slice(1).toLowerCase();
    await query(`INSERT INTO library_files(id,source,source_id,library_id,library_source_id,filename,extension,format,size,mtime,fingerprint,status,payload,storage_provider,storage_key,provider_file_id,mime_type,etag,checksum)
      VALUES($1,'r2',$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11::jsonb,'r2',$2,$2,$12,$13,$14)
      ON CONFLICT(id) DO UPDATE SET library_id=EXCLUDED.library_id,library_source_id=EXCLUDED.library_source_id,size=EXCLUDED.size,mtime=EXCLUDED.mtime,fingerprint=EXCLUDED.fingerprint,payload=EXCLUDED.payload,etag=EXCLUDED.etag,checksum=EXCLUDED.checksum,status='active'`,
      [id, key, libraryId, librarySourceId, filename, path.extname(filename) || '', formato, object.size, object.modifiedAt, object.etag || `${object.size}`, JSON.stringify({ id, source: 'r2', fonte: 'r2', libraryId, librarySourceId, storageProvider: 'r2', storageKey: key, sourceId: key, nome: path.basename(filename, path.extname(filename)), formato, fileSize: object.size, fileFingerprint: object.etag || `${object.size}`, mimeType: object.mimeType }), object.mimeType, object.etag || null, object.checksum || null]);
    return res.status(201).json({ data: { id, key, size: object.size, format: formato, provider: 'r2' } });
  } catch (error) { return next(error); }
}
