const NOISE_TOKENS = new Set([
  'pdf', 'epub', 'mobi', 'cbz', 'cbr', 'ebook', 'e-book', 'livro', 'download', 'digital',
  'scan', 'scanned', 'isbn', 'copy', 'zlibrary', 'z-library', '1lib', 'pdfdrive'
]);

export function normalizeForMatch(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanDisplayText(value = '') {
  return String(value)
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/[_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\s*[-–—]+|\s*[-–—]+\s*$/g, '')
    .trim();
}

export function isUsefulMetadata(value = '') {
  const normalized = normalizeForMatch(value);
  return Boolean(
    normalized &&
    !/^(autor desconhecido|unknown|sem titulo|sem isbn|ebook|documento|n a|\d+|\d+ of \d+)$/.test(normalized)
  );
}

export function extractYear(value = '') {
  const match = String(value).match(/\b(19\d{2}|20\d{2})\b/);
  return match ? Number(match[1]) : null;
}

export function cleanFilenameWords(value = '') {
  return cleanDisplayText(value)
    .replace(/\[[^\]]*(?:pdf|epub|mobi|ebook|scan)[^\]]*\]/gi, ' ')
    .replace(/\((?:\d+|copy|copia)\)/gi, ' ')
    .replace(/\b(?:sem\s+isbn|no\s+isbn)\b/gi, ' ')
    .replace(/\bautor\s+(?:desconhecido|unknown)\b/gi, ' ')
    .replace(/\b(?:pdf|epub|mobi|cbz|cbr|ebook|e-book|livro|download|digital|scan(?:ned)?|isbn)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function removeNoiseTokens(value = '') {
  return cleanDisplayText(value)
    .split(/\s+/)
    .filter((word) => !NOISE_TOKENS.has(normalizeForMatch(word)))
    .join(' ');
}
