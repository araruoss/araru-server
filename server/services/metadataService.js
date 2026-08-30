import fs from 'fs/promises';
import path from 'path';
import { env } from '../config/drive.js';
import { extractLocalMetadata } from './metadata/extractor.js';
import { parseFilename } from './metadata/filenameParser.js';
import { extractISBN as extractValidISBN, isbnForms, normalizeIsbn as normalizeValidIsbn } from './metadata/isbn.js';
import { cleanDisplayText, isUsefulMetadata, normalizeForMatch } from './metadata/normalizer.js';
import { scoreCandidate } from './metadata/scorer.js';
import { googleBooksByIsbn, googleBooksByText, openLibraryByIsbn, openLibraryByText } from './metadata/providers.js';
import { preserveManualValue } from './metadata/fields.js';
import { backgroundJobs } from './backgroundJobs.js';
import { atualizarMetadadosBusca } from './libraryIndexService.js';
import { logger } from './logger.js';
import { sincronizarObraArquivo } from './workService.js';
import { bookExists, findBook, findBookByIsbn, listBooks, listBooksForReview, listCategories, saveBook as saveBookPostgres, updateLastRead, upsertCategory } from './metadataRepository.js';

const colors = ['#4F46E5', '#059669', '#DB2777', '#EA580C', '#0891B2', '#7C3AED'];

const cache = new Map();
let manualCache = { mtimeMs: 0, data: { defaults: { categoria: env.useFallbackCategoria }, livros: {} } };
const enrichmentQueue = backgroundJobs;

function normalizeText(value = '') {
  return value
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function generateColor(texto) {
  const soma = [...(texto || '')].reduce((total, char) => total + char.charCodeAt(0), 0);
  return colors[soma % colors.length];
}

function safeJsonParse(value, fallback = []) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function extractYear(value) {
  if (!value) return null;
  const match = String(value).match(/\b(19\d{2}|20\d{2})\b/);
  return match ? Number(match[1]) : null;
}

function normalizeIsbn(value = '') {
  return normalizeValidIsbn(value) || null;
}

export function extractISBN(texto = '') {
  return extractValidISBN(texto) || null;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.metadataRequestTimeout);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json'
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Falha ao consultar ${url}`);
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function buscarGoogleBooksPorISBN(isbn) {
  const url = new URL('https://www.googleapis.com/books/v1/volumes');
  url.searchParams.set('q', `isbn:${isbn}`);
  if (env.googleBooksApiKey) {
    url.searchParams.set('key', env.googleBooksApiKey);
  }

  const data = await fetchJson(url.toString());
  return data.items?.[0] || null;
}

async function buscarGoogleBooksPorTitulo(titulo) {
  const url = new URL('https://www.googleapis.com/books/v1/volumes');
  url.searchParams.set('q', `intitle:${titulo}`);
  if (env.googleBooksApiKey) {
    url.searchParams.set('key', env.googleBooksApiKey);
  }

  const data = await fetchJson(url.toString());
  return data.items?.[0] || null;
}

async function buscarOpenLibraryPorISBN(isbn) {
  const url = new URL(env.openLibraryApiUrl);
  url.searchParams.set('bibkeys', `ISBN:${isbn}`);
  url.searchParams.set('format', 'json');
  url.searchParams.set('jscmd', 'data');

  const data = await fetchJson(url.toString());
  return data[`ISBN:${isbn}`] || null;
}

function parseGoogleBooksVolume(volume) {
  if (!volume) return {};

  const info = volume.volumeInfo || {};
  const isbn = (info.industryIdentifiers || [])
    .map((item) => normalizeIsbn(item.identifier))
    .find(Boolean);

  return {
    nome: info.title || '',
    autor: info.authors || [],
    editora: info.publisher || '',
    ano: extractYear(info.publishedDate),
    isbn,
    descricao: info.description || '',
    capa: info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail || '',
    avaliacao: typeof info.averageRating === 'number' ? info.averageRating : null,
    numeroPaginas: info.pageCount || null,
    idioma: info.language || '',
    subcategorias: info.categories || [],
    tags: [...(info.categories || []), ...(info.authors || [])]
  };
}

function parseOpenLibraryBook(book) {
  if (!book) return {};

  return {
    nome: book.title || '',
    autor: (book.authors || []).map((item) => item.name).filter(Boolean),
    editora: (book.publishers || []).map((item) => item.name).filter(Boolean).join(', '),
    ano: extractYear(book.publish_date || ''),
    descricao: book.excerpts?.[0]?.text || book.notes || '',
    capa: book.cover?.large || book.cover?.medium || book.cover?.small || '',
    numeroPaginas: book.number_of_pages || null,
    idioma: (book.languages || []).map((item) => item.key?.split('/').pop()).filter(Boolean)[0] || '',
    subcategorias: (book.subjects || []).map((item) => item.name).filter(Boolean),
    tags: (book.subjects || []).map((item) => item.name).filter(Boolean)
  };
}

async function carregarOverridesManuais() {
  try {
    const stats = await fs.stat(env.manualCategoriesPath);
    if (stats.mtimeMs === manualCache.mtimeMs) {
      return manualCache.data;
    }

    const raw = await fs.readFile(env.manualCategoriesPath, 'utf8');
    const data = raw.trim() ? JSON.parse(raw) : { defaults: { categoria: env.useFallbackCategoria }, livros: {} };
    manualCache = { mtimeMs: stats.mtimeMs, data };
    return data;
  } catch {
    return manualCache.data;
  }
}

function resolveManualOverride(asset, manualData, isbn) {
  const livros = manualData?.livros || {};
  const defaults = manualData?.defaults || {};
  const candidates = [
    asset.id,
    asset.driveId,
    asset.sourceId,
    isbn,
    normalizeText(asset.nome || ''),
    normalizeText(path.basename(asset.nome || '', path.extname(asset.nome || '')))
  ].filter(Boolean);

  for (const key of candidates) {
    if (livros[key]) {
      return livros[key];
    }
  }

  // A categoria da pasta local/Drive e mais especifica que o fallback global.
  // Os defaults so devem ser usados quando o arquivo ainda nao tem categoria.
  return asset.categoria ? {} : defaults;
}

function splitAuthors(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  return String(value)
    .split(/[,;/]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function slugId(asset) {
  return asset.id || asset.driveId || asset.sourceId;
}

function buildTags(...parts) {
  return [...new Set(parts.flat().map((item) => String(item || '').trim()).filter(Boolean))];
}

function keepFolderHierarchy(baseValues = [], overrideValues = []) {
  const base = buildTags(baseValues);
  if (base.length > 0) return base;
  return buildTags(overrideValues);
}

function mapDbRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    drive_id: row.drive_id,
    nome: row.nome,
    categoria: row.categoria,
    subcategorias: safeJsonParse(row.subcategorias, []),
    autor: safeJsonParse(row.autor, []),
    editora: row.editora || '',
    ano: row.ano || null,
    isbn: row.isbn || '',
    descricao: row.descricao || '',
    capa: row.capa_url || '',
    capaCor: row.capa_cor || '',
    avaliacao: row.avaliacao ?? null,
    numeroPaginas: row.numero_paginas ?? null,
    idioma: row.idioma || '',
    linkDrive: row.link_drive || '',
    previewUrl: row.preview_url || row.link_drive || '',
    fonte: row.fonte || 'drive',
    filePath: row.file_path || '',
    dataAdicao: row.data_adicao || row.created_at || null,
    ultimaLeitura: row.ultima_leitura || null,
    favorito: Boolean(row.favorito),
    tags: safeJsonParse(row.tags, []),
    metadadosCompletos: safeJsonParse(row.metadados_completos, {}),
    isbn10: row.isbn10 || '',
    isbn13: row.isbn13 || '',
    originalFilename: row.original_filename || '',
    normalizedTitle: row.normalized_title || '',
    normalizedAuthor: row.normalized_author || '',
    metadataStatus: row.metadata_status || 'pending',
    metadataConfidence: Number(row.metadata_confidence || 0),
    metadataSource: row.metadata_source || '',
    metadataProvenance: safeJsonParse(row.metadata_provenance, {}),
    metadataLastChecked: row.metadata_last_checked || null,
    coverSource: row.cover_source || '',
    manualFields: safeJsonParse(row.manual_fields, []),
    needsReview: Boolean(row.needs_review),
    enrichmentAttempts: Number(row.enrichment_attempts || 0),
    enrichmentError: row.enrichment_error || '',
    candidateMatches: safeJsonParse(row.candidate_matches, [])
    ,fileSize: Number(row.file_size || 0), fileMtime: row.file_mtime || '', fileFingerprint: row.file_fingerprint || '',
    coverPath: row.cover_path || '', coverGeneratedAt: row.cover_generated_at || null, coverFingerprint: row.cover_fingerprint || ''
    ,categoryPath: safeJsonParse(row.category_path, []), categoryPathString: safeJsonParse(row.category_path, []).join('/')
  };
}

function calcularStale(updatedAt) {
  if (!updatedAt) return true;
  const updatedMs = new Date(updatedAt).getTime();
  const maxAgeMs = env.refreshMetadataDays * 24 * 60 * 60 * 1000;
  return Date.now() - updatedMs > maxAgeMs;
}

function applyOverrides(base, overrides = {}) {
  const subcategorias = keepFolderHierarchy(base.subcategorias, overrides.subcategorias);
  const autor = splitAuthors(overrides.autor || base.autor);
  const tags = buildTags(base.tags, overrides.tags, subcategorias, autor);

  return {
    ...base,
    categoria: base.categoria || overrides.categoria || env.useFallbackCategoria,
    subcategorias,
    autor,
    editora: overrides.editora || base.editora || '',
    ano: overrides.ano || base.ano || null,
    isbn: overrides.isbn || base.isbn || '',
    descricao: overrides.descricao || base.descricao || '',
    capa: overrides.capa || base.capa || '',
    capaCor: overrides.capaCor || base.capaCor || generateColor(base.nome || base.id),
    avaliacao: overrides.avaliacao || base.avaliacao || null,
    numeroPaginas: overrides.numeroPaginas || base.numeroPaginas || null,
    idioma: overrides.idioma || base.idioma || '',
    tags
  };
}

function mergeMetadata(asset, pdfData = {}, apiData = {}, manualData = {}, isbn = '') {
  const base = {
    id: asset.id,
    drive_id: asset.driveId || asset.sourceId || asset.id,
    nome: asset.nome || pdfData.nome || apiData.nome || 'Sem titulo',
    categoria: asset.categoria || manualData.categoria || env.useFallbackCategoria,
    subcategorias: asset.subcategorias || [],
    autor: asset.autor || [],
    editora: asset.editora || '',
    ano: asset.ano || null,
    isbn,
    descricao: asset.descricao || '',
    capa: asset.capa || '',
    capaCor: asset.capaCor || generateColor(asset.nome || asset.id),
    avaliacao: asset.avaliacao || null,
    numeroPaginas: asset.numeroPaginas || null,
    idioma: asset.idioma || '',
    linkDrive: asset.webViewLink || asset.previewUrl || '',
    previewUrl: asset.previewUrl || asset.webViewLink || '',
    fonte: asset.fonte || 'drive',
    filePath: asset.filePath || '',
    dataAdicao: asset.dataAdicao || new Date().toISOString(),
    ultimaLeitura: asset.ultimaLeitura || null,
    favorito: asset.favorito ? 1 : 0,
    tags: asset.tags || [],
    metadadosCompletos: {}
  };

  const merged = applyOverrides(base, {
    ...pdfData,
    ...apiData,
    ...manualData
  });

  // Subcategorias devem seguir a estrutura das pastas. Dados externos podem
  // preencher apenas quando a origem ainda nao fornece essa hierarquia.
  merged.subcategorias = keepFolderHierarchy(
    merged.subcategorias,
    buildTags(pdfData.subcategorias, apiData.subcategorias, manualData.subcategorias)
  );
  merged.autor = splitAuthors([...splitAuthors(merged.autor), ...splitAuthors(pdfData.autor), ...splitAuthors(apiData.autor), ...splitAuthors(manualData.autor)]);
  merged.tags = buildTags(merged.tags, pdfData.tags, apiData.tags, manualData.tags, merged.autor, merged.subcategorias);
  merged.metadadosCompletos = {
    asset,
    pdfData,
    apiData,
    manualData,
    isbn
  };

  if (!merged.categoria) {
    merged.categoria = env.useFallbackCategoria;
  }

  return merged;
}

async function buscarMetadadosPublicos(asset, isbn, titulo) {
  if (isbn) {
    const googleBook = await buscarGoogleBooksPorISBN(isbn).catch(() => null);
    if (googleBook) {
      return parseGoogleBooksVolume(googleBook);
    }

    const openLibrary = await buscarOpenLibraryPorISBN(isbn).catch(() => null);
    if (openLibrary) {
      return parseOpenLibraryBook(openLibrary);
    }
  }

  if (titulo) {
    const googleBook = await buscarGoogleBooksPorTitulo(titulo).catch(() => null);
    if (googleBook) {
      return parseGoogleBooksVolume(googleBook);
    }
  }

  return {};
}

async function salvarLivro(livro) {
  const payload = {
    id: livro.id,
    drive_id: livro.drive_id,
    nome: livro.nome,
    categoria: livro.categoria,
    subcategorias: JSON.stringify(livro.subcategorias || []),
    autor: JSON.stringify(livro.autor || []),
    editora: livro.editora || '',
    ano: livro.ano || null,
    isbn: livro.isbn || '',
    descricao: livro.descricao || '',
    capa_url: livro.capa || '',
    capa_cor: livro.capaCor || '',
    avaliacao: livro.avaliacao || null,
    numero_paginas: livro.numeroPaginas || null,
    idioma: livro.idioma || '',
    link_drive: livro.linkDrive || '',
    preview_url: livro.previewUrl || '',
    fonte: livro.fonte || 'drive',
    file_path: livro.filePath || '',
    data_adicao: livro.dataAdicao || new Date().toISOString(),
    ultima_leitura: livro.ultimaLeitura || null,
    favorito: livro.favorito ? 1 : 0,
    tags: JSON.stringify(livro.tags || []),
    metadados_completos: JSON.stringify(livro.metadadosCompletos || {})
  };

  await saveBookPostgres(livro);
  await atualizarMetadadosBusca(livro.id, livro);
  await sincronizarObraArquivo(livro.id, livro);
  return livro;
}

function valueOrFallback(value, fallback = '') {
  return isUsefulMetadata(value) ? value : fallback;
}

async function buscarCandidatos(local) {
  const candidates = [];
  if (local.isbn13 || local.isbn10 || local.isbn) {
    const isbn = local.isbn13 || local.isbn10 || local.isbn;
    const google = await googleBooksByIsbn(isbn).catch(() => []);
    candidates.push(...google);
    const openLibrary = await openLibraryByIsbn(isbn).catch(() => []);
    candidates.push(...openLibrary);
  }
  if (!candidates.length && local.nome) {
    const author = splitAuthors(local.autor).join(' ');
    const [google, openLibrary] = await Promise.all([
      googleBooksByText(local.nome, author).catch(() => []),
      openLibraryByText(local.nome, author).catch(() => [])
    ]);
    candidates.push(...google, ...openLibrary);
  }
  return [...new Map(candidates.filter((item) => item.nome).map((item) => [`${item.source}:${item.isbn13 || normalizeForMatch(item.nome)}`, item])).values()];
}

function montarLivroPipeline(asset, persisted, filename, extracted, selected, ranked) {
  const manualFields = persisted?.manualFields || [];
  const selectedData = selected?.candidate || {};
  const score = selected?.score || 0;
  const status = selected ? selected.status : (extracted.extractionError ? 'failed' : 'partial');
  const shouldApply = score >= env.metadataAutoApplyThreshold;
  const safeApply = score >= env.metadataReviewThreshold;
  const extractedAuthor = splitAuthors(extracted.autor);
  const filenameAuthor = splitAuthors(filename.autor);
  const local = {
    // Metadado interno só vence o filename quando for reconhecidamente útil.
    nome: valueOrFallback(extracted.nome, valueOrFallback(filename.nome, cleanDisplayText(asset.nome || 'Arquivo sem identificação'))),
    autor: extractedAuthor.length ? extractedAuthor : filenameAuthor,
    ...isbnForms(extracted.isbn || filename.isbn),
    isbn: extracted.isbn || filename.isbn || '',
    editora: extracted.editora || '',
    ano: extracted.ano || null,
    evidence: { ...filename.evidence, ...(extracted.evidence || {}) }
  };
  const usePersistedAsTrusted = manualFields.length > 0 || Number(persisted?.metadataConfidence || 0) >= env.metadataReviewThreshold;
  const baseName = usePersistedAsTrusted ? valueOrFallback(persisted?.nome, local.nome) : local.nome;
  const baseAuthor = usePersistedAsTrusted && splitAuthors(persisted?.autor).length ? persisted.autor : local.autor;
  const applyExternal = shouldApply || safeApply;
  const proposedName = applyExternal ? valueOrFallback(selectedData.nome, baseName) : baseName;
  const proposedAuthor = applyExternal && splitAuthors(selectedData.autor).length ? selectedData.autor : baseAuthor;
  const externalIsbn = selectedData.isbn13 || selectedData.isbn10 || selectedData.isbn || '';
  const forms = isbnForms(local.isbn13 || local.isbn10 || externalIsbn || local.isbn);
  const source = selectedData.source || (extracted.evidence?.epubMetadata ? 'epub_metadata' : extracted.evidence?.pdfMetadata ? 'pdf_metadata' : 'filename');
  const provenance = {
    nome: manualFields.includes('nome') ? 'manual' : (selectedData.nome && applyExternal ? source : filename.nome ? 'filename' : 'local_extraction'),
    autor: manualFields.includes('autor') ? 'manual' : (selectedData.autor?.length && applyExternal ? source : extractedAuthor.length ? 'local_extraction' : 'filename'),
    isbn13: forms.isbn13 ? (extracted.evidence?.internalIsbn ? 'local_content' : filename.isbn ? 'filename' : source) : '',
    capa: manualFields.includes('capa') ? 'manual' : (selectedData.capa && applyExternal ? source : asset.capaUrl ? 'embedded' : '')
  };
  const review = !shouldApply && status !== 'confirmed';
  const candidateMatches = ranked.slice(0, 3).map(({ candidate, score: candidateScore, status: candidateStatus }) => ({
    nome: candidate.nome, autor: candidate.autor, isbn13: candidate.isbn13 || '', source: candidate.source, score: candidateScore, status: candidateStatus
  }));

  return {
    ...asset,
    ...(persisted || {}),
    id: asset.id,
    drive_id: asset.driveId || asset.sourceId || asset.id,
    nome: preserveManualValue('nome', persisted?.nome, proposedName, manualFields),
    autor: preserveManualValue('autor', persisted?.autor, splitAuthors(proposedAuthor), manualFields),
    editora: preserveManualValue('editora', persisted?.editora, applyExternal ? selectedData.editora || extracted.editora : extracted.editora, manualFields),
    ano: preserveManualValue('ano', persisted?.ano, applyExternal ? selectedData.ano || extracted.ano : extracted.ano, manualFields),
    isbn: forms.isbn13 || forms.isbn10 || '', isbn10: forms.isbn10, isbn13: forms.isbn13,
    descricao: preserveManualValue('descricao', persisted?.descricao, applyExternal ? selectedData.descricao || extracted.descricao : extracted.descricao, manualFields),
    capa: preserveManualValue('capa', persisted?.capa, applyExternal ? selectedData.capa || persisted?.capa || '' : persisted?.capa || '', manualFields),
    capaCor: persisted?.capaCor || asset.capaCor || generateColor(asset.nome || asset.id),
    coverSource: provenance.capa,
    avaliacao: selectedData.avaliacao || persisted?.avaliacao || null,
    numeroPaginas: selectedData.numeroPaginas || extracted.numeroPaginas || persisted?.numeroPaginas || null,
    idioma: selectedData.idioma || extracted.idioma || persisted?.idioma || '',
    tags: buildTags(asset.tags, persisted?.tags, extracted.tags, selectedData.tags, splitAuthors(proposedAuthor)),
    categoria: asset.categoria || persisted?.categoria || env.useFallbackCategoria,
    subcategorias: asset.subcategorias?.length ? asset.subcategorias : (persisted?.subcategorias || []),
    categoryPath: asset.categoryPath?.length ? asset.categoryPath : (persisted?.categoryPath || []),
    fonte: asset.fonte || persisted?.fonte || 'drive', filePath: asset.filePath || persisted?.filePath || '',
    fileSize: asset.fileSize || persisted?.fileSize || 0,
    fileMtime: asset.fileMtime || persisted?.fileMtime || '',
    fileFingerprint: asset.fileFingerprint || persisted?.fileFingerprint || '',
    coverPath: persisted?.coverPath || '',
    coverGeneratedAt: persisted?.coverGeneratedAt || null,
    coverFingerprint: persisted?.coverFingerprint || '',
    previewUrl: asset.previewUrl || persisted?.previewUrl || '', linkDrive: asset.webViewLink || asset.previewUrl || persisted?.linkDrive || '',
    dataAdicao: asset.dataAdicao || persisted?.dataAdicao || new Date().toISOString(),
    originalFilename: filename.originalFilename || persisted?.originalFilename || '',
    normalizedTitle: normalizeForMatch(preserveManualValue('nome', persisted?.nome, proposedName, manualFields)),
    normalizedAuthor: normalizeForMatch(splitAuthors(preserveManualValue('autor', persisted?.autor, splitAuthors(proposedAuthor), manualFields)).join(' ')),
    metadataStatus: status === 'confirmed' || status === 'high' ? 'completed' : review ? 'review' : status,
    metadataConfidence: score,
    metadataSource: source,
    metadataProvenance: provenance,
    metadataLastChecked: new Date().toISOString(),
    manualFields,
    needsReview: review,
    enrichmentAttempts: Number(persisted?.enrichmentAttempts || 0) + 1,
    enrichmentError: extracted.extractionError || '',
    candidateMatches,
    metadadosCompletos: { filename, extracted: { ...extracted, extractedText: undefined }, selected: selectedData, candidates: candidateMatches }
  };
}

export async function enriquecerLivro(asset, { forceRefresh = false } = {}) {
  const id = slugId(asset);
  if (!id) return null;
  const persisted = await findBook(id);
  if (persisted && !forceRefresh && persisted.fileFingerprint === asset.fileFingerprint && persisted.metadataStatus !== 'pending' && !calcularStale(persisted.metadataLastChecked || persisted.updated_at)) {
    return persisted;
  }
  const filename = parseFilename(asset.filePath || asset.nome || '');
  const extracted = env.enrichOnAccess ? await extractLocalMetadata(asset) : {};
  const local = {
    nome: valueOrFallback(extracted.nome, filename.nome || asset.nome || ''), autor: extracted.autor?.length ? extracted.autor : filename.autor,
    isbn: extracted.isbn || filename.isbn || '', isbn10: extracted.isbn10 || filename.isbn10 || '', isbn13: extracted.isbn13 || filename.isbn13 || '',
    editora: extracted.editora || '', ano: extracted.ano || null, evidence: { ...filename.evidence, ...(extracted.evidence || {}) }
  };
  logger.info('metadata.extraction.completed', { bookId: id, isbn: local.isbn13 || local.isbn10 || null });
  const candidates = await buscarCandidatos(local);
  const ranked = candidates.map((candidate) => ({ candidate, ...scoreCandidate(local, candidate) })).sort((a, b) => b.score - a.score);
  const selected = ranked[0] || null;
  if (selected) logger.info('metadata.candidate.selected', { bookId: id, source: selected.candidate.source, score: selected.score });
  const merged = montarLivroPipeline({ ...asset, id }, persisted, filename, extracted, selected, ranked);
  await salvarLivro(merged);
  logger.info('metadata.enrichment.completed', { bookId: id, status: merged.metadataStatus });
  return merged;
}

enrichmentQueue.register('metadata', ({ asset, forceRefresh }) => enriquecerLivro(asset, { forceRefresh }));

export async function precisaEnriquecer(asset) {
  const persisted = await findBook(asset?.id);
  if (!persisted) return true;
  if (asset.fileFingerprint && persisted.fileFingerprint !== asset.fileFingerprint) return true;
  if (persisted.metadataStatus === 'pending') return true;
  return calcularStale(persisted.metadataLastChecked || persisted.updated_at);
}

export function enfileirarEnriquecimento(asset, { forceRefresh = false, priority = 'normal' } = {}) {
  if (!asset?.id || env.metadataEnrichConcurrency <= 0) return null;
  const job = enrichmentQueue.enqueue('metadata', { asset, forceRefresh }, {
    priority,
    dedupeKey: `metadata:${asset.id}`,
    maxAttempts: 3
  });
  // A fila nunca deve gerar unhandled rejection quando o disparo vier da listagem.
  job.catch(() => {});
  return job;
}

export function estadoFilaEnriquecimento() {
  return { ...enrichmentQueue.status('metadata'), concurrency: Math.max(0, env.metadataEnrichConcurrency) };
}

export async function listarLivrosParaRevisao() {
  return listBooksForReview();
}

export async function atualizarCapaCache(id, { coverPath, coverFingerprint, coverSource = 'pdf_page' } = {}, asset = null) {
  const persistido = await findBook(id);
  const livro = persistido || (asset ? { ...asset, drive_id: asset.driveId || asset.sourceId || asset.id } : null);
  if (!livro) return null;
  return salvarLivro({
    ...livro,
    coverPath: coverPath || livro.coverPath || '',
    coverFingerprint: coverFingerprint || livro.coverFingerprint || '',
    coverGeneratedAt: new Date().toISOString(),
    coverSource,
    // A URL externa deixa de ser necessária quando a miniatura local existe.
    capa: livro.manualFields?.includes('capa') ? livro.capa : ''
  });
}

export async function listarLivrosPersistidos() {
  return listBooks();
}

export async function buscarLivroPersistidoPorId(id) {
  return findBook(id);
}

export async function buscarLivroPersistidoPorISBN(isbn) {
  return findBookByIsbn(normalizeIsbn(isbn));
}

export async function atualizarMetadadosManuais(id, patch = {}) {
  const existente = await findBook(id);
  if (!existente) {
    return null;
  }

  if (patch.aceitarRevisao) {
    return salvarLivro({
      ...existente,
      needsReview: false,
      metadataStatus: existente.metadataConfidence >= env.metadataReviewThreshold ? 'partial' : 'completed',
      metadataLastChecked: new Date().toISOString()
    });
  }

  const editableFields = ['nome', 'autor', 'editora', 'ano', 'isbn', 'descricao', 'capa', 'capaCor', 'tags'];
  const isbnManual = patch.isbn ? normalizeValidIsbn(patch.isbn) : existente.isbn;
  const manualFields = [...new Set([...(existente.manualFields || []), ...editableFields.filter((field) => patch[field] !== undefined && patch[field] !== '')])];
  const atualizado = {
    ...existente,
    ...patch,
    id: existente.id,
    drive_id: existente.drive_id,
    tags: Array.isArray(patch.tags) ? patch.tags : existente.tags,
    subcategorias: Array.isArray(patch.subcategorias) ? patch.subcategorias : existente.subcategorias,
    autor: patch.autor ? splitAuthors(patch.autor) : existente.autor,
    isbn: isbnManual || existente.isbn,
    categoria: patch.categoria || existente.categoria,
    metadadosCompletos: {
      ...(existente.metadadosCompletos || {}),
      manualUpdate: patch
    },
    manualFields,
    metadataStatus: 'completed',
    metadataSource: 'manual',
    metadataLastChecked: new Date().toISOString(),
    needsReview: false
  };

  return salvarLivro({
    ...existente,
    ...atualizado,
    capa: patch.capa || existente.capa,
    capaCor: patch.capaCor || existente.capaCor
  });
}

export async function registrarLeitura(id) {
  return updateLastRead(id);
}

export async function listarCategoriasPersistidas() {
  return listCategories();
}

export function extrairEstatisticasLivros(livros = []) {
  return livros.reduce(
    (acc, livro) => {
      if (livro.categoria) {
        acc.categorias.add(livro.categoria);
      }

      for (const tag of livro.tags || []) {
        acc.tags.add(tag);
      }

      if (livro.autor) {
        for (const autor of splitAuthors(livro.autor)) {
          acc.autores.add(autor);
        }
      }

      if (livro.editora) {
        acc.editoras.add(livro.editora);
      }

      if (livro.ano) {
        acc.anos.push(livro.ano);
      }

      return acc;
    },
    {
      categorias: new Set(),
      tags: new Set(),
      autores: new Set(),
      editoras: new Set(),
      anos: []
    }
  );
}

export async function livroExistePersistido(id) {
  return bookExists(id);
}

export async function atualizarCategoriaPersistida(nome, icone = '', cor = '') {
  return upsertCategory(nome, icone, cor);
}
