import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, mkdir, rm, truncate, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import JSZip from 'jszip';

let tempRoot = '';
let app;
let livroId = '';
let pgQuery;
let libraryDir = '';
let largeBookId = '';
let veryLargeBookIds = {};
let formatIds = {};

function parseBinary(res, callback) {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

async function criarEpubFixture(filePath) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/content.opf', '<?xml version="1.0"?><package version="3.0"><metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">EPUB Fixture</dc:title></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>');
  zip.file('OEBPS/chapter.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Conteúdo EPUB</h1></body></html>');
  await writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
}

function criarMobiFixture() {
  const html = Buffer.from('<html><body><h1>Conteúdo MOBI</h1></body></html>');
  const record0Position = 104;
  const record1Position = record0Position + 256;
  const record2Position = record1Position + html.length;
  const buffer = Buffer.alloc(record2Position);
  buffer.write('MOBI Fixture', 0, 'ascii');
  buffer.write('BOOK', 60, 'ascii'); buffer.write('MOBI', 64, 'ascii'); buffer.writeUInt16BE(3, 76);
  [record0Position, record1Position, record2Position].forEach((offset, index) => {
    buffer.writeUInt32BE(offset, 78 + index * 8); buffer.writeUInt32BE(index + 1, 82 + index * 8);
  });
  buffer.writeUInt16BE(1, record0Position); buffer.writeUInt32BE(html.length, record0Position + 4);
  buffer.writeUInt16BE(1, record0Position + 8); buffer.writeUInt16BE(4096, record0Position + 10);
  buffer.writeUInt32BE(0xe0, record0Position + 20); buffer.writeUInt32BE(2, record0Position + 24); buffer.writeUInt32BE(65001, record0Position + 28);
  buffer.writeUInt32BE(0xd0, record0Position + 0x54); buffer.writeUInt32BE(12, record0Position + 0x58);
  buffer.write('MOBI Fixture', record0Position + 0xd0, 'utf8'); html.copy(buffer, record1Position);
  return buffer;
}

async function criarComicFixture(filePath) {
  const zip = new JSZip();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  zip.file('001.png', png); zip.file('002.png', png);
  await writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
}

async function permiteAbrirPortaLocal() {
  const socket = createServer();
  try {
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.listen(0, '127.0.0.1', resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    if (socket.listening) await new Promise((resolve) => socket.close(resolve));
  }
}

const integrationAvailable = await permiteAbrirPortaLocal();

if (!integrationAvailable) {
  test('integração da API requer bind local disponível', { skip: 'Ambiente atual não permite abrir portas locais.' }, () => {});
} else {
before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'araru-api-'));
  libraryDir = path.join(tempRoot, 'library');
  const bookDir = path.join(libraryDir, 'Livros Técnicos', 'Java');
  await mkdir(bookDir, { recursive: true });
  await writeFile(path.join(bookDir, 'Livro de Teste.pdf'), Buffer.from('%PDF-1.4\nconteúdo de fixture\n%%EOF\n'));
  const largeFixture = path.join(bookDir, 'ZZ Fixture 500MB.pdf');
  await writeFile(largeFixture, Buffer.from('%PDF-1.4'));
  await truncate(largeFixture, 500 * 1024 * 1024);
  for (const [label, size] of [['2GB', 2 * 1024 ** 3], ['5GB', 5 * 1024 ** 3]]) {
    const fixture = path.join(bookDir, `ZZ Fixture ${label}.pdf`);
    await writeFile(fixture, Buffer.from('%PDF-1.4'));
    await truncate(fixture, size);
  }
  await criarEpubFixture(path.join(bookDir, 'Fixture EPUB.epub'));
  await writeFile(path.join(bookDir, 'Fixture MOBI.mobi'), criarMobiFixture());
  await criarComicFixture(path.join(bookDir, 'Fixture CBZ.cbz'));
  await criarComicFixture(path.join(bookDir, 'Fixture CBR.cbr'));
  await writeFile(path.join(tempRoot, 'categorias.json'), JSON.stringify({ defaults: { categoria: 'Outros' }, livros: {} }));
  await writeFile(path.join(tempRoot, 'drive-folders.json'), '[]');

  Object.assign(process.env, {
    FRONTEND_URL: 'http://127.0.0.1:5173',
    ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
    PUBLIC_BACKEND_URL: 'http://127.0.0.1:3001',
    ENABLE_GOOGLE_DRIVE: 'false',
    LOCAL_LIBRARY_DIR: libraryDir,
    MANUAL_CATEGORIAS_PATH: path.join(tempRoot, 'categorias.json'),
    DRIVE_FOLDERS_CONFIG: path.join(tempRoot, 'drive-folders.json'),
    COVER_CACHE_DIR: path.join(tempRoot, 'covers'),
    ENRICH_ON_ACCESS: 'false',
    METADATA_ENRICH_CONCURRENCY: '0'
  });
  const postgres = await import('../server/database/postgres.js');
  const { migratePostgres } = await import('../server/database/postgresMigrations.js');
  pgQuery = postgres.query;
  await migratePostgres();
  const { createApp } = await import('../server/app.js');
  app = await createApp();
  const response = await request(app).get('/api/livros');
  livroId = response.body.data.find((livro) => livro.nome === 'Livro de Teste')?.id || '';
  largeBookId = response.body.data.find((livro) => livro.nome === 'ZZ Fixture 500MB')?.id || '';
  veryLargeBookIds = Object.fromEntries(['2GB', '5GB'].map((label) => [
    label,
    response.body.data.find((livro) => livro.nome === `ZZ Fixture ${label}`)?.id || ''
  ]));
  formatIds = Object.fromEntries(response.body.data.filter((livro) => ['epub', 'mobi', 'cbz', 'cbr'].includes(livro.formato)).map((livro) => [livro.formato, livro.id]));
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

test('health informa que a biblioteca local está disponível sem Drive', async () => {
  const response = await request(app).get('/api/health');

  assert.equal(response.status, 200);
  assert.equal(response.body.application, 'Araru Server');
  assert.equal(response.body.status, 'ok');
  assert.equal(response.body.accessProtected, false);

  const details = await request(app).get('/api/health/details');
  assert.equal(details.body.application, 'Araru Server');
  assert.equal(details.body.googleDriveEnabled, false);
  assert.match(details.body.localLibraryDir, /araru-api-/);
  assert.ok(Array.isArray(details.body.catalog));
});

test('CORS aceita o domínio público do próprio host e ignora origem externa', async () => {
  const sameOrigin = await request(app).get('/api/health').set('Host', 'araru.example').set('Origin', 'https://araru.example');
  assert.equal(sameOrigin.headers['access-control-allow-origin'], 'https://araru.example');

  const external = await request(app).get('/api/health').set('Host', 'araru.example').set('Origin', 'https://malicioso.example');
  assert.equal(external.status, 200);
  assert.equal(external.headers['access-control-allow-origin'], undefined);
});

test('backend funciona sem build do frontend e não entrega a SPA pela porta da API', async () => {
  const response = await request(app).get('/').set('Accept', 'text/html');
  assert.equal(response.status, 404);
  assert.equal(response.body.code, 'NOT_FOUND');
  assert.equal(response.headers.location, undefined);
  assert.doesNotMatch(response.text, /<div id="root">/);

  const worker = await request(app).get('/sw.js');
  assert.equal(worker.status, 200);
  assert.match(worker.headers['content-type'], /javascript/);
  assert.equal(worker.headers['cache-control'], 'no-store');
  assert.match(worker.text, /registration\.unregister/);
  assert.match(worker.text, new RegExp(process.env.FRONTEND_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('descobre livro local e preserva a hierarquia de categorias', async () => {
  const response = await request(app).get('/api/livros');
  const livro = response.body.data.find((item) => item.id === livroId);

  assert.ok(livro);
  assert.equal(livro.formato, 'pdf');
  assert.deepEqual(livro.categoryPath, ['Livros Técnicos', 'Java']);

  const tree = await request(app).get('/api/categorias/arvore');
  assert.equal(tree.status, 200);
  assert.equal(tree.body.data[0].name, 'Livros Técnicos');
  assert.equal(tree.body.data[0].children[0].name, 'Java');
  assert.equal(tree.body.data[0].children[0].totalCount, 8);
});

test('busca indexada encontra termos sem acentos da hierarquia', async () => {
  const response = await request(app).get('/api/livros/busca').query({ q: 'tecnicos' });
  assert.equal(response.status, 200);
  assert.equal(response.body.total, 8);
  assert.ok(response.body.data.some((livro) => livro.id === livroId));
});

test('busca FTS encontra autor, descrição, ISBN e tags persistidos', async () => {
  await pgQuery(`
    INSERT INTO livros(id, drive_id, nome, autor, editora, descricao, isbn, isbn10, isbn13, tags)
    VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10::jsonb)
    ON CONFLICT(id) DO UPDATE SET autor=EXCLUDED.autor, editora=EXCLUDED.editora,
      descricao=EXCLUDED.descricao, isbn=EXCLUDED.isbn, isbn10=EXCLUDED.isbn10,
      isbn13=EXCLUDED.isbn13, tags=EXCLUDED.tags
  `, [livroId, livroId, 'Livro de Teste', JSON.stringify(['Ada Lovelace']), 'Editora Fixture',
    'TermoDiagnostico exclusivo para busca completa', '9780306406157', '', '9780306406157', JSON.stringify(['Computação Histórica'])]);
  const { atualizarMetadadosBusca } = await import('../server/services/libraryIndexService.js');
  const metadataFixture = {
    nome: 'Livro de Teste', autor: ['Ada Lovelace'], editora: 'Editora Fixture',
    descricao: 'TermoDiagnostico exclusivo para busca completa', isbn13: '9780306406157', tags: ['Computação Histórica']
  };
  await atualizarMetadadosBusca(livroId, metadataFixture);
  const { sincronizarObraArquivo } = await import('../server/services/workService.js');
  await sincronizarObraArquivo(livroId, metadataFixture);

  for (const query of ['lovelace', 'termodiagnostico', '9780306406157', 'historica']) {
    const response = await request(app).get('/api/livros/busca').query({ q: query });
    assert.equal(response.status, 200);
    assert.ok(response.body.data.some((livro) => livro.id === livroId), `Busca não encontrou ${query}`);
  }
});

test('separa obra canônica dos arquivos sem alterar IDs e URLs existentes', async () => {
  const works = await request(app).get('/api/works');
  assert.equal(works.status, 200);
  const canonical = works.body.data.find((work) => work.isbn13 === '9780306406157');
  assert.ok(canonical);
  assert.equal(canonical.fileCount, 1);
  const detail = await request(app).get(`/api/works/${encodeURIComponent(canonical.id)}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.files[0].id, livroId);
  assert.match(detail.body.data.files[0].contentUrl, /\/api\/livros\//);
});

test('persiste o índice do catálogo para reutilização no próximo início', async () => {
  const indexed = (await pgQuery('SELECT id,source,relative_path,status FROM library_files WHERE id=$1', [livroId])).rows[0];

  assert.equal(indexed.id, livroId);
  assert.equal(indexed.source, 'local');
  assert.equal(indexed.relative_path, 'Livros Técnicos/Java/Livro de Teste.pdf');
  assert.equal(indexed.status, 'active');
});

test('reconcilia o catálogo após alteração no filesystem local', async () => {
  const { iniciarObservadorBiblioteca, encerrarObservadorBiblioteca } = await import('../server/services/libraryWatcher.js');
  const watcher = iniciarObservadorBiblioteca();
  await new Promise((resolve) => watcher.once('ready', resolve));

  try {
    await writeFile(path.join(libraryDir, 'Livro monitorado.epub'), 'fixture');
    const deadline = Date.now() + 5000;
    let encontrou = false;
    while (Date.now() < deadline && !encontrou) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const response = await request(app).get('/api/livros');
      encontrou = response.body.data.some((livro) => livro.nome === 'Livro monitorado');
    }
    assert.equal(encontrou, true);
  } finally {
    await encerrarObservadorBiblioteca();
  }
});

test('serve conteúdo local com HTTP Range', async () => {
  const response = await request(app)
    .get(`/api/livros/${encodeURIComponent(livroId)}/conteudo`)
    .set('Range', 'bytes=0-7')
    .buffer(true)
    .parse(parseBinary);

  assert.equal(response.status, 206);
  assert.equal(response.headers['accept-ranges'], 'bytes');
  assert.match(response.headers['content-range'] || '', /^bytes 0-7\//);
  assert.equal(response.body.toString(), '%PDF-1.4');
});

test('expõe Range e headers do reader para o frontend em outra origem', async () => {
  const origin = 'http://127.0.0.1:5173';
  const preflight = await request(app)
    .options(`/api/livros/${encodeURIComponent(livroId)}/conteudo`)
    .set('Origin', origin)
    .set('Access-Control-Request-Method', 'GET')
    .set('Access-Control-Request-Headers', 'Range');
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], origin);
  assert.match(preflight.headers['access-control-allow-headers'] || '', /Range/i);

  const response = await request(app)
    .get(`/api/livros/${encodeURIComponent(livroId)}/conteudo`)
    .set('Origin', origin)
    .set('Range', 'bytes=0-7')
    .buffer(true)
    .parse(parseBinary);
  assert.equal(response.status, 206);
  assert.equal(response.headers['access-control-allow-origin'], origin);
  assert.match(response.headers['access-control-expose-headers'] || '', /Content-Range/i);
  assert.match(response.headers['access-control-expose-headers'] || '', /Accept-Ranges/i);
  assert.match(response.headers['content-range'] || '', /^bytes 0-7\//);
});

test('serve PDF esparso de 500 MB sem transferir o arquivo inteiro', async () => {
  const response = await request(app)
    .get(`/api/livros/${encodeURIComponent(largeBookId)}/conteudo`)
    .set('Range', 'bytes=0-7');
  assert.equal(response.status, 206);
  assert.equal(response.headers['content-length'], '8');
  assert.match(response.headers['content-range'], /\/524288000$/);
});

test('serve arquivos esparsos de 2 GB e 5 GB por Range sem consumo proporcional', async () => {
  for (const [label, size] of [['2GB', 2 * 1024 ** 3], ['5GB', 5 * 1024 ** 3]]) {
    const response = await request(app)
      .get(`/api/livros/${encodeURIComponent(veryLargeBookIds[label])}/conteudo`)
      .set('Range', 'bytes=0-7')
      .buffer(true)
      .parse(parseBinary);

    assert.equal(response.status, 206);
    assert.equal(response.headers['content-length'], '8');
    assert.equal(response.headers['content-range'], `bytes 0-7/${size}`);
    assert.equal(response.body.toString(), '%PDF-1.4');
  }
});

test('renderiza e serve fixtures EPUB, MOBI, CBZ e CBR', async () => {
  const epub = await request(app)
    .get(`/api/livros/${encodeURIComponent(formatIds.epub)}/conteudo`)
    .set('Range', 'bytes=0-3')
    .buffer(true)
    .parse(parseBinary);
  assert.equal(epub.status, 206);
  assert.equal(epub.headers['content-type'], 'application/epub+zip');
  assert.equal(epub.body.toString(), 'PK\u0003\u0004');

  const mobi = await request(app).get(`/api/livros/${encodeURIComponent(formatIds.mobi)}/conteudo`);
  assert.equal(mobi.status, 200);
  assert.match(mobi.text, /Conteúdo MOBI/);

  for (const formato of ['cbz', 'cbr']) {
    const pages = await request(app).get(`/api/livros/${encodeURIComponent(formatIds[formato])}/paginas`);
    assert.equal(pages.status, 200); assert.equal(pages.body.total, 2);
    const page = await request(app).get(`/api/livros/${encodeURIComponent(formatIds[formato])}/paginas/0`);
    assert.equal(page.status, 200); assert.equal(page.headers['content-type'], 'image/png');
  }
});

test('exporta e restaura backup transacional do estado da aplicação', async () => {
  const original = { favorites: [livroId], history: [], progress: { [livroId]: { page: 7, updatedAt: 10 } }, stats: {}, clientUpdatedAt: 10 };
  await request(app).put('/api/reading-state').send(original).expect(200);
  const backup = await request(app).get('/api/backup').buffer(true).parse(parseBinary);
  assert.equal(backup.status, 200);
  assert.equal(backup.headers['content-type'], 'application/gzip');
  assert.match(backup.headers['content-disposition'], /araru-/);
  assert.equal(backup.body.subarray(0, 2).toString('hex'), '1f8b');
  const verified = await request(app).post('/api/backup/verify').set('Content-Type', 'application/gzip').send(backup.body);
  assert.equal(verified.status, 200);
  assert.equal(verified.body.data.valid, true);

  await request(app).put('/api/reading-state').send({ ...original, favorites: [], clientUpdatedAt: 20 }).expect(200);
  const restored = await request(app)
    .post('/api/backup/restore')
    .set('Content-Type', 'application/gzip')
    .set('X-Confirm-Restore', 'RESTORE')
    .send(backup.body);
  assert.equal(restored.status, 200);
  const state = await request(app).get('/api/reading-state');
  assert.deepEqual(state.body.data.favorites, [livroId]);
  assert.equal(state.body.data.progress[livroId].page, 7);
});

test('expõe métricas operacionais e histórico persistente de jobs', async () => {
  const jobs = await request(app).get('/api/operations/jobs').query({ limit: 20 });
  assert.equal(jobs.status, 200);
  assert.ok(jobs.body.data.some((job) => job.type === 'comic-index' && job.status === 'completed'));

  const metrics = await request(app).get('/api/operations/metrics');
  assert.equal(metrics.status, 200);
  assert.ok(metrics.body.data.requests > 0);
  assert.ok(metrics.body.data.latencyMs.p95 >= 0);
  assert.ok(metrics.body.data.memoryBytes.rss > 0);
  assert.ok(Array.isArray(metrics.body.data.routes));
});

test('integra visualizações, preferências, flags e telemetria por meio da API', async () => {
  const createdView = await request(app).post('/api/saved-views').send({
    name: 'Java recentes',
    query: { category: 'Livros Técnicos/Java', order: 'recent', view: 'list' }
  });
  assert.equal(createdView.status, 201);
  assert.equal(createdView.body.data.name, 'Java recentes');

  const views = await request(app).get('/api/saved-views');
  assert.ok(views.body.data.some((view) => view.id === createdView.body.data.id));

  const preferences = await request(app).put('/api/preferences').send({
    theme: 'dark', readingMode: 'page', fit: 'page', pageAnimation: false
  });
  assert.equal(preferences.status, 200);
  assert.equal(preferences.body.data.theme, 'dark');
  const persistedPreferences = await request(app).get('/api/preferences');
  assert.equal(persistedPreferences.body.data.fit, 'page');

  const flags = await request(app).get('/api/features');
  assert.equal(flags.status, 200);
  assert.equal(typeof flags.body.data.adaptivePrefetch.enabled, 'boolean');

  await request(app).post('/api/reader-metrics').send({
    fileId: livroId, engine: 'pdf', event: 'first-page', durationMs: 42
  }).expect(202);
  const readerMetrics = await request(app).get('/api/operations/reader-metrics');
  assert.ok(readerMetrics.body.data.some((metric) => metric.engine === 'pdf' && metric.event === 'first-page'));

  await request(app).delete(`/api/saved-views/${createdView.body.data.id}`).expect(204);
});

test('expõe cache, integridade, séries, duplicatas e metadados com operações seguras', async () => {
  const cache = await request(app).get('/api/operations/cache');
  assert.equal(cache.status, 200);
  assert.equal(typeof cache.body.data, 'object');

  await writeFile(path.join(libraryDir, 'Livros Técnicos', 'Java', 'Livro de Teste.pdf'), Buffer.from('%PDF-1.4\nconteúdo alterado\n%%EOF\n'));
  await mkdir(path.join(tempRoot, 'covers'), { recursive: true });
  await writeFile(path.join(tempRoot, 'covers', 'orphan.jpg'), 'derived');
  const integrity = await request(app).post('/api/operations/integrity/scan');
  assert.equal(integrity.status, 200);
  assert.equal(integrity.body.data.summary.applied, false);
  assert.ok(integrity.body.data.findings.some((finding) => finding.type === 'changed-fingerprint'));
  assert.ok(integrity.body.data.findings.some((finding) => finding.type === 'untracked-cover-file'));

  await pgQuery("UPDATE works SET series_name='Fixture Saga',series_volume=1,series_confidence=1,series_source='test' WHERE isbn13='9780306406157'");
  const series = await request(app).get('/api/series');
  assert.equal(series.status, 200);
  const fixtureSeries = series.body.data.find((item) => item.name === 'Fixture Saga');
  assert.equal(fixtureSeries.volumes, 1);
  assert.equal(fixtureSeries.items[0].fileId, livroId);
  const duplicates = await request(app).get('/api/duplicates');
  assert.equal(duplicates.status, 200);
  assert.ok(Array.isArray(duplicates.body.data));

  const exported = await request(app).get('/api/metadata/export').query({ format: 'json' });
  assert.equal(exported.status, 200);
  assert.equal(exported.body.schema, 'araru-metadata');
  assert.equal(exported.body.version, 2);
  assert.ok(exported.body.data.some((item) => item.id === livroId));

  const preview = await request(app).post('/api/metadata/import').send({
    schema: 'araru-metadata',
    version: 2,
    data: [{ id: livroId, nome: 'Livro de Teste revisado' }]
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.data.dryRun, true);
  assert.equal(preview.body.data.changes, 1);

  const unchanged = await request(app).get('/api/livros');
  assert.ok(unchanged.body.data.some((item) => item.id === livroId && item.nome === 'Livro de Teste'));
});

test('mantém progresso e favoritos isolados entre perfis', async () => {
  const created = await request(app).post('/api/profiles').send({ name: 'Leitor secundário', color: '#7C3AED' });
  assert.equal(created.status, 201);
  const profileId = created.body.data.id;
  const selected = await request(app).post(`/api/profiles/${profileId}/select`);
  assert.equal(selected.status, 200);
  const cookie = selected.headers['set-cookie'];
  await request(app).put('/api/reading-state').set('Cookie', cookie).send({
    favorites: ['somente-secundario'], history: [], progress: { 'somente-secundario': { page: 3, updatedAt: 50 } }, stats: {}, clientUpdatedAt: 50
  }).expect(200);
  const secondary = await request(app).get('/api/reading-state').set('Cookie', cookie);
  const primary = await request(app).get('/api/reading-state');
  assert.deepEqual(secondary.body.data.favorites, ['somente-secundario']);
  assert.equal(secondary.body.profileId, profileId);
  assert.equal(primary.body.data.favorites.includes('somente-secundario'), false);
  const profiles = await request(app).get('/api/profiles').set('Cookie', cookie);
  assert.equal(profiles.body.selectedProfileId, profileId);
});
}
