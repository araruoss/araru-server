function compact(value = '') {
  return String(value).toUpperCase().replace(/[^0-9X]/g, '');
}

export function isValidIsbn10(value = '') {
  const isbn = compact(value);
  if (!/^[0-9]{9}[0-9X]$/.test(isbn)) return false;
  return [...isbn].reduce((sum, char, index) => sum + (char === 'X' ? 10 : Number(char)) * (10 - index), 0) % 11 === 0;
}

export function isValidIsbn13(value = '') {
  const isbn = compact(value);
  if (!/^97[89][0-9]{10}$/.test(isbn)) return false;
  const sum = [...isbn].slice(0, 12).reduce((total, char, index) => total + Number(char) * (index % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(isbn[12]);
}

export function normalizeIsbn(value = '') {
  const isbn = compact(value);
  if (isValidIsbn10(isbn) || isValidIsbn13(isbn)) return isbn;
  return '';
}

export function isbn10To13(value = '') {
  const isbn10 = normalizeIsbn(value);
  if (!isValidIsbn10(isbn10)) return '';
  const base = `978${isbn10.slice(0, 9)}`;
  const sum = [...base].reduce((total, char, index) => total + Number(char) * (index % 2 ? 3 : 1), 0);
  return `${base}${(10 - (sum % 10)) % 10}`;
}

export function isbn13To10(value = '') {
  const isbn13 = normalizeIsbn(value);
  if (!isValidIsbn13(isbn13) || !isbn13.startsWith('978')) return '';
  const base = isbn13.slice(3, 12);
  const sum = [...base].reduce((total, char, index) => total + Number(char) * (10 - index), 0);
  const digit = (11 - (sum % 11)) % 11;
  return `${base}${digit === 10 ? 'X' : digit}`;
}

export function isbnForms(value = '') {
  const normalized = normalizeIsbn(value);
  if (!normalized) return { isbn10: '', isbn13: '' };
  return isValidIsbn10(normalized)
    ? { isbn10: normalized, isbn13: isbn10To13(normalized) }
    : { isbn10: isbn13To10(normalized), isbn13: normalized };
}

export function extractIsbns(text = '') {
  const matches = String(text).matchAll(/(?:ISBN(?:-1[03])?\s*[:#-]?\s*)?((?:97[89][\s-]?)?\d[\d\s-]{8,}[\dXx])/gi);
  const found = [];
  for (const match of matches) {
    const isbn = normalizeIsbn(match[1]);
    if (isbn && !found.includes(isbn)) found.push(isbn);
  }
  return found;
}

export function extractISBN(text = '') {
  return extractIsbns(text)[0] || '';
}

