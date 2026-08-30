export class StorageError extends Error {
  constructor(message, { code = 'STORAGE_ERROR', statusCode = 502, cause } = {}) {
    super(message, { cause });
    this.name = 'StorageError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function normalizeRange(range, size) {
  if (!range) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(range));
  if (!match) throw new StorageError('Range inválido.', { code: 'RANGE_NOT_SATISFIABLE', statusCode: 416 });
  const suffix = !match[1] && Boolean(match[2]);
  let start = suffix ? Math.max(0, size - Number(match[2])) : Number(match[1] || 0);
  let end = suffix || !match[2] ? size - 1 : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    throw new StorageError('Range fora do arquivo.', { code: 'RANGE_NOT_SATISFIABLE', statusCode: 416 });
  }
  end = Math.min(end, size - 1);
  return { start, end, length: end - start + 1 };
}

export function providerCapabilities(extra = {}) {
  return { stat: true, stream: true, range: true, list: false, write: false, delete: false, signedRead: false, signedUpload: false, multipart: false, ...extra };
}
