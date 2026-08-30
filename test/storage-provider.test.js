import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { LocalStorageProvider } from '../server/storage/localStorageProvider.js';
import { R2StorageProvider } from '../server/storage/r2StorageProvider.js';
import { GoogleDriveStorageProvider } from '../server/storage/googleDriveStorageProvider.js';
import { normalizeRange } from '../server/storage/storageProvider.js';

test('normaliza ranges normais, abertos e sufixo', () => {
  assert.deepEqual(normalizeRange('bytes=0-7', 100), { start: 0, end: 7, length: 8 });
  assert.deepEqual(normalizeRange('bytes=8-', 100), { start: 8, end: 99, length: 92 });
  assert.deepEqual(normalizeRange('bytes=-10', 100), { start: 90, end: 99, length: 10 });
  assert.throws(() => normalizeRange('bytes=100-101', 100), (error) => error.code === 'RANGE_NOT_SATISFIABLE');
});

test('LocalStorageProvider faz stat, list e stream parcial sem path traversal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'araru-storage-'));
  try {
    await writeFile(path.join(root, 'book.pdf'), '0123456789');
    const provider = new LocalStorageProvider(root);
    assert.equal((await provider.stat('book.pdf')).size, 10);
    assert.equal((await provider.list()).length, 1);
    const result = await provider.stream('book.pdf', 'bytes=2-5');
    const chunks = [];
    for await (const chunk of result.stream) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), '2345');
    assert.throws(() => provider.resolve('../outside'), (error) => error.code === 'INVALID_STORAGE_KEY');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('R2 provider usa HeadObject e traduz Range para o comando S3', async () => {
  const provider = new R2StorageProvider({ endpoint: 'https://r2.example', accessKeyId: 'key', secretAccessKey: 'secret', bucket: 'books' });
  const calls = [];
  let options;
  provider.client = { send: async (command, sendOptions) => { calls.push(command); options = sendOptions; if (command.constructor.name === 'HeadObjectCommand') return { ContentLength: 100, ContentType: 'application/pdf', ETag: 'etag' }; return { Body: (async function* () { yield Buffer.from('data'); })() }; } };
  const controller = new AbortController();
  const result = await provider.stream('book.pdf', 'bytes=10-19', {}, { signal: controller.signal });
  assert.equal(calls[0].constructor.name, 'HeadObjectCommand');
  assert.equal(calls[1].constructor.name, 'GetObjectCommand');
  assert.equal(calls[1].input.Range, 'bytes=10-19');
  assert.equal(options.abortSignal, controller.signal);
  assert.equal(result.range.length, 10);
});

test('Drive provider propaga Range, AbortSignal e permite consumo incremental', async () => {
  let requestOptions;
  const provider = new GoogleDriveStorageProvider({
    client: { files: { get: async (params, options) => { requestOptions = options; return params.alt === 'media' ? { data: Readable.from([Buffer.from('chunk-1'), Buffer.from('chunk-2')]) } : { data: { id: 'book', size: '14', mimeType: 'application/pdf', md5Checksum: 'etag', trashed: false } }; } } },
    request: (task) => task()
  });
  const controller = new AbortController();
  const result = await provider.stream('book', 'bytes=2-8', {}, { signal: controller.signal });
  const chunks = [];
  for await (const chunk of result.stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'chunk-1chunk-2');
  assert.equal(requestOptions.signal, controller.signal);
  assert.equal(requestOptions.headers.Range, 'bytes=2-8');
});
