import {
  obterCategorias,
  obterArvoreCategorias,
  obterLivros,
  sincronizarCategoriasPersistidas
} from '../services/driveService.js';
import {
  atualizarMetadadosManuais,
  buscarLivroPersistidoPorId,
  buscarLivroPersistidoPorISBN,
  enfileirarEnriquecimento,
  estadoFilaEnriquecimento,
  precisaEnriquecer,
  listarLivrosParaRevisao
} from '../services/metadataService.js';
import { obterCapaLivro, obterConteudoLivro, renderizarLivroCompactado } from '../services/driveService.js';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { listarPaginasLivro, obterManifestoLeitura, obterPaginaLivro, obterRecursoMobi } from '../services/readerService.js';
import path from 'path';
import { createHash } from 'node:crypto';
import { buscarIdsIndexados } from '../services/libraryIndexService.js';
import { agruparCatalogoPorObra } from '../services/workService.js';
import { getPreferences } from '../services/productService.js';
import { findBook as findBookPostgres, findBookByIsbn as findBookByIsbnPostgres, listBooksForReview as listBooksForReviewPostgres } from '../services/metadataRepository.js';
import { registrarStorageMetric } from '../services/runtimeMetrics.js';
import { logger } from '../services/logger.js';
import { canAccessSource, effectiveAccess, filterAccessibleBooks } from '../services/authorizationService.js';

function normalizarBusca(texto = '') {
  return texto
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function contentDispositionInline(nome = 'livro', formato = '') {
  const extensao = formato ? `.${formato.replace(/^\./, '')}` : '';
  const arquivo = path.extname(nome) ? path.basename(nome) : `${path.basename(nome)}${extensao}`;
  const fallback = arquivo
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/["\\\r\n]/g, '_')
    .trim() || `livro${extensao}`;

  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(arquivo)}`;
}

async function scopedBooks(req, options = {}) {
  const books = await obterLivros(options);
  return filterAccessibleBooks(books, await effectiveAccess(req.user.id));
}

async function isAccessible(req, book) {
  return Boolean(book) && await canAccessSource(req.user.id, book.source || book.fonte || book.libraryId);
}

export async function listarLivros(req, res, next) {
  try {
    const arquivos = await scopedBooks(req, { forceRefresh: req.query.refresh === 'true' });
    for (const livro of arquivos) {
      if (await precisaEnriquecer(livro)) {
        enfileirarEnriquecimento(livro);
      }
    }
    const preferences = await getPreferences(req.profileId || req.cookies?.biblioteca_profile || 'default');
    const order = [...(preferences.preferredFormats?.reflowable || []), ...(preferences.preferredFormats?.comic || [])];
    const livros = await agruparCatalogoPorObra(arquivos, order);
    return res.json({ data: livros, total: livros.length, filesTotal: arquivos.length });
  } catch (error) {
    return next(error);
  }
}

export async function listarPorCategoria(req, res, next) {
  try {
    const categoria = normalizarBusca(req.params.categoria);
    const livros = await scopedBooks(req);
    const filtrados = livros.filter((livro) => normalizarBusca(livro.categoria) === categoria);

    return res.json({ data: filtrados, total: filtrados.length });
  } catch (error) {
    return next(error);
  }
}

export async function buscarLivros(req, res, next) {
  try {
    const termo = normalizarBusca(req.query.q);
    const livros = await scopedBooks(req);
    const idsIndexados = termo ? await buscarIdsIndexados(termo) : [];
    const ordemIndexada = new Map(idsIndexados.map((id, index) => [id, index]));
    const filtrados = termo
      ? livros.filter((livro) => {
          const campoBusca = [
            livro.nome,
            Array.isArray(livro.autor) ? livro.autor.join(' ') : livro.autor,
            livro.editora,
            livro.descricao,
            livro.isbn,
            livro.isbn10,
            livro.isbn13,
            livro.normalizedTitle,
            livro.normalizedAuthor,
            Array.isArray(livro.tags) ? livro.tags.join(' ') : livro.tags
          ]
            .filter(Boolean)
            .join(' ');

          return ordemIndexada.has(livro.id) || normalizarBusca(campoBusca).includes(termo);
        })
      : livros;

    filtrados.sort((a, b) => (ordemIndexada.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (ordemIndexada.get(b.id) ?? Number.MAX_SAFE_INTEGER));
    const preferences = await getPreferences(req.profileId || req.cookies?.biblioteca_profile || 'default');
    const preferredFormats = [...(preferences.preferredFormats?.reflowable || []), ...(preferences.preferredFormats?.comic || [])];
    const obras = await agruparCatalogoPorObra(filtrados, preferredFormats);
    const rank = (obra) => Math.min(...(obra.files?.length ? obra.files : [obra]).map((file) => ordemIndexada.get(file.id) ?? Number.MAX_SAFE_INTEGER));
    obras.sort((a, b) => rank(a) - rank(b));

    return res.json({ data: obras, total: obras.length, filesTotal: filtrados.length });
  } catch (error) {
    return next(error);
  }
}

export async function listarCategorias(req, res, next) {
  try {
    const categorias = await obterCategorias();
    const total = categorias.reduce((acc, categoria) => acc + categoria.total, 0);

    return res.json({
      data: [{ nome: 'Todos', total }, ...categorias],
      total: categorias.length
    });
  } catch (error) {
    return next(error);
  }
}

export async function listarArvoreCategorias(req, res, next) {
  try {
    const tree = await obterArvoreCategorias();
    return res.json({ data: tree });
  } catch (error) {
    return next(error);
  }
}

export async function buscarLivroPorIsbn(req, res, next) {
  try {
    const livro = await findBookByIsbnPostgres(req.params.isbn);
    if (!livro) {
      return res.status(404).json({ message: 'Livro nao encontrado.' });
    }

    return res.json({ data: livro });
  } catch (error) {
    return next(error);
  }
}

export async function listarMetadadosLivro(req, res, next) {
  try {
    const livros = await scopedBooks(req);
    const livroAtual = livros.find((item) => item.id === req.params.id);
    const livro = livroAtual;

    if (!livro) {
      return res.status(404).json({ message: 'Livro nao encontrado.' });
    }

    const persistido = await findBookPostgres(livro.id);
    if (await precisaEnriquecer(livro)) {
      enfileirarEnriquecimento(livro);
    }
    return res.json({
      data: {
        ...(persistido || livro),
        formato: livro.formato || persistido?.formato,
        contentUrl: livro.contentUrl || persistido?.contentUrl,
        previewUrl: livro.previewUrl || persistido?.previewUrl,
        capaUrl: livro.capaUrl || persistido?.capaUrl,
        fonte: livro.fonte || persistido?.fonte
      }
    });
  } catch (error) {
    return next(error);
  }
}

export async function servirConteudoLivro(req, res, next) {
  try {
    const storageStarted = Date.now();
    res.once('finish', () => registrarStorageMetric({ durationMs: Date.now() - storageStarted, bytes: Number(res.getHeader('content-length') || 0), range: Boolean(req.headers.range), failed: res.statusCode >= 400 }));
    const abortController = new AbortController();
    req.once('aborted', () => abortController.abort());
    const conteudo = await obterConteudoLivro(req.params.id, { range: req.headers.range, signal: abortController.signal });
    if (!conteudo || !(await isAccessible(req, conteudo.livro))) {
      return res.status(404).json({ message: 'Livro nao encontrado.' });
    }

    res.type(conteudo.mimeType);
    res.set('Content-Disposition', contentDispositionInline(conteudo.livro.nome, conteudo.livro.formato));

    if (['mobi', 'cbr'].includes(conteudo.livro.formato)) {
      let renderizado;
      try {
        renderizado = await renderizarLivroCompactado(conteudo, req.query.pagina);
      } catch (error) {
        logger.error('reader.render_failed', { requestId: req.requestId, workId: req.params.id, fileId: conteudo.livro.id, format: conteudo.livro.formato, error });
        return res.status(422).json({ code: 'READER_RENDER_FAILED', message: 'Nao foi possivel processar este arquivo para leitura.' });
      }
      if (renderizado?.kind === 'too_large') return res.status(413).json({ code: 'READER_SIZE_LIMIT', message: 'Este arquivo excede o limite de leitura configurado.' });
      if (renderizado?.kind === 'html') return res.type('html').send(renderizado.data);
      if (renderizado?.kind === 'image') {
        res.set('X-Total-Paginas', String(renderizado.total));
        return res.type(renderizado.mimeType).send(renderizado.data);
      }
      return res.status(422).json({ code: 'READER_EMPTY_CONTENT', message: 'Nao foi possivel renderizar este arquivo.' });
    }

    if (conteudo.filePath) {
      const info = await stat(conteudo.filePath);
      const etag = `"${info.size}-${Math.floor(info.mtimeMs)}"`;
      res.set({ 'Accept-Ranges': 'bytes', 'Content-Length': String(info.size), 'Last-Modified': info.mtime.toUTCString(), ETag: etag, 'Cache-Control': 'private, max-age=0, must-revalidate' });
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      if (req.method === 'HEAD') return res.status(200).end();
      const range = req.headers.range;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) return res.status(416).set('Content-Range', `bytes */${info.size}`).end();
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
        if (start > end || start >= info.size) return res.status(416).set('Content-Range', `bytes */${info.size}`).end();
        res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': String(end - start + 1) });
        return createReadStream(conteudo.filePath, { start, end }).pipe(res);
      }
      return createReadStream(conteudo.filePath).pipe(res);
    }

    if (conteudo.storageProvider) {
      const remote = await conteudo.storageProvider.stream(conteudo.storageKey, req.headers.range, conteudo.providerMetadata, { signal: abortController.signal });
      res.set({ 'Accept-Ranges': 'bytes', 'Content-Length': String(remote.range?.length || remote.size), ...(remote.etag ? { ETag: remote.etag } : {}), ...(remote.modifiedAt ? { 'Last-Modified': new Date(remote.modifiedAt).toUTCString() } : {}), 'Cache-Control': 'private, max-age=0, must-revalidate' });
      if (remote.range) res.status(206).set('Content-Range', `bytes ${remote.range.start}-${remote.range.end}/${remote.size}`);
      if (req.method === 'HEAD') return res.end();
      return remote.stream.pipe(res);
    }

    if (conteudo.range) res.status(206).set({ 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${conteudo.range.start}-${conteudo.range.end}/${conteudo.size}`, 'Content-Length': String(conteudo.range.length) });
    else if (conteudo.size) res.set({ 'Accept-Ranges': 'bytes', 'Content-Length': String(conteudo.size) });
    if (conteudo.etag) res.set('ETag', conteudo.etag);
    if (conteudo.modifiedAt) res.set('Last-Modified', new Date(conteudo.modifiedAt).toUTCString());
    if (req.method === 'HEAD') return res.end();
    return conteudo.stream.pipe(res);
  } catch (error) {
    return next(error);
  }
}

export async function gerarUrlConteudoLivro(req, res, next) {
  try {
    const conteudo = await obterConteudoLivro(req.params.id);
    if (!conteudo || !(await isAccessible(req, conteudo.livro))) return res.status(404).json({ message: 'Livro nao encontrado.' });
    if (!conteudo.storageProvider?.signedReadUrl) return res.status(501).json({ message: 'Entrega assinada não suportada por este provider.' });
    const url = await conteudo.storageProvider.signedReadUrl(conteudo.storageKey);
    return res.json({ url, expiresIn: conteudo.storageProvider.signedUrlTtl });
  } catch (error) { return next(error); }
}

export async function listarPaginasLeitura(req, res, next) {
  try {
    const conteudo = await obterConteudoLivro(req.params.id, { preferirStream: true });
    if (!conteudo || !(await isAccessible(req, conteudo.livro))) return res.status(404).json({ message: 'Livro nao encontrado.' });
    const paginas = await listarPaginasLivro(req.params.id);
    if (!paginas) return res.status(422).json({ message: 'Paginação indisponível para este arquivo.' });
    return res.json(paginas);
  } catch (error) { return next(error); }
}

export async function obterManifestoLeituraController(req, res, next) {
  try {
    const conteudo = await obterConteudoLivro(req.params.id, { preferirStream: true });
    if (!conteudo || !(await isAccessible(req, conteudo.livro))) return res.status(404).json({ message: 'Livro nao encontrado.' });
    const manifest = await obterManifestoLeitura(req.params.id);
    if (!manifest) return res.status(404).json({ message: 'Livro nao encontrado.' });
    const etag = `"${createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}"`;
    if (req.headers['if-none-match'] === etag) return res.status(304).set('ETag', etag).end();
    return res.set({ ETag: etag, 'Cache-Control': 'private, max-age=300', Vary: 'Cookie' }).json(manifest);
  } catch (error) { return next(error); }
}

export async function servirPaginaLeitura(req, res, next) {
  try {
    const conteudo = await obterConteudoLivro(req.params.id, { preferirStream: true });
    if (!conteudo || !(await isAccessible(req, conteudo.livro))) return res.status(404).end();
    const pagina = await obterPaginaLivro(req.params.id, req.params.page);
    if (!pagina) return res.status(404).end();
    return res.type(pagina.mimeType).set('X-Total-Paginas', String(pagina.total)).set('Cache-Control', 'private, max-age=300').send(pagina.data);
  } catch (error) { return next(error); }
}

export async function servirRecursoMobi(req, res, next) {
  try {
    const conteudo = await obterConteudoLivro(req.params.id, { preferirStream: true });
    if (!conteudo || !(await isAccessible(req, conteudo.livro))) return res.status(404).end();
    const recurso = await obterRecursoMobi(req.params.id, req.params.recindex);
    if (!recurso) return res.status(404).end();
    return res.type(recurso.mimeType).set('Cache-Control', 'private, max-age=3600').send(recurso.data);
  } catch (error) { return next(error); }
}

export async function servirCapaLivro(req, res, next) {
  try {
    const obra = await obterConteudoLivro(req.params.id, { preferirStream: true });
    if (!obra || !(await isAccessible(req, obra.livro))) return res.status(404).end();
    const capa = await obterCapaLivro(req.params.id);
    if (!capa) return res.status(404).end();
    const etag = `"${createHash('sha256').update(capa.data).digest('hex')}"`;
    if (req.headers['if-none-match'] === etag) return res.status(304).set('ETag', etag).end();
    const cacheControl = req.query.v ? 'private, max-age=31536000, immutable' : 'private, max-age=3600, must-revalidate';
    return res.type(capa.mimeType).set({ 'Cache-Control': cacheControl, ETag: etag, 'Content-Length': String(capa.data.length), Vary: 'Cookie' }).send(capa.data);
  } catch (error) {
    return next(error);
  }
}

export async function atualizarMetadadosLivro(req, res, next) {
  try {
    const livro = await atualizarMetadadosManuais(req.params.id, req.body || {});
    if (!livro) {
      return res.status(404).json({ message: 'Livro nao encontrado.' });
    }

    return res.json({ data: livro });
  } catch (error) {
    return next(error);
  }
}

export async function enriquecerMetadadosLivro(req, res, next) {
  try {
    const livros = await obterLivros();
    const livro = livros.find((item) => item.id === req.params.id);
    if (!livro) {
      return res.status(404).json({ message: 'Livro nao encontrado.' });
    }

    enfileirarEnriquecimento(livro, { forceRefresh: req.query.mode === 'force' || req.body?.mode === 'force' });
    return res.status(202).json({ message: 'Livro adicionado à fila de enriquecimento.', queue: estadoFilaEnriquecimento() });
  } catch (error) {
    return next(error);
  }
}

export async function enriquecerPendentes(req, res, next) {
  try {
    const modo = req.body?.mode || 'incompletos';
    const livros = await obterLivros();
    const selecionados = livros.filter((livro) => {
      if (modo === 'todos') return true;
      if (modo === 'sem-capa') return !livro.capaUrl && !/^https?:\/\//i.test(livro.capa || '');
      if (modo === 'sem-isbn') return !(livro.isbn13 || livro.isbn10 || livro.isbn);
      if (modo === 'sem-autor') return !Array.isArray(livro.autor) || livro.autor.length === 0;
      return !livro.metadataStatus || ['pending', 'partial', 'review', 'failed'].includes(livro.metadataStatus);
    });
    selecionados.forEach((livro) => enfileirarEnriquecimento(livro, { forceRefresh: modo === 'todos' }));
    return res.status(202).json({ queued: selecionados.length, queue: estadoFilaEnriquecimento() });
  } catch (error) {
    return next(error);
  }
}

export async function listarRevisoesMetadados(req, res, next) {
  try {
    const livros = await listBooksForReviewPostgres();
    return res.json({ data: livros, total: livros.length, queue: estadoFilaEnriquecimento() });
  } catch (error) {
    return next(error);
  }
}

export async function sincronizarCategorias(req, res, next) {
  try {
    await sincronizarCategoriasPersistidas(req.body?.categorias || []);
    return res.json({ message: 'Categorias sincronizadas.' });
  } catch (error) {
    return next(error);
  }
}
