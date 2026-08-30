import { createReadStream } from 'node:fs';
import { lstat, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { StorageError, normalizeRange, providerCapabilities } from './storageProvider.js';

export class LocalStorageProvider {
  constructor(root) { this.root = path.resolve(root); this.type = 'local'; this.capabilities = providerCapabilities({ list: true, write: true, delete: true, move: true, watch: true }); }
  resolve(key) { const resolved = path.resolve(this.root, key || '.'); if (resolved !== this.root && !resolved.startsWith(`${this.root}${path.sep}`)) throw new StorageError('Chave de storage inválida.', { code: 'INVALID_STORAGE_KEY', statusCode: 400 }); return resolved; }
  async stat(key) { try { const info = await stat(this.resolve(key)); return { key, size: info.size, modifiedAt: info.mtime, mimeType: null, etag: `"${info.size}-${Math.floor(info.mtimeMs)}"` }; } catch (error) { if (error.code === 'ENOENT') throw new StorageError('Objeto não encontrado.', { code: 'OBJECT_NOT_FOUND', statusCode: 404 }); throw error; } }
  async exists(key) { try { await lstat(this.resolve(key)); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
  async stream(key, range, _metadata = {}, { signal } = {}) { const info = await this.stat(key); const selected = normalizeRange(range, info.size); return { ...info, range: selected, stream: createReadStream(this.resolve(key), { ...(selected ? { start: selected.start, end: selected.end } : {}), ...(signal ? { signal } : {}) }) }; }
  async list(prefix = '') { const root = this.resolve(prefix); const output = []; const visit = async (directory, relative) => { for (const entry of await readdir(directory, { withFileTypes: true })) { const key = path.posix.join(relative, entry.name); const file = path.join(directory, entry.name); if (entry.isDirectory()) await visit(file, key); else if (entry.isFile()) output.push({ key, ...(await this.stat(key)) }); } }; await visit(root, prefix.replace(/\\/g, '/').replace(/^\//, '')); return output; }
  async delete(key) { const { rm } = await import('node:fs/promises'); await rm(this.resolve(key), { force: true }); }
}
