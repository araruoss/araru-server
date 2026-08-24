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
import { listarPaginasLivro, obterPaginaLivro, obterRecursoMobi } from '../services/readerService.js';
import path from 'path';
import { buscarIdsIndexados } from '../services/libraryIndexService.js';
import { agruparCatalogoPorObra } from '../services/workService.js';
import { getPreferences } from '../services/productService.js';
import { findBook as findBookPostgres, findBookByIsbn as findBookByIsbnPostgres, listBooksForReview as listBooksForReviewPostgres } from '../services/metadataRepository.js';

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

export async function listarLivros(req, res, next) {
  try {
    const arquivos = await obterLivros({ forceRefresh: req.query.refresh === 'true' });
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
    const livros = await obterLivros();
    const filtrados = livros.filter((livro) => normalizarBusca(livro.categoria) === categoria);

    return res.json({ data: filtrados, total: filtrados.length });
  } catch (error) {
    return next(error);
  }
}

export async function buscarLivros(req, res, next) {
  try {
    const termo = normalizarBusca(req.query.q);
    const livros = await obterLivros();
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
    const livros = await obterLivros();
    const livroAtual = livros.find((item) => item.id === req.params.id);
    const livro = livroAtual || await findBookPostgres(req.params.id);

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
    const conteudo = await obterConteudoLivro(req.params.id);
    if (!conteudo) {
      return res.status(404).json({ message: 'Livro nao encontrado.' });
    }

    res.type(conteudo.mimeType);
    res.set('Content-Disposition', contentDispositionInline(conteudo.livro.nome, conteudo.livro.formato));

    if (['mobi', 'cbr'].includes(conteudo.livro.formato)) {
      const renderizado = await renderizarLivroCompactado(conteudo, req.query.pagina);
      if (renderizado?.kind === 'html') return res.type('html').send(renderizado.data);
      if (renderizado?.kind === 'image') {
        res.set('X-Total-Paginas', String(renderizado.total));
        return res.type(renderizado.mimeType).send(renderizado.data);
      }
      return res.status(422).json({ message: 'Nao foi possivel renderizar este arquivo.' });
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

    return conteudo.stream.pipe(res);
  } catch (error) {
    return next(error);
  }
}

export async function listarPaginasLeitura(req, res, next) {
  try {
    const paginas = await listarPaginasLivro(req.params.id);
    if (!paginas) return res.status(422).json({ message: 'Paginação indisponível para este arquivo.' });
    return res.json(paginas);
  } catch (error) { return next(error); }
}

export async function servirPaginaLeitura(req, res, next) {
  try {
    const pagina = await obterPaginaLivro(req.params.id, req.params.page);
    if (!pagina) return res.status(404).end();
    return res.type(pagina.mimeType).set('X-Total-Paginas', String(pagina.total)).set('Cache-Control', 'private, max-age=300').send(pagina.data);
  } catch (error) { return next(error); }
}

export async function servirRecursoMobi(req, res, next) {
  try {
    const recurso = await obterRecursoMobi(req.params.id, req.params.recindex);
    if (!recurso) return res.status(404).end();
    return res.type(recurso.mimeType).set('Cache-Control', 'private, max-age=3600').send(recurso.data);
  } catch (error) { return next(error); }
}

export async function servirCapaLivro(req, res, next) {
  try {
    const capa = await obterCapaLivro(req.params.id);
    if (!capa) return res.status(404).end();
    const cacheControl = req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=3600, must-revalidate';
    return res.type(capa.mimeType).set('Cache-Control', cacheControl).send(capa.data);
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
