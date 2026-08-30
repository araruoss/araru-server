import { execFile } from 'child_process';
import { open, stat } from 'fs/promises';
import { promisify } from 'util';
import { obterConteudoLivro } from './driveService.js';
import { env } from '../config/drive.js';
import { backgroundJobs } from './backgroundJobs.js';

const execFileAsync = promisify(execFile);
const indices = new Map();
const paginas = new Map();
const MAX_PAGINAS_CACHE = 12;

function mimeDaImagem(nome = '') {
  const ext = nome.split('.').pop()?.toLowerCase();
  return ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : ext === 'avif' ? 'image/avif' : 'image/jpeg';
}

function parseEntries(output = '') {
  return output.split(/\r?\n\r?\n/).map((block) => {
    const values = Object.fromEntries(block.split(/\r?\n/).map((line) => {
      const index = line.indexOf(' = ');
      return index < 0 ? [] : [line.slice(0, index), line.slice(index + 3)];
    }).filter(([key]) => key));
    return { name: values.Path || '', folder: values.Folder === '+', size: Number(values.Size || 0) };
  }).filter((entry) => entry.name && !entry.folder && !entry.name.startsWith('__MACOSX/') && /\.(avif|png|jpe?g|webp|gif)$/i.test(entry.name));
}

async function indexarArquivo(id) {
  const conteudo = await obterConteudoLivro(id, { preferirStream: true });
  if (!conteudo?.filePath || !['cbz', 'cbr'].includes(conteudo.livro.formato)) return null;
  const fingerprint = conteudo.livro.fileFingerprint || `${conteudo.livro.fileSize}:${conteudo.livro.fileMtime}`;
  const cached = indices.get(id);
  if (cached?.fingerprint === fingerprint) return cached;
  const { stdout } = await execFileAsync('7z', ['l', '-slt', conteudo.filePath], { timeout: env.coverRenderTimeout, maxBuffer: 16 * 1024 * 1024 });
  const entries = parseEntries(stdout).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const index = { livro: conteudo.livro, filePath: conteudo.filePath, entries, fingerprint };
  indices.set(id, index);
  return index;
}

export async function listarPaginasLivro(id) {
  const index = await backgroundJobs.enqueue('comic-index', { id }, {
    priority: 'high', dedupeKey: `comic-index:${id}`, maxAttempts: 2,
    timeoutMs: Math.max(30000, env.coverRenderTimeout)
  });
  if (!index) return null;
  return { total: index.entries.length, pages: index.entries.map((entry, page) => ({ page, name: entry.name })) };
}

export async function obterManifestoLeitura(id) {
  const conteudo = await obterConteudoLivro(id, { preferirStream: true });
  if (!conteudo) return null;
  const livro = conteudo.livro;
  const formato = String(livro.formato || '').toLowerCase();
  const paginado = ['pdf', 'cbz', 'cbr'].includes(formato);
  const paginaData = ['cbz', 'cbr'].includes(formato) ? await listarPaginasLivro(id) : null;
  const pageCount = paginaData?.total || Number(livro.numeroPaginas || 0) || null;
  const contentHash = livro.contentHash || livro.fileFingerprint || `${livro.fileSize || 0}:${livro.fileMtime || ''}`;
  return {
    id: String(id), version: contentHash, format: formato, readingType: paginado ? 'paged' : 'reflowable',
    contentHash, fileSize: Number(livro.fileSize || 0), title: livro.nome || livro.originalFilename || '',
    pageCount, chapterCount: Number(livro.chapterCount || 0) || null,
    direction: 'ltr', dimensions: { width: null, height: null },
    resources: {
      content: `/api/v1/works/${encodeURIComponent(id)}/content`,
      pages: paginado ? `/api/v1/works/${encodeURIComponent(id)}/pages` : null,
      page: paginado ? `/api/v1/works/${encodeURIComponent(id)}/pages/{page}` : null
    },
    pages: paginaData?.pages || [], chapters: Array.isArray(livro.chapters) ? livro.chapters : [],
    current: { page: 0, chapter: 0, progress: 0 }, related: []
  };
}

export async function obterPaginaLivro(id, page) {
  const pageNumber = Number(page);
  const index = await indexarArquivo(id);
  const key = `${id}:${index?.fingerprint}:${pageNumber}`;
  if (paginas.has(key)) return paginas.get(key);
  const entry = index?.entries[pageNumber];
  if (!entry || entry.size > env.coverMaxSourceImageBytes) return null;
  const { stdout } = await execFileAsync('7z', ['x', '-so', index.filePath, entry.name], {
    timeout: env.coverRenderTimeout,
    maxBuffer: env.coverMaxSourceImageBytes + 1,
    encoding: 'buffer'
  });
  const result = { data: Buffer.from(stdout), mimeType: mimeDaImagem(entry.name), total: index.entries.length, entry: entry.name };
  paginas.set(key, result);
  if (paginas.size > MAX_PAGINAS_CACHE) paginas.delete(paginas.keys().next().value);
  return result;
}

backgroundJobs.register('comic-index', ({ id }) => indexarArquivo(id));

function tipoImagemMobi(data) {
  if (data.subarray(0, 3).toString('hex') === 'ffd8ff') return 'image/jpeg';
  if (data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
  if (data.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}

export async function obterRecursoMobi(id, recindex) {
  const conteudo = await obterConteudoLivro(id);
  if (!conteudo?.filePath) return null;
  const recurso = Number.parseInt(recindex, 10);
  if (!Number.isInteger(recurso) || recurso < 1) return null;
  const arquivo = await open(conteudo.filePath, 'r');
  try {
    const cabecalho = Buffer.alloc(78);
    await arquivo.read(cabecalho, 0, cabecalho.length, 0);
    const totalRecords = cabecalho.readUInt16BE(76);
    const tabela = Buffer.alloc(totalRecords * 8);
    await arquivo.read(tabela, 0, tabela.length, 78);
    const offsets = Array.from({ length: totalRecords }, (_, index) => tabela.readUInt32BE(index * 8));
    if (offsets.length < 2) return null;
    const mobiHeader = Buffer.alloc(0x70);
    await arquivo.read(mobiHeader, 0, mobiHeader.length, offsets[0]);
    const primeiroRecurso = mobiHeader.readUInt32BE(0x6c);
    const record = primeiroRecurso + recurso - 1;
    if (record < 0 || record >= offsets.length) return null;
    const info = await stat(conteudo.filePath);
    const inicio = offsets[record];
    const fim = offsets[record + 1] || info.size;
    const tamanho = fim - inicio;
    if (tamanho <= 0 || tamanho > env.coverMaxSourceImageBytes) return null;
    const data = Buffer.alloc(tamanho);
    await arquivo.read(data, 0, tamanho, inicio);
    const mimeType = tipoImagemMobi(data);
    return mimeType ? { data, mimeType } : null;
  } finally {
    await arquivo.close();
  }
}
