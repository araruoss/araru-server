import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { pipeline } from 'stream/promises';
import { createHash } from 'crypto';
import { createDriveClient, env, hasDriveConfig, hasGoogleApiKey, hasGoogleCredentials } from '../config/drive.js';
import {
  atualizarCategoriaPersistida,
  atualizarCapaCache,
  buscarLivroPersistidoPorId,
  listarCategoriasPersistidas,
} from './metadataService.js';
import { listarLivrosIndexados, sincronizarIndiceLivros } from './libraryIndexService.js';
import { backgroundJobs } from './backgroundJobs.js';
import { obterEstadoSincronizacao, salvarEstadoSincronizacao } from './drivePersistenceService.js';
import { logger } from './logger.js';
import { ensureCacheCapacity, registerCover } from './cacheService.js';
import { breakerFor } from './circuitBreaker.js';

const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const FORMATOS_SUPORTADOS = new Set(['pdf', 'epub', 'mobi', 'cbz', 'cbr']);

const cache = new Map();
const execFileAsync = promisify(execFile);
let reconciliacaoCatalogo;
const driveRequest = (task) => breakerFor('google-drive').execute(task);

function criarLimitador(concorrencia) {
  let ativas = 0;
  const fila = [];

  const executar = () => {
    if (ativas >= concorrencia || fila.length === 0) return;
    ativas += 1;
    const { tarefa, resolve, reject } = fila.shift();
    tarefa().then(resolve, reject).finally(() => {
      ativas -= 1;
      executar();
    });
    executar();
  };

  return (tarefa) => new Promise((resolve, reject) => {
    fila.push({ tarefa, resolve, reject });
    executar();
  });
}

const limitarRenderizacaoCapa = criarLimitador(Math.max(1, env.coverRenderConcurrency));

const livrosMock = [
  {
    id: '1',
    nome: 'Clean Code',
    categoria: 'Programacao',
    capa: '#4F46E5',
    previewUrl: 'https://drive.google.com/file/d/1/preview',
    webViewLink: '#',
    fonte: 'drive'
  },
  {
    id: '2',
    nome: 'O Senhor dos Aneis',
    categoria: 'Ficcao',
    capa: '#7C3AED',
    previewUrl: 'https://drive.google.com/file/d/2/preview',
    webViewLink: '#',
    fonte: 'drive'
  },
  {
    id: '3',
    nome: 'Pai Rico Pai Pobre',
    categoria: 'Financas',
    capa: '#059669',
    previewUrl: 'https://drive.google.com/file/d/3/preview',
    webViewLink: '#',
    fonte: 'drive'
  },
  {
    id: '4',
    nome: 'Arquitetura Limpa',
    categoria: 'Programacao',
    capa: '#0891B2',
    previewUrl: 'https://drive.google.com/file/d/4/preview',
    webViewLink: '#',
    fonte: 'drive'
  },
  {
    id: '5',
    nome: 'Design de Sistemas',
    categoria: 'Tecnologia',
    capa: '#DB2777',
    previewUrl: 'https://drive.google.com/file/d/5/preview',
    webViewLink: '#',
    fonte: 'drive'
  }
];

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }

  return entry.value;
}

function cacheSet(key, value) {
  cache.set(key, {
    value,
    expiresAt: Date.now() + env.cacheTtl * 1000
  });
}

function gerarCorPorTexto(texto) {
  const cores = ['#4F46E5', '#059669', '#DB2777', '#EA580C', '#0891B2', '#7C3AED'];
  const soma = [...texto].reduce((total, char) => total + char.charCodeAt(0), 0);
  return cores[soma % cores.length];
}

function extrairFormato(nome = '') {
  return path.extname(nome).slice(1).toLowerCase();
}

function formatoTemCapa(formato) {
  return ['pdf', 'cbz', 'cbr', 'epub', 'mobi'].includes(formato);
}

function urlCapaCache(id, fingerprint = '') {
  const base = `/api/livros/${encodeURIComponent(id)}/capa`;
  return fingerprint ? `${base}?v=${encodeURIComponent(fingerprint)}` : base;
}

function ehImagemExterna(valor = '') {
  return /^(https?:)?\/\//i.test(valor) || valor.startsWith('data:') || valor.startsWith('blob:') || valor.startsWith('/');
}

function tratarErroDrive(error) {
  const status = error?.code || error?.response?.status || 500;
  const apiError = error?.response?.data?.error;
  const message = apiError?.message || error?.message || 'Erro ao consultar o Google Drive.';
  const reasons = [
    ...(error?.errors || []),
    ...(apiError?.errors || [])
  ].map((item) => item.reason).filter(Boolean);

  if (status === 429 || reasons.includes('rateLimitExceeded') || reasons.includes('userRateLimitExceeded')) {
    const rateError = new Error('Limite de requisicoes do Google Drive atingido. Tente novamente em alguns minutos.');
    rateError.statusCode = 429;
    throw rateError;
  }

  const driveError = new Error(message);
  driveError.statusCode = status;
  driveError.driveReason = reasons.join(', ');
  throw driveError;
}

function criarUrlLocal(relPath) {
  const baseRoute = env.localFilesRoute.replace(/\/+$/, '');
  const encodedPath = relPath
    .split(path.sep)
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  return `${baseRoute}/${encodedPath}`;
}

function normalizarLivroLocal(filePath, stats, categoria, raiz) {
  const relPath = path.relative(raiz, filePath);
  const nomeArquivo = path.basename(filePath, path.extname(filePath));
  const previewUrl = criarUrlLocal(relPath);
  const segmentos = relPath.split(path.sep).filter(Boolean);
  const subcategorias = segmentos.slice(1, -1);
  const categoryPath = segmentos.slice(0, -1);

  return {
    id: `local-${Buffer.from(relPath).toString('base64url')}`,
    sourceId: `local:${relPath}`,
    driveId: `local:${relPath}`,
    filePath,
    source: 'local',
    nome: nomeArquivo || 'Sem titulo',
    formato: extrairFormato(filePath),
    categoria,
    subcategorias,
    categoryPath,
    categoryPathString: categoryPath.join('/'),
    capa: gerarCorPorTexto(relPath || nomeArquivo),
    ...(formatoTemCapa(extrairFormato(filePath))
      ? { capaUrl: `/api/livros/${encodeURIComponent(`local-${Buffer.from(relPath).toString('base64url')}`)}/capa` }
      : {}),
    capaCor: gerarCorPorTexto(relPath || nomeArquivo),
    previewUrl,
    contentUrl: `/api/livros/${encodeURIComponent(`local-${Buffer.from(relPath).toString('base64url')}`)}/conteudo`,
    webViewLink: previewUrl,
    thumbnailLink: null,
    modifiedTime: stats.mtime.toISOString(),
    fileSize: stats.size,
    fileMtime: stats.mtimeMs,
    fileFingerprint: `${stats.size}:${Math.floor(stats.mtimeMs)}`,
    fonte: 'local',
    dataAdicao: stats.birthtime?.toISOString?.() || stats.mtime.toISOString()
  };
}

function normalizarLivroDrive(file, categoria, subcategorias = [], categoryPath = []) {
  return {
    id: file.id,
    sourceId: file.id,
    driveId: file.id,
    source: 'drive',
    nome: file.name?.replace(/\.(pdf|epub|mobi|cbz|cbr)$/i, '') || 'Sem titulo',
    formato: extrairFormato(file.name),
    categoria,
    subcategorias,
    categoryPath,
    categoryPathString: categoryPath.join('/'),
    capa: gerarCorPorTexto(file.name || file.id),
    ...(formatoTemCapa(extrairFormato(file.name))
      ? { capaUrl: `/api/livros/${encodeURIComponent(file.id)}/capa` }
      : {}),
    capaCor: gerarCorPorTexto(file.name || file.id),
    previewUrl: `https://drive.google.com/file/d/${file.id}/preview`,
    contentUrl: `/api/livros/${encodeURIComponent(file.id)}/conteudo`,
    webViewLink: file.webViewLink,
    thumbnailLink: file.thumbnailLink,
    modifiedTime: file.modifiedTime,
    fileSize: Number(file.size || 0),
    fileMtime: file.modifiedTime || '',
    fileFingerprint: [file.id, file.modifiedTime || '', file.size || '', file.md5Checksum || ''].join(':'),
    fonte: 'drive',
    dataAdicao: file.modifiedTime || new Date().toISOString()
  };
}

async function listarArquivos(query) {
  const drive = createDriveClient();
  const arquivos = [];
  let pageToken;

  do {
    const response = await driveRequest(() => drive.files.list({
      q: query,
      pageSize: 1000,
      pageToken,
      fields: 'nextPageToken, files(id, name, mimeType, parents, webViewLink, thumbnailLink, modifiedTime, size, md5Checksum)',
      orderBy: 'name'
    }));

    arquivos.push(...(response.data.files || []));
    pageToken = response.data.nextPageToken;
  } while (pageToken);

  return arquivos;
}

async function listarLivrosLocais(diretorio = env.localLibraryDir, raiz = env.localLibraryDir) {
  try {
    const entradas = await fs.readdir(diretorio, { withFileTypes: true });
    const livros = [];

    for (const entrada of entradas) {
      const caminho = path.join(diretorio, entrada.name);

      if (entrada.isDirectory()) {
        const filhos = await listarLivrosLocais(caminho, raiz);
        livros.push(...filhos);
        continue;
      }

      if (!entrada.isFile() || !FORMATOS_SUPORTADOS.has(extrairFormato(entrada.name))) {
        continue;
      }

      const stats = await fs.stat(caminho);
      const relPath = path.relative(raiz, caminho);
      const segmentos = relPath.split(path.sep).filter(Boolean);
      const categoria = segmentos.length > 1 ? segmentos[0] : '';

      livros.push(normalizarLivroLocal(caminho, stats, categoria, raiz));
    }

    return livros;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

function extrairIdPastaDrive(valor) {
  const texto = String(valor || '').trim();
  if (!texto) return '';

  const linkMatch = texto.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (linkMatch) return linkMatch[1];

  const queryMatch = texto.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (queryMatch) return queryMatch[1];

  return /^[a-zA-Z0-9_-]+$/.test(texto) ? texto : '';
}

async function listarPastasDriveConfiguradas() {
  const configuradas = [];

  if (env.driveFolderId) {
    configuradas.push({ id: env.driveFolderId, categoria: '' });
  }

  try {
    const conteudo = await fs.readFile(env.driveFoldersConfigPath, 'utf8');
    const json = conteudo.trim() ? JSON.parse(conteudo) : [];
    const itens = Array.isArray(json) ? json : json.pastas || json.folders || [];

    for (const item of itens) {
      const valor = typeof item === 'string' ? item : item.link || item.pasta || item.folder || item.id;
      const id = extrairIdPastaDrive(valor);
      if (id) {
        configuradas.push({
          id,
          categoria: typeof item === 'string' ? '' : item.categoria || item.category || ''
        });
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new Error(`Configuracao de pastas do Google Drive invalida: ${error.message}`);
    }
  }

  return [...new Map(configuradas.map((item) => [`${item.id}:${item.categoria}`, item])).values()];
}

async function listarLivrosDriveCompleto() {
  if (!env.enableGoogleDrive || !hasDriveConfig() || (!hasGoogleCredentials() && !hasGoogleApiKey())) {
    return [];
  }

  const pastasRaiz = await listarPastasDriveConfiguradas();
  const limitarRequisicoes = criarLimitador(Math.max(1, env.driveConcurrency));
  const pastasVisitadas = new Set();

  async function percorrerPasta(folderId, caminho = [], categoriaRaiz = '') {
    if (pastasVisitadas.has(folderId)) return [];
    pastasVisitadas.add(folderId);

    const [arquivos, pastas] = await Promise.all([
      limitarRequisicoes(() => listarArquivos(`'${folderId}' in parents and trashed=false and mimeType != '${FOLDER_MIME_TYPE}'`)),
      limitarRequisicoes(() => listarArquivos(`'${folderId}' in parents and mimeType='${FOLDER_MIME_TYPE}' and trashed=false`))
    ]);

    const categoria = categoriaRaiz || caminho[0] || '';
    const subcategorias = categoriaRaiz ? caminho : caminho.slice(1);
    const livrosDaPasta = arquivos
      .filter((file) => FORMATOS_SUPORTADOS.has(extrairFormato(file.name)))
      .map((file) => normalizarLivroDrive(file, categoria, subcategorias, categoriaRaiz ? [categoriaRaiz, ...caminho] : caminho));
    const livrosDasSubpastas = await Promise.all(
      pastas.map((pasta) => percorrerPasta(pasta.id, [...caminho, pasta.name], categoriaRaiz))
    );

    return [...livrosDaPasta, ...livrosDasSubpastas.flat()];
  }

  const livros = await Promise.all(
    pastasRaiz.map((pasta) => percorrerPasta(pasta.id, [], pasta.categoria))
  );

  return livros.flat();
}

async function iniciarCursorDrive(drive, mode = 'full') {
  if (!hasGoogleCredentials()) return;
  const response = await driveRequest(() => drive.changes.getStartPageToken({}));
  if (response.data.startPageToken) {
    await salvarEstadoSincronizacao('drive', { cursor: response.data.startPageToken, mode });
  }
}

async function resolverHierarquiaArquivoDrive(file, drive, pastasRaiz) {
  const roots = new Map(pastasRaiz.map((folder) => [folder.id, folder]));
  const names = [];
  const visited = new Set();
  let parentId = file.parents?.[0];
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const root = roots.get(parentId);
    if (root) {
      const caminho = names.reverse();
      const categoria = root.categoria || caminho[0] || '';
      const subcategorias = root.categoria ? caminho : caminho.slice(1);
      const categoryPath = root.categoria ? [root.categoria, ...caminho] : caminho;
      return { categoria, subcategorias, categoryPath };
    }
    const response = await driveRequest(() => drive.files.get({ fileId: parentId, fields: 'id,name,parents,trashed' }));
    const folder = response.data;
    if (!folder || folder.trashed) return null;
    names.push(folder.name || '');
    parentId = folder.parents?.[0];
  }
  return null;
}

async function listarLivrosDriveIncremental() {
  const state = await obterEstadoSincronizacao('drive');
  const drive = createDriveClient();
  if (!state?.cursor) {
    const books = await listarLivrosDriveCompleto();
    await iniciarCursorDrive(drive, 'full');
    return books;
  }

  const changes = [];
  let pageToken = state.cursor;
  let nextCursor = state.cursor;
  try {
    do {
      const response = await driveRequest(() => drive.changes.list({
        pageToken,
        pageSize: 1000,
        spaces: 'drive',
        includeRemoved: true,
        fields: 'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,parents,trashed,webViewLink,thumbnailLink,modifiedTime,size,md5Checksum))'
      }));
      changes.push(...(response.data.changes || []));
      pageToken = response.data.nextPageToken;
      nextCursor = response.data.newStartPageToken || pageToken || nextCursor;
    } while (pageToken);
  } catch (error) {
    if (Number(error?.code || error?.response?.status) === 410) {
      const books = await listarLivrosDriveCompleto();
      await iniciarCursorDrive(drive, 'full-after-expired-cursor');
      return books;
    }
    await salvarEstadoSincronizacao('drive', { cursor: state.cursor, mode: state.mode || 'incremental', error });
    throw error;
  }

  if (!changes.length) {
    await salvarEstadoSincronizacao('drive', { cursor: nextCursor, mode: 'incremental' });
    return (await listarLivrosIndexados()).filter((book) => (book.source || book.fonte) === 'drive');
  }

  // Alterações de pasta podem mudar o categoryPath de uma árvore inteira.
  // Nesse caso a reconciliação completa é a única forma segura de preservar
  // a hierarquia derivada do filesystem/Drive.
  if (changes.some((change) => change.file?.mimeType === FOLDER_MIME_TYPE)) {
    const books = await listarLivrosDriveCompleto();
    await iniciarCursorDrive(drive, 'full-after-folder-change');
    return books;
  }

  const merged = new Map(
    (await listarLivrosIndexados())
      .filter((book) => (book.source || book.fonte) === 'drive')
      .map((book) => [book.id, book])
  );
  const roots = await listarPastasDriveConfiguradas();
  for (const change of changes) {
    const file = change.file;
    if (change.removed || file?.trashed || !file || !FORMATOS_SUPORTADOS.has(extrairFormato(file.name))) {
      merged.delete(change.fileId);
      continue;
    }
    const hierarchy = await resolverHierarquiaArquivoDrive(file, drive, roots);
    if (!hierarchy) {
      merged.delete(file.id);
      continue;
    }
    merged.set(file.id, normalizarLivroDrive(file, hierarchy.categoria, hierarchy.subcategorias, hierarchy.categoryPath));
  }
  await salvarEstadoSincronizacao('drive', { cursor: nextCursor, mode: 'incremental' });
  return [...merged.values()];
}

async function listarLivrosDrive() {
  if (!hasGoogleCredentials()) return listarLivrosDriveCompleto();
  return listarLivrosDriveIncremental();
}

async function descobrirLivros() {
  const livrosLocais = await listarLivrosLocais();
  const reconciledSources = new Set(['local']);

  if (env.enableGoogleDrive && hasDriveConfig() && !hasGoogleCredentials() && !hasGoogleApiKey() && livrosLocais.length === 0) {
    const error = new Error('Google Drive nao autenticado. Acesse /api/auth/login primeiro.');
    error.statusCode = 401;
    throw error;
  }

  let livrosDrive = [];

  try {
    livrosDrive = await listarLivrosDrive();
    if (env.enableGoogleDrive && hasDriveConfig() && (hasGoogleCredentials() || hasGoogleApiKey())) {
      reconciledSources.add('drive');
    }
  } catch (error) {
    if (livrosLocais.length === 0) {
      tratarErroDrive(error);
    }

    logger.warn('drive.catalog.unavailable', { status: error.statusCode || error.code, driveReason: error.driveReason, localFallback: true, error });
  }

  return { livrosBase: [...livrosDrive, ...livrosLocais], reconciledSources };
}

async function montarCatalogo(livrosBase) {
  const ordenados = [...livrosBase].sort((a, b) => {
    const porNome = a.nome.localeCompare(b.nome, 'pt-BR', { sensitivity: 'base' });
    if (porNome !== 0) return porNome;
    return (a.fonte || '').localeCompare(b.fonte || '');
  });

  // A listagem deve ser leve. O enriquecimento (leitura do PDF, capas e
  // consultas externas) acontece somente quando o livro e acessado.
  return Promise.all(ordenados.map(async (livro) => {
    const persistido = await buscarLivroPersistidoPorId(livro.id);
    return {
      ...livro,
      ...(persistido || {}),
      id: livro.id,
      // O nome persistido pode ter sido confirmado pelo pipeline; o nome do
      // arquivo continua preservado em originalFilename para auditoria.
      nome: persistido?.nome || livro.nome,
      // A organizacao visual da biblioteca deve refletir a hierarquia das
      // pastas. Metadados persistidos continuam enriquecendo o livro, mas nao
      // devem substituir categoria/subcategoria inferidas da origem.
      categoria: livro.categoria || persistido?.categoria,
      subcategorias: livro.subcategorias?.length ? livro.subcategorias : (persistido?.subcategorias || []),
      categoryPath: livro.categoryPath?.length ? livro.categoryPath : (persistido?.categoryPath || []),
      categoryPathString: livro.categoryPathString || persistido?.categoryPathString || '',
      fonte: livro.fonte,
      formato: livro.formato,
      previewUrl: livro.previewUrl,
      contentUrl: livro.contentUrl,
      webViewLink: livro.webViewLink,
      capaUrl: persistido?.coverPath
        ? urlCapaCache(livro.id, livro.fileFingerprint)
        : (ehImagemExterna(persistido?.capa || '') ? persistido.capa : (livro.capaUrl ? urlCapaCache(livro.id, livro.fileFingerprint) : '')),
      capa: persistido?.capa || livro.capa,
      capaCor: persistido?.capaCor || livro.capaCor,
      filePath: livro.filePath,
      driveId: livro.driveId,
      sourceId: livro.sourceId,
      fileSize: livro.fileSize,
      fileMtime: livro.fileMtime,
      fileFingerprint: livro.fileFingerprint,
      coverPath: persistido?.coverPath || '',
      coverFingerprint: persistido?.coverFingerprint || ''
    };
  }));
}

async function reconciliarCatalogo() {
  if (reconciliacaoCatalogo) return reconciliacaoCatalogo;

  reconciliacaoCatalogo = descobrirLivros()
    .then(async ({ livrosBase, reconciledSources }) => {
      await sincronizarIndiceLivros(livrosBase, { reconciledSources });
      const livros = await montarCatalogo(livrosBase);
      cacheSet('livros', livros);
      return livros;
    })
    .finally(() => {
      reconciliacaoCatalogo = null;
    });

  return reconciliacaoCatalogo;
}

export async function obterLivros({ forceRefresh = false } = {}) {
  if (env.useMockData) {
    // Mock continua sendo uma fonte de desenvolvimento. Quando houver PDFs
    // locais, eles tambem devem aparecer para permitir testar as duas fontes
    // juntas sem precisar autenticar o Drive.
    const livrosLocais = await listarLivrosLocais();
    return [...livrosMock, ...livrosLocais];
  }

  if (!forceRefresh) {
    const cached = cacheGet('livros');
    if (cached) return cached;

    const indexados = await listarLivrosIndexados();
    if (indexados.length > 0) {
      const livros = await montarCatalogo(indexados);
      cacheSet('livros', livros);
      reconciliarCatalogo().catch((error) => {
        logger.warn('catalog.reconcile_failed', { error });
      });
      return livros;
    }
  }

  return reconciliarCatalogo();
}

export async function obterCategorias() {
  const livros = await obterLivros();
  const categorias = livros.reduce((acc, livro) => {
    const nome = livro.categoria || env.useFallbackCategoria;
    if (!acc.has(nome)) {
      acc.set(nome, { nome, total: 0, subcategorias: new Map() });
    }

    const entry = acc.get(nome);
    entry.total += 1;

    for (const subcategoria of livro.subcategorias || []) {
      entry.subcategorias.set(subcategoria, (entry.subcategorias.get(subcategoria) || 0) + 1);
    }

    return acc;
  }, new Map());

  const categoriasPersistidas = new Map((await listarCategoriasPersistidas()).map((item) => [item.nome, item]));

  return [...categorias.entries()]
    .map(([nome, item]) => ({
      nome,
      total: item.total,
      icone: categoriasPersistidas.get(nome)?.icone || 'BookOpen',
      cor: categoriasPersistidas.get(nome)?.cor || '#0891B2',
      subcategorias: [...item.subcategorias.entries()]
        .map(([subnome, total]) => ({ nome: subnome, total }))
        .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
    }))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

export async function obterArvoreCategorias() {
  const livros = await obterLivros();
  const roots = new Map();

  for (const livro of livros) {
    const categoryPath = livro.categoryPath?.length ? livro.categoryPath : (livro.categoria ? [livro.categoria, ...(livro.subcategorias || [])] : ['Sem categoria']);
    let nodes = roots;
    let current;
    categoryPath.forEach((name, index) => {
      const key = categoryPath.slice(0, index + 1).join('/');
      if (!nodes.has(key)) nodes.set(key, { name, path: categoryPath.slice(0, index + 1), pathString: key, directCount: 0, totalCount: 0, children: new Map() });
      current = nodes.get(key);
      current.totalCount += 1;
      nodes = current.children;
    });
    if (current) current.directCount += 1;
  }

  const serialize = (node) => ({
    name: node.name, path: node.path, pathString: node.pathString, directCount: node.directCount, totalCount: node.totalCount,
    children: [...node.children.values()].map(serialize).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
  });
  return [...roots.values()].map(serialize).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

export function mimeTypeDoFormato(formato = '') {
  return {
    pdf: 'application/pdf',
    epub: 'application/epub+zip',
    mobi: 'application/x-mobipocket-ebook',
    cbz: 'application/zip',
    cbr: 'application/vnd.rar'
  }[formato] || 'application/octet-stream';
}

export async function obterConteudoLivro(id, { preferirStream = false } = {}) {
  const livros = await obterLivros();
  const livro = livros.find((item) => item.id === id);
  if (!livro) return null;

  if (livro.fonte === 'local') {
    return { livro, filePath: livro.filePath, mimeType: mimeTypeDoFormato(livro.formato) };
  }

  const drive = createDriveClient();
  // CBZ e EPUB podem ser servidos e processados por stream; apenas os
  // leitores legados de MOBI/CBR ainda exigem buffer para leitura.
  const precisaBuffer = !preferirStream && ['mobi', 'cbr'].includes(livro.formato);
  const resposta = await driveRequest(() => drive.files.get(
    { fileId: livro.driveId || livro.id, alt: 'media' },
    { responseType: precisaBuffer ? 'arraybuffer' : 'stream' }
  ));

  return {
    livro,
    stream: precisaBuffer ? null : resposta.data,
    buffer: precisaBuffer ? Buffer.from(resposta.data) : null,
    mimeType: mimeTypeDoFormato(livro.formato)
  };
}

async function extrairPrimeiraImagemZip(buffer) {
  const modulo = await import('jszip');
  const JSZip = modulo.default || modulo;
  const zip = await JSZip.loadAsync(buffer);
  const entrada = Object.values(zip.files)
    .filter((item) => !item.dir && /\.(png|jpe?g|gif|webp)$/i.test(item.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))[0];
  if (!entrada) return null;
  const extensao = path.extname(entrada.name).toLowerCase();
  const mimeType = extensao === '.png' ? 'image/png' : extensao === '.webp' ? 'image/webp' : extensao === '.gif' ? 'image/gif' : 'image/jpeg';
  return { data: Buffer.from(await entrada.async('nodebuffer')), mimeType };
}

function mimeDaImagem(nome = '') {
  const extensao = path.extname(nome).toLowerCase();
  return extensao === '.png' ? 'image/png' : extensao === '.webp' ? 'image/webp' : extensao === '.gif' ? 'image/gif' : extensao === '.avif' ? 'image/avif' : 'image/jpeg';
}

function nomeDeImagemValido(nome = '') {
  const normalizado = nome.replace(/\\/g, '/');
  const base = path.posix.basename(normalizado);
  return !normalizado.startsWith('__MACOSX/') && !base.startsWith('.') && /\.(avif|png|jpe?g|webp|gif)$/i.test(base);
}

function entradas7z(saida = '') {
  return saida.split(/\r?\n\r?\n/).map((bloco) => {
    const valores = Object.fromEntries(bloco.split(/\r?\n/).map((linha) => {
      const indice = linha.indexOf(' = ');
      return indice < 0 ? [] : [linha.slice(0, indice), linha.slice(indice + 3)];
    }).filter(([chave]) => chave));
    return { name: valores.Path || '', size: Number(valores.Size || 0), folder: valores.Folder === '+' };
  }).filter((entrada) => entrada.name && !entrada.folder);
}

async function executar7z(args, options = {}) {
  return execFileAsync('7z', args, {
    timeout: env.coverRenderTimeout,
    maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
    encoding: options.encoding || 'utf8'
  });
}

async function listarEntradasArquivoCompactado(arquivo) {
  const { stdout } = await executar7z(['l', '-slt', arquivo]);
  return entradas7z(stdout);
}

async function extrairEntradaArquivoCompactado(arquivo, entrada, tamanhoMaximo = env.coverMaxSourceImageBytes) {
  const { stdout } = await executar7z(['x', '-so', arquivo, entrada.name], { maxBuffer: tamanhoMaximo + 1, encoding: 'buffer' });
  const data = Buffer.from(stdout);
  if (data.length > tamanhoMaximo) throw new Error('cover_source_image_too_large');
  return { data, mimeType: mimeDaImagem(entrada.name) };
}

function localizarCapaEpub(entradas, opf, container) {
  const opfPath = (container.match(/full-path=["']([^"']+\.opf)["']/i)?.[1] || entradas.find((entry) => /\.opf$/i.test(entry.name))?.name || '').replace(/\\/g, '/');
  if (!opfPath) return null;
  const manifest = [...opf.matchAll(/<item\b([^>]+)>/gi)].map((match) => ({
    id: match[1].match(/\bid=["']([^"']+)["']/i)?.[1],
    href: match[1].match(/\bhref=["']([^"']+)["']/i)?.[1],
    properties: match[1].match(/\bproperties=["']([^"']+)["']/i)?.[1] || ''
  }));
  const coverId = opf.match(/<meta\b[^>]*\bname=["']cover["'][^>]*\bcontent=["']([^"']+)["']/i)?.[1];
  const item = manifest.find((entry) => /(^|\s)cover-image(\s|$)/i.test(entry.properties)) || manifest.find((entry) => entry.id === coverId);
  if (!item?.href) return null;
  const alvo = path.posix.normalize(path.posix.join(path.posix.dirname(opfPath), item.href));
  return entradas.find((entry) => entry.name.replace(/\\/g, '/') === alvo) || null;
}

async function extrairCapaArquivoCompactado(arquivo, formato) {
  const entradas = await listarEntradasArquivoCompactado(arquivo);
  const imagens = entradas.filter((entrada) => nomeDeImagemValido(entrada.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  let primeiraImagem = imagens[0];
  if (formato === 'epub') {
    const containerEntry = entradas.find((entry) => /(^|\/)META-INF\/container\.xml$/i.test(entry.name));
    if (containerEntry && containerEntry.size <= 1024 * 1024) {
      const container = (await extrairEntradaArquivoCompactado(arquivo, containerEntry, 1024 * 1024)).data.toString('utf8');
      const opfPath = container.match(/full-path=["']([^"']+\.opf)["']/i)?.[1];
      const opfEntry = entradas.find((entry) => entry.name.replace(/\\/g, '/') === opfPath);
      if (opfEntry && opfEntry.size <= 5 * 1024 * 1024) {
        const opf = (await extrairEntradaArquivoCompactado(arquivo, opfEntry, 5 * 1024 * 1024)).data.toString('utf8');
        primeiraImagem = localizarCapaEpub(entradas, opf, container) || primeiraImagem;
      }
    }
  }
  if (!primeiraImagem) return null;
  if (primeiraImagem.size > env.coverMaxSourceImageBytes) throw new Error('cover_source_image_too_large');
  return extrairEntradaArquivoCompactado(arquivo, primeiraImagem);
}

function mimeImagemPorAssinatura(data) {
  if (data.subarray(0, 3).toString('hex') === 'ffd8ff') return 'image/jpeg';
  if (data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
  if (data.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}

async function extrairCapaMobi(livro) {
  if (!livro.filePath || Number(livro.fileSize || 0) > env.readerMaxInMemoryBytes) return null;
  const arquivo = await fs.open(livro.filePath, 'r');
  try {
    const header = Buffer.alloc(78); await arquivo.read(header, 0, header.length, 0);
    const total = header.readUInt16BE(76); const table = Buffer.alloc(total * 8); await arquivo.read(table, 0, table.length, 78);
    const offsets = Array.from({ length: total }, (_, index) => table.readUInt32BE(index * 8));
    if (offsets.length < 2) return null;
    const mobiHeader = Buffer.alloc(0x70); await arquivo.read(mobiHeader, 0, mobiHeader.length, offsets[0]);
    const firstImage = mobiHeader.readUInt32BE(0x6c);
    for (let candidate = firstImage; candidate < Math.min(firstImage + 5, offsets.length); candidate += 1) {
      const start = offsets[candidate]; const end = offsets[candidate + 1] || (await arquivo.stat()).size; const size = end - start;
      if (size <= 0 || size > env.coverMaxSourceImageBytes) continue;
      const data = Buffer.alloc(size); await arquivo.read(data, 0, size, start);
      const mimeType = mimeImagemPorAssinatura(data);
      if (mimeType) return { data, mimeType, record: candidate };
    }
    return null;
  } finally { await arquivo.close(); }
}

async function renderizarPrimeiraPaginaPdf(conteudo) {
  let pastaTemporaria;
  try {
    const livro = conteudo.livro;
    const fingerprint = livro.fileFingerprint || `${livro.modifiedTime || ''}:${livro.fileSize || ''}`;
    const nomeCache = createHash('sha256').update(livro.id).digest('hex');
    const arquivoCache = path.join(env.coverCacheDir, `${nomeCache}.jpg`);
    if (livro.coverPath && livro.coverFingerprint === fingerprint) {
      try { return { data: await fs.readFile(livro.coverPath), mimeType: 'image/jpeg' }; } catch { /* regenerar */ }
    }
    if (livro.coverFingerprint === fingerprint) {
      try { return { data: await fs.readFile(arquivoCache), mimeType: 'image/jpeg' }; } catch { /* gerar */ }
    }
    pastaTemporaria = await fs.mkdtemp(path.join(os.tmpdir(), 'araru-cover-'));
    const arquivoPdf = conteudo.filePath || path.join(pastaTemporaria, 'livro.pdf');
    if (!conteudo.filePath) {
      if (conteudo.stream) await pipeline(conteudo.stream, createWriteStream(arquivoPdf));
      else if (conteudo.buffer) await fs.writeFile(arquivoPdf, conteudo.buffer);
      else return null;
    }
    const prefixo = path.join(pastaTemporaria, 'capa');
    await execFileAsync('pdftoppm', ['-f', '1', '-l', '1', '-singlefile', '-jpeg', '-scale-to-x', String(env.coverWidth), '-scale-to-y', '-1', arquivoPdf, prefixo], { maxBuffer: 12 * 1024 * 1024, timeout: env.coverRenderTimeout });
    const data = await fs.readFile(`${prefixo}.jpg`);
    await ensureCacheCapacity(data.length);
    await fs.mkdir(env.coverCacheDir, { recursive: true });
    await fs.writeFile(arquivoCache, data);
    await registerCover(livro.id, arquivoCache, data, 'pdf_page');
    await atualizarCapaCache(livro.id, { coverPath: arquivoCache, coverFingerprint: fingerprint, coverSource: 'pdf_page' }, livro);
    logger.info('cover.generated', { bookId: livro.id, source: 'pdf-page-1', bytes: data.length });
    return { data, mimeType: 'image/jpeg' };
  } catch {
    return null;
  } finally {
    if (pastaTemporaria) await fs.rm(pastaTemporaria, { recursive: true, force: true }).catch(() => {});
  }
}

function extensaoDaCapa(mimeType = '') {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/gif') return 'gif';
  return 'jpg';
}

function fingerprintDaCapa(livro) {
  return livro.fileFingerprint || `${livro.modifiedTime || ''}:${livro.fileSize || ''}`;
}

async function lerCapaPersistida(livro) {
  const fingerprint = fingerprintDaCapa(livro);
  if (!livro.coverPath || livro.coverFingerprint !== fingerprint) return null;
  try {
    const data = await fs.readFile(livro.coverPath);
    const extensao = path.extname(livro.coverPath).toLowerCase();
    const mimeType = extensao === '.png' ? 'image/png' : extensao === '.webp' ? 'image/webp' : extensao === '.gif' ? 'image/gif' : 'image/jpeg';
    return { data, mimeType };
  } catch {
    return null;
  }
}

async function persistirCapaExtraida(livro, capa, source) {
  const fingerprint = fingerprintDaCapa(livro);
  const nomeCache = createHash('sha256').update(livro.id).digest('hex');
  const arquivoCache = path.join(env.coverCacheDir, `${nomeCache}.${extensaoDaCapa(capa.mimeType)}`);
  await ensureCacheCapacity(capa.data.length);
  await fs.mkdir(env.coverCacheDir, { recursive: true });
  await fs.writeFile(arquivoCache, capa.data);
  await registerCover(livro.id, arquivoCache, capa.data, source);
  await atualizarCapaCache(livro.id, { coverPath: arquivoCache, coverFingerprint: fingerprint, coverSource: source }, livro);
  return capa;
}

async function resolverCapaLivro(id) {
  const livroAtual = (await obterLivros()).find((livro) => livro.id === id);
  if (!livroAtual) return null;
  const chaveCache = `capa:${id}:${fingerprintDaCapa(livroAtual)}`;
  const capaCacheada = cacheGet(chaveCache);
  if (capaCacheada) return capaCacheada;

  const persistida = await lerCapaPersistida(livroAtual);
  if (persistida) {
    cacheSet(chaveCache, persistida);
    return persistida;
  }

  const conteudo = await obterConteudoLivro(id, { preferirStream: true });
  if (!conteudo) return null;

  if (['cbz', 'epub', 'cbr'].includes(conteudo.livro.formato)) {
    let pastaTemporaria;
    try {
      let capa;
      if (conteudo.filePath) {
        capa = await extrairCapaArquivoCompactado(conteudo.filePath, conteudo.livro.formato);
      } else if (conteudo.stream) {
        pastaTemporaria = await fs.mkdtemp(path.join(os.tmpdir(), 'araru-cover-archive-'));
        const arquivoTemporario = path.join(pastaTemporaria, `arquivo.${conteudo.livro.formato}`);
        await pipeline(conteudo.stream, createWriteStream(arquivoTemporario));
        capa = await extrairCapaArquivoCompactado(arquivoTemporario, conteudo.livro.formato);
      } else if (conteudo.buffer && conteudo.buffer.length <= env.coverMaxInMemoryBytes) {
        capa = await extrairPrimeiraImagemZip(conteudo.buffer);
      } else {
        logger.warn('cover.source_unsupported', { bookId: id, format: conteudo.livro.formato, reason: 'source_requires_streaming_path' });
        return null;
      }
      if (capa) {
        await persistirCapaExtraida(conteudo.livro, capa, conteudo.livro.formato === 'epub' ? 'epub_embedded' : `${conteudo.livro.formato}_first_image`);
        cacheSet(chaveCache, capa);
      }
      return capa;
    } catch (error) {
      logger.warn('cover.extraction_failed', { bookId: id, format: conteudo.livro.formato, error });
      return null;
    } finally {
      if (pastaTemporaria) await fs.rm(pastaTemporaria, { recursive: true, force: true }).catch(() => {});
    }
  }

  if (conteudo.livro.formato === 'pdf') {
    const capa = await limitarRenderizacaoCapa(() => renderizarPrimeiraPaginaPdf(conteudo));
    if (capa) cacheSet(chaveCache, capa);
    return capa;
  }

  if (conteudo.livro.formato === 'mobi') {
    try {
      const capa = await extrairCapaMobi(conteudo.livro);
      if (!capa) return null;
      await persistirCapaExtraida(conteudo.livro, capa, 'mobi_first_image');
      cacheSet(chaveCache, capa);
      logger.info('cover.generated', { bookId: id, format: 'mobi', source: 'first-image', record: capa.record });
      return capa;
    } catch (error) {
      logger.warn('cover.extraction_failed', { bookId: id, format: 'mobi', error });
      return null;
    }
  }

  return null;
}

export async function obterCapaLivro(id) {
  return backgroundJobs.enqueue('cover', { id }, {
    priority: 'high', dedupeKey: `cover:${id}`, maxAttempts: 2,
    timeoutMs: Math.max(30000, env.coverRenderTimeout)
  });
}

export function enfileirarCapaLivro(id, priority = 'normal') {
  return backgroundJobs.enqueue('cover', { id }, { priority, dedupeKey:`cover:${id}`,maxAttempts:2,timeoutMs:Math.max(30000,env.coverRenderTimeout) });
}

export async function renderizarLivroCompactado(conteudo, pagina = 0) {
  const formato = conteudo.livro.formato;
  if (!['mobi', 'cbr'].includes(formato)) return null;

  const tamanho = Number(conteudo.livro.fileSize || 0);
  if (tamanho > env.readerMaxInMemoryBytes) {
    logger.warn('reader.memory_limit', { bookId: conteudo.livro.id, format: formato, size: tamanho });
    return { kind: 'too_large' };
  }

  let arquivo = conteudo.filePath;
  let pastaTemporaria;
  try {
    if (!arquivo) {
      pastaTemporaria = await fs.mkdtemp(path.join(os.tmpdir(), 'araru-'));
      arquivo = path.join(pastaTemporaria, `${conteudo.livro.id}.${formato}`);
      await fs.writeFile(arquivo, conteudo.buffer);
    }

    if (formato === 'mobi') {
      const modulo = await import('mobi');
      const Mobi = modulo.default || modulo;
      const livro = new Mobi(arquivo);
      const recursosUrl = `/api/livros/${encodeURIComponent(conteudo.livro.id)}/recursos/mobi`;
      const html = (livro.content || '').replace(/<img\b([^>]*?)\brecindex=["'](\d+)["']([^>]*)>/gi, (_match, antes, indice, depois) => {
        const semSrc = `${antes}${depois}`.replace(/\bsrc=["'][^"']*["']/gi, '');
        return `<img${semSrc} src="${recursosUrl}/${Number(indice)}" loading="lazy" decoding="async">`;
      });
      return { kind: 'html', data: html || '<p>Este MOBI nao possui conteudo HTML legivel.</p>' };
    }

    const modulo = await import('unrar-js');
    const arquivos = (modulo.unrarSync || modulo.default?.unrarSync)(arquivo) || [];
    const imagens = arquivos
      .filter((item) => /\.(png|jpe?g|gif|webp)$/i.test(item.filename))
      .sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
    const indice = Math.max(0, Math.min(Number(pagina) || 0, imagens.length - 1));
    const imagem = imagens[indice];
    if (!imagem) return { kind: 'empty', total: 0 };

    const extensao = path.extname(imagem.filename).toLowerCase();
    const mimeType = extensao === '.png' ? 'image/png' : extensao === '.webp' ? 'image/webp' : extensao === '.gif' ? 'image/gif' : 'image/jpeg';
    return { kind: 'image', data: Buffer.from(imagem.fileData), mimeType, total: imagens.length, pagina: indice };
  } finally {
    if (pastaTemporaria) await fs.rm(pastaTemporaria, { recursive: true, force: true });
  }
}

export function limparCache() {
  cache.clear();
}

export async function atualizarCatalogo() {
  cache.delete('livros');
  return reconciliarCatalogo();
}

export function enfileirarAtualizacaoCatalogo({ priority = 'normal', reason = 'scheduled' } = {}) {
  return backgroundJobs.enqueue('catalog-reconcile', { reason }, {
    priority, dedupeKey: 'catalog-reconcile', maxAttempts: 3
  });
}

export async function prepararBibliotecaLocal() {
  await fs.mkdir(env.localLibraryDir, { recursive: true });
  await fs.mkdir(env.coverCacheDir, { recursive: true });
}

export async function sincronizarCategoriasPersistidas(categorias = []) {
  for (const categoria of categorias) {
    await atualizarCategoriaPersistida(categoria.nome, categoria.icone || '', categoria.cor || '');
  }
}

backgroundJobs.register('cover', ({ id }) => resolverCapaLivro(id));
backgroundJobs.register('catalog-reconcile', () => atualizarCatalogo());
