import { env } from '../../config/drive.js';
import { extractYear } from './normalizer.js';
import { isbnForms, normalizeIsbn } from './isbn.js';
import { getCachedApiResult, setCachedApiResult } from './apiCache.js';
import { breakerFor } from '../circuitBreaker.js';

async function cached(key, provider, queryType, request) {
  const cachedResult = await getCachedApiResult(key);
  if (cachedResult) return cachedResult;
  const result = await request();
  await setCachedApiResult(key, provider, queryType, result, result.length > 0);
  return result;
}

function coverFromGoogle(images = {}) {
  const url = images.extraLarge || images.large || images.medium || images.small || images.thumbnail || images.smallThumbnail || '';
  return url.replace(/^http:/, 'https:').replace(/zoom=1/, 'zoom=2');
}

async function fetchJsonWithRetry(url, attempts = env.metadataMaxRetries, provider = url.hostname) {
  return breakerFor(provider).execute(async () => {
  let lastError;
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.metadataRequestTimeout);
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
      if (response.ok) return response.json();
      if (![429, 500, 502, 503, 504].includes(response.status)) throw new Error(`HTTP ${response.status}`);
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  }
  throw lastError || new Error('Consulta externa indisponível');
  });
}

function parseGoogle(volume) {
  const info = volume?.volumeInfo || {};
  const identifiers = info.industryIdentifiers || [];
  const isbn = identifiers.map((item) => normalizeIsbn(item.identifier)).find(Boolean) || '';
  return {
    nome: info.title || '',
    autor: info.authors || [],
    editora: info.publisher || '',
    ano: extractYear(info.publishedDate),
    ...isbnForms(isbn),
    isbn,
    descricao: info.description || '',
    capa: coverFromGoogle(info.imageLinks),
    avaliacao: typeof info.averageRating === 'number' ? info.averageRating : null,
    numeroPaginas: info.pageCount || null,
    idioma: info.language || '',
    tags: info.categories || [],
    source: 'google_books'
  };
}

function parseOpenLibrary(book) {
  const isbn = normalizeIsbn((book?.identifiers?.isbn_13 || book?.identifiers?.isbn_10 || [])[0] || '');
  return {
    nome: book?.title || '',
    autor: (book?.authors || []).map((item) => item.name).filter(Boolean),
    editora: (book?.publishers || []).map((item) => item.name).filter(Boolean).join(', '),
    ano: extractYear(book?.publish_date),
    ...isbnForms(isbn),
    isbn,
    descricao: book?.excerpts?.[0]?.text || book?.notes || '',
    capa: book?.cover?.large || book?.cover?.medium || book?.cover?.small || '',
    numeroPaginas: book?.number_of_pages || null,
    idioma: (book?.languages || []).map((item) => item.key?.split('/').pop()).find(Boolean) || '',
    tags: (book?.subjects || []).map((item) => item.name).filter(Boolean),
    source: 'open_library'
  };
}

export async function googleBooksByIsbn(isbn) {
  const key = `google:isbn:${isbn}`;
  return cached(key, 'google', 'isbn', async () => {
  const url = new URL('https://www.googleapis.com/books/v1/volumes');
  url.searchParams.set('q', `isbn:${isbn}`);
  url.searchParams.set('maxResults', '5');
  if (env.googleBooksApiKey) url.searchParams.set('key', env.googleBooksApiKey);
  const data = await fetchJsonWithRetry(url);
  return (data.items || []).map(parseGoogle);
  });
}

export async function openLibraryByIsbn(isbn) {
  const key = `openlibrary:isbn:${isbn}`;
  return cached(key, 'openlibrary', 'isbn', async () => {
  const url = new URL(env.openLibraryApiUrl);
  url.searchParams.set('bibkeys', `ISBN:${isbn}`);
  url.searchParams.set('format', 'json');
  url.searchParams.set('jscmd', 'data');
  const data = await fetchJsonWithRetry(url);
  const result = data[`ISBN:${isbn}`];
  return result ? [parseOpenLibrary(result)] : [];
  });
}

export async function googleBooksByText(title, author = '') {
  const key = `google:text:${encodeURIComponent(`${title}|${author}`.toLowerCase())}`;
  return cached(key, 'google', 'text', async () => {
  const url = new URL('https://www.googleapis.com/books/v1/volumes');
  url.searchParams.set('q', [title, author ? `inauthor:${author}` : ''].filter(Boolean).join(' '));
  url.searchParams.set('maxResults', '5');
  if (env.googleBooksApiKey) url.searchParams.set('key', env.googleBooksApiKey);
  const data = await fetchJsonWithRetry(url);
  return (data.items || []).map(parseGoogle);
  });
}

export async function openLibraryByText(title, author = '') {
  const key = `openlibrary:text:${encodeURIComponent(`${title}|${author}`.toLowerCase())}`;
  return cached(key, 'openlibrary', 'text', async () => {
  const url = new URL('https://openlibrary.org/search.json');
  url.searchParams.set('title', title);
  if (author) url.searchParams.set('author', author);
  url.searchParams.set('limit', '5');
  url.searchParams.set('fields', 'title,author_name,isbn,publisher,first_publish_year,cover_i,subject');
  const data = await fetchJsonWithRetry(url);
  return (data.docs || []).map((item) => {
    const isbn = (item.isbn || []).map(normalizeIsbn).find(Boolean) || '';
    return {
      nome: item.title || '', autor: item.author_name || [], editora: (item.publisher || [])[0] || '',
      ano: item.first_publish_year || null, ...isbnForms(isbn), isbn,
      capa: item.cover_i ? `https://covers.openlibrary.org/b/id/${item.cover_i}-L.jpg` : '',
      tags: item.subject || [], source: 'open_library'
    };
  });
  });
}
