import path from 'node:path';
import { cleanDisplayText, cleanFilenameWords, isUsefulMetadata } from './normalizer.js';
import { extractIsbns, isbnForms } from './isbn.js';

function removeIsbn(value, isbns) {
  let result = value;
  for (const isbn of isbns) {
    const flexible = isbn.split('').join('[\\s-]?');
    result = result.replace(new RegExp(`(?:isbn(?:-1[03])?\\s*[:#-]?\\s*)?${flexible}`, 'ig'), ' ');
  }
  return result;
}

function inferAuthor(raw = '') {
  const candidate = raw
    .replace(/[_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const match = candidate.match(/(?:^|[-–—])\s*([A-ZÀ-Ý][a-zà-ÿ'’.-]+(?:\s*[-–—]\s*|\s+)[A-ZÀ-Ý][a-zà-ÿ'’.-]+(?:\s*[-–—]\s*|\s+[A-ZÀ-Ý][a-zà-ÿ'’.-]+){0,2})\s*$/);
  return match ? cleanDisplayText(match[1].replace(/[-–—]/g, ' ')) : '';
}

export function parseFilename(filename = '') {
  const originalFilename = path.basename(filename);
  const extension = path.extname(originalFilename).slice(1).toLowerCase();
  const stem = path.basename(originalFilename, path.extname(originalFilename));
  const isbns = extractIsbns(stem);
  const forms = isbnForms(isbns[0]);
  const withoutIsbn = removeIsbn(stem, isbns)
    .replace(/^\s*(?:\d{6,}[-_.\s]+)+/, '')
    .replace(/\b\d{5,}\b/g, '')
    .replace(/[_.]+/g, ' ')
    .replace(/\s*[-–—]\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
  const author = inferAuthor(withoutIsbn);
  const titleRaw = author
    ? withoutIsbn
      .split(/\s*[-–—]\s*/)
      .slice(0, -author.split(/\s+/).length)
      .join(' ')
    : withoutIsbn;
  const title = cleanFilenameWords(titleRaw.replace(/[-–—]/g, ' ').replace(/\b\d{5,}\b/g, ''));

  return {
    originalFilename,
    extension,
    nome: isUsefulMetadata(title) ? title : '',
    autor: isUsefulMetadata(author) ? [author] : [],
    isbn: isbns[0] || '',
    ...forms,
    evidence: {
      filename: true,
      filenameIsbn: Boolean(isbns[0])
    }
  };
}
