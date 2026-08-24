import test from 'node:test';
import assert from 'node:assert/strict';
import { extractISBN, isbn10To13, isValidIsbn13 } from '../server/services/metadata/isbn.js';
import { parseFilename } from '../server/services/metadata/filenameParser.js';
import { textSimilarity } from '../server/services/metadata/matcher.js';
import { normalizeForMatch } from '../server/services/metadata/normalizer.js';
import { scoreCandidate } from '../server/services/metadata/scorer.js';
import { preserveManualValue } from '../server/services/metadata/fields.js';

test('valida e extrai ISBNs com separadores', () => {
  assert.equal(extractISBN('ISBN: 978-85-5080-387-6'), '9788550803876');
  assert.equal(extractISBN('ISBN 978 85 5080 387 6'), '9788550803876');
  assert.equal(isValidIsbn13('9788550803876'), true);
  assert.equal(extractISBN('0007855 Sem ISBN'), '');
  assert.equal(isbn10To13('0306406152'), '9780306406157');
});

test('limpa filename sem perder nome original', () => {
  const parsed = parseFilename('410809895-Data-Science-do-zero-Primeiras-regras-pdf-Joel-Grus-9788550803876.pdf');
  assert.equal(parsed.originalFilename, '410809895-Data-Science-do-zero-Primeiras-regras-pdf-Joel-Grus-9788550803876.pdf');
  assert.equal(parsed.isbn13, '9788550803876');
  assert.match(parsed.nome, /Data Science do zero Primeiras regras/i);
  assert.doesNotMatch(parsed.nome, /Joel Grus/i);
  assert.deepEqual(parsed.autor, ['Joel Grus']);
});

test('descarta placeholders e IDs que não são ISBN', () => {
  const parsed = parseFilename('Advanced Guide To Python3 Programm - 0007855 - Sem ISBN.pdf');
  assert.equal(parsed.isbn13, '');
  assert.doesNotMatch(parsed.nome, /0007855|sem isbn/i);
  const placeholder = parseFilename('Agile Desenvolvimento - Autor desconhecido - Sem ISBN.pdf');
  assert.doesNotMatch(placeholder.nome, /autor desconhecido|sem isbn/i);
});

test('normaliza acentos, caixa, pontuação e hífen', () => {
  assert.equal(normalizeForMatch('Ágil: Desenvolvimento — de Software!'), 'agil desenvolvimento de software');
});

test('matching reconhece subtítulo como compatível', () => {
  assert.ok(textSimilarity('Data Science do Zero', 'Data Science do Zero: Primeiras Regras com Python') >= 0.6);
});

test('ISBN confirmado supera coincidência apenas por título', () => {
  const local = { nome: 'Data Science do Zero', autor: ['Joel Grus'], isbn13: '9788550803876', evidence: { internalIsbn: true } };
  const exact = scoreCandidate(local, { nome: 'Data Science do Zero', autor: ['Joel Grus'], isbn13: '9788550803876' });
  const titleOnly = scoreCandidate({ ...local, isbn13: '', isbn: '' }, { nome: 'Data Science do Zero', autor: ['Joel Grus'] });
  assert.ok(exact.score > titleOnly.score);
  assert.ok(exact.score >= 0.85);
});

test('campo manual não é sobrescrito', () => {
  assert.equal(preserveManualValue('nome', 'Título manual', 'Título externo', ['nome']), 'Título manual');
  assert.equal(preserveManualValue('nome', 'Título manual', 'Título externo', []), 'Título externo');
});
