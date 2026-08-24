#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);

const argumentos = new Set(process.argv.slice(2).filter((item) => !item.startsWith('--root=')));
const rootArgument = process.argv.find((item) => item.startsWith('--root='))?.slice('--root='.length);
const projectRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const configuredRoot = rootArgument || process.env.LOCAL_LIBRARY_DIR || 'storage/pdfs';
const raiz = path.resolve(path.isAbsolute(configuredRoot) ? configuredRoot : path.join(projectRoot, configuredRoot));
const aplicar = argumentos.has('--apply');
const permitirIncompletos = argumentos.has('--allow-missing');
const padraoEsperado = /^.+\s+-\s+.+\s+-\s+(?:\d{10}|\d{13})\.pdf$/i;
const resultadosOnline = new Map();

function normalizarIsbn(valor = '') {
  const isbn = String(valor).toUpperCase().replace(/[^0-9X]/g, '');
  if (['0123456789', '0000100110'].includes(isbn)) return '';
  if (isbn.length === 10 && /^[0-9]{9}[0-9X]$/.test(isbn)) {
    const soma = [...isbn].reduce((total, digito, indice) => total + (digito === 'X' ? 10 : Number(digito)) * (10 - indice), 0);
    return soma % 11 === 0 ? isbn : '';
  }
  if (isbn.length === 13 && /^97[89][0-9]{10}$/.test(isbn)) {
    const soma = [...isbn].reduce((total, digito, indice) => total + Number(digito) * (indice % 2 ? 3 : 1), 0);
    return soma % 10 === 0 ? isbn : '';
  }
  return '';
}

function extrairIsbn(texto = '') {
  const conteudo = String(texto);
  const padrao = /((?:97[89][\s-]?)?\d[\d\s-]{8,}\d|\d[\d\s-]{8,}[\dX])/gi;
  const candidatos = [
    ...conteudo.matchAll(/ISBN(?:-1[03])?\s*[:#-]?\s*((?:97[89][\s-]?)?\d[\d\s-]{8,}\d|\d[\d\s-]{8,}[\dX])/gi),
    ...conteudo.matchAll(padrao)
  ];
  return candidatos.map((match) => normalizarIsbn(match[1])).find(Boolean) || '';
}

function limparTexto(valor = '') {
  return String(valor)
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*[-–—]\s*$/g, '')
    .trim();
}

function valorUtilizável(valor = '') {
  const texto = limparTexto(valor);
  return Boolean(texto && !/^(?:autor desconhecido|unknown|sem título|sem isbn|livro[_ -]?unico|ebook|documento)$/i.test(texto));
}

function extrairTituloDaPrimeiraPagina(texto = '') {
  const linhas = String(texto)
    .split(/\r?\n/)
    .map((linha) => limparTexto(linha))
    .filter((linha) => linha.length >= 4)
    .filter((linha) => !/^https?:\/\//i.test(linha))
    .filter((linha) => !/^(?:isbn|sumário|contents|casa do código|casa do codigo|o'reilly|novatec|caelum|packt)$/i.test(linha));
  return linhas.find((linha) => !/^\d[\d\s.,:/-]*$/.test(linha)) || '';
}

function metadadosDoNome(nomeArquivo) {
  const baseOriginal = path.basename(nomeArquivo, path.extname(nomeArquivo))
    .replace(/\s+/g, ' ')
    .trim();
  const grupos = [...baseOriginal.matchAll(/\(([^()]*)\)/g)]
    .map((match) => match[1].trim())
    .filter((grupo) => grupo && !/(?:z-library|1lib|z-lib|pdfdrive)/i.test(grupo));
  const autorEntreParenteses = grupos.at(-1) || '';
  const base = baseOriginal
    .replace(/\([^)]*(?:z-library|1lib|z-lib|pdfdrive)[^)]*\)/gi, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const isbn = extrairIsbn(base);
  const semIsbn = isbn ? base.replace(new RegExp(`(?:ISBN(?:-1[03])?\\s*[:#-]?\\s*)?${isbn.replace(/(\d)/g, '$1[\\s-]?')}$`, 'i'), '').trim() : base;
  const partes = semIsbn.replace(/\s+-\s+Sem ISBN\s*$/i, '').split(/\s+-\s+/).map((parte) => parte.trim()).filter(Boolean);

  return {
    titulo: partes[0] || '',
    autor: autorEntreParenteses || (partes.length > 1 ? partes[partes.length - 1] : ''),
    isbn,
    estruturado: Boolean(isbn || partes.length > 1)
  };
}

async function extrairMetadadosPdf(arquivo) {
  try {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: await fs.readFile(arquivo) });
    const infoData = await parser.getInfo();
    const textData = await parser.getText();
    await parser.destroy();
    const info = infoData.info || {};
    let textoExterno = '';
    try {
      const [documento, primeiraPagina] = await Promise.all([
        execFileAsync('pdftotext', [arquivo, '-'], { maxBuffer: 50 * 1024 * 1024 }),
        execFileAsync('pdftotext', ['-f', '1', '-l', '1', arquivo, '-'], { maxBuffer: 5 * 1024 * 1024 })
      ]);
      textoExterno = documento.stdout || '';
      textoExterno = `${primeiraPagina.stdout || ''}\n${textoExterno}`;
    } catch {
      // O parser JavaScript continua sendo usado quando o Poppler não estiver instalado.
    }
    const texto = [textoExterno, textData.text, info.Title, info.Author, info.Subject, info.Keywords].filter(Boolean).join('\n');
    const primeiraPagina = textoExterno.split(/\f/)[0] || textoExterno.slice(0, 4000);
    return {
      titulo: limparTexto(info.Title || ''),
      autor: limparTexto(info.Author || ''),
      isbn: extrairIsbn(texto),
      primeiraPagina: limparTexto(primeiraPagina),
      tituloPrimeiraPagina: extrairTituloDaPrimeiraPagina(primeiraPagina)
    };
  } catch (erro) {
    console.warn(`  Aviso: não foi possível ler metadados (${erro.message})`);
    return {};
  }
}

async function buscarJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resposta = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    return resposta.ok ? resposta.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizarBusca(valor = '') {
  return String(valor).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function titulosCompatíveis(primeiro, segundo) {
  const a = new Set(normalizarBusca(primeiro).split(' ').filter((item) => item.length > 2));
  const b = new Set(normalizarBusca(segundo).split(' ').filter((item) => item.length > 2));
  if (!a.size || !b.size) return false;
  const iguais = [...a].filter((item) => b.has(item)).length;
  return iguais / Math.min(a.size, b.size) >= 0.6;
}

function autorUtilizável(autor = '') {
  return Boolean(autor && !/^(?:autor desconhecido|unknown|n ?a)$/i.test(autor) && !/^\d[\d\s_-]*$/.test(autor));
}

function escolherIdentificador(identificadores = []) {
  const isbn13 = identificadores
    .filter((item) => item.type === 'ISBN_13')
    .map((item) => normalizarIsbn(item.identifier))
    .find(Boolean);
  return isbn13 || identificadores.map((item) => normalizarIsbn(item.identifier)).find(Boolean) || '';
}

function metadadosGoogle(item) {
  const info = item?.volumeInfo || {};
  return {
    titulo: limparTexto(info.title || ''),
    autor: limparTexto((info.authors || []).join(', ')),
    isbn: escolherIdentificador(info.industryIdentifiers || [])
  };
}

function metadadosOpenLibrary(item) {
  return {
    titulo: limparTexto(item?.title || ''),
    autor: limparTexto((item?.author_name || []).join(', ')),
    isbn: (item?.isbn || []).map(normalizarIsbn).find(Boolean) || ''
  };
}

function candidatoCompatível(candidato, titulo, autor) {
  if (!candidato.titulo || !titulosCompatíveis(titulo, candidato.titulo)) return false;
  if (!autorUtilizável(autor) || !candidato.autor) return true;
  const esperado = normalizarBusca(autor);
  const encontrado = normalizarBusca(candidato.autor);
  return encontrado.includes(esperado) || esperado.includes(encontrado);
}

async function buscarMetadadosOnline(titulo, autor, primeiraPagina = '') {
  const chave = `${normalizarBusca(titulo)}|${normalizarBusca(autor)}`;
  if (resultadosOnline.has(chave)) return resultadosOnline.get(chave);

  const tituloBusca = titulo || primeiraPagina.slice(0, 500);
  const autorBusca = autorUtilizável(autor) ? autor : '';
  const consulta = [tituloBusca, autorBusca].filter(Boolean).join(' ');
  if (!consulta) return {};

  const googleUrl = new URL('https://www.googleapis.com/books/v1/volumes');
  googleUrl.searchParams.set('q', consulta);
  googleUrl.searchParams.set('maxResults', '20');
  if (process.env.GOOGLE_BOOKS_API_KEY) googleUrl.searchParams.set('key', process.env.GOOGLE_BOOKS_API_KEY);
  const google = await buscarJson(googleUrl);
  const googleLivro = (google?.items || [])
    .map(metadadosGoogle)
    .find((item) => candidatoCompatível(item, tituloBusca, autorBusca));
  if (googleLivro?.isbn) {
    resultadosOnline.set(chave, googleLivro);
    return googleLivro;
  }

  const openLibraryUrl = new URL('https://openlibrary.org/search.json');
  // A busca combinada é mais tolerante com títulos traduzidos, pontuação e
  // diferenças de grafia do que os filtros title/author separados.
  openLibraryUrl.searchParams.set('q', consulta);
  openLibraryUrl.searchParams.set('limit', '20');
  openLibraryUrl.searchParams.set('fields', 'title,author_name,isbn');
  const openLibrary = await buscarJson(openLibraryUrl);
  const openLivro = (openLibrary?.docs || [])
    .map(metadadosOpenLibrary)
    .find((item) => candidatoCompatível(item, tituloBusca, autorBusca));
  const resultado = openLivro?.isbn ? openLivro : {};
  resultadosOnline.set(chave, resultado);
  return resultado;
}

async function listarPdfs(diretorio) {
  const encontrados = [];
  for (const entrada of await fs.readdir(diretorio, { withFileTypes: true })) {
    const caminho = path.join(diretorio, entrada.name);
    if (entrada.isDirectory()) encontrados.push(...await listarPdfs(caminho));
    else if (entrada.isFile() && path.extname(entrada.name).toLowerCase() === '.pdf') encontrados.push(caminho);
  }
  return encontrados;
}

async function executar() {
  try {
    await fs.access(raiz);
  } catch {
    console.error(`Pasta não encontrada: ${raiz}`);
    process.exitCode = 1;
    return;
  }

  const arquivos = await listarPdfs(raiz);
  let renomeados = 0;
  let ignorados = 0;

  console.log(`${aplicar ? 'Aplicando' : 'Simulação'} em: ${raiz}`);
  if (!aplicar) console.log('Nenhum arquivo será alterado. Use --apply para confirmar.\n');

  for (const arquivo of arquivos) {
    const nomeArquivo = path.basename(arquivo);
    const peloNome = metadadosDoNome(arquivo);

    // Só ignora o arquivo quando os três campos estão presentes, o ISBN é
    // válido e o nome não usa placeholders. Um nome com “Sem ISBN” sempre
    // passa pela identificação em dois níveis.
    const nomeCompleto = padraoEsperado.test(nomeArquivo) &&
      peloNome.titulo &&
      autorUtilizável(peloNome.autor) &&
      Boolean(normalizarIsbn(peloNome.isbn));
    if (nomeCompleto) continue;

    const peloPdf = await extrairMetadadosPdf(arquivo);
    const tituloDoNome = valorUtilizável(peloNome.titulo) ? limparTexto(peloNome.titulo) : '';
    const tituloDoPdf = valorUtilizável(peloPdf.titulo) ? limparTexto(peloPdf.titulo) : '';
    const tituloDaCapa = valorUtilizável(peloPdf.tituloPrimeiraPagina) ? limparTexto(peloPdf.tituloPrimeiraPagina) : '';
    const titulo = limparTexto(tituloDoNome || tituloDoPdf || tituloDaCapa);
    const autorDoNome = peloNome.autor &&
      autorUtilizável(peloNome.autor)
      ? peloNome.autor
      : '';
    const autorDoPdf = autorUtilizável(peloPdf.autor) ? peloPdf.autor : '';
    const autor = limparTexto(autorDoNome || autorDoPdf);
    const isbnLocal = normalizarIsbn(peloNome.isbn || peloPdf.isbn);
    const online = await buscarMetadadosOnline(titulo, autor, peloPdf.primeiraPagina);
    const tituloFinal = limparTexto(online.titulo || titulo || (permitirIncompletos ? 'Sem título' : ''));
    const autorFinal = limparTexto(online.autor || autor || (permitirIncompletos ? 'Autor desconhecido' : ''));
    const isbnFinal = normalizarIsbn(isbnLocal || online.isbn) || (permitirIncompletos ? 'Sem ISBN' : '');

    if (!tituloFinal || !autorFinal || !isbnFinal) {
      console.log(`IGNORADO: ${path.relative(raiz, arquivo)} (faltam ${[
        !tituloFinal && 'título', !autorFinal && 'autor', !isbnFinal && 'ISBN'
      ].filter(Boolean).join(', ')})`);
      ignorados += 1;
      continue;
    }

    if (online.isbn && online.isbn !== isbnLocal) {
      console.log(`  ISBN encontrado online: ${online.isbn}`);
    }

    const nomeNovo = `${tituloFinal} - ${autorFinal} - ${isbnFinal}.pdf`;
    const destino = path.join(path.dirname(arquivo), nomeNovo);
    if (path.basename(arquivo) === nomeNovo) continue;

    try {
      await fs.access(destino);
      console.log(`CONFLITO: ${path.relative(raiz, destino)} já existe`);
      ignorados += 1;
      continue;
    } catch {
      // destino livre
    }

    console.log(`${aplicar ? 'RENOMEAR' : 'PREVIEW'}: ${path.relative(raiz, arquivo)}\n       -> ${path.relative(raiz, destino)}`);
    if (aplicar) await fs.rename(arquivo, destino);
    renomeados += 1;
  }

  console.log(`\nFinalizado: ${renomeados} ${aplicar ? 'renomeado(s)' : 'alteração(ões) prevista(s)'}, ${ignorados} ignorado(s).`);
}

executar().catch((erro) => {
  console.error(erro);
  process.exitCode = 1;
});
