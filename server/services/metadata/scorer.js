import { authorSimilarity, textSimilarity } from './matcher.js';
import { isbnForms } from './isbn.js';

export function classifyConfidence(score = 0) {
  if (score >= 0.9) return 'confirmed';
  if (score >= 0.75) return 'high';
  if (score >= 0.55) return 'medium';
  return 'low';
}

export function scoreCandidate(local = {}, candidate = {}) {
  const localIsbn = isbnForms(local.isbn13 || local.isbn10 || local.isbn);
  const candidateIsbn = isbnForms(candidate.isbn13 || candidate.isbn10 || candidate.isbn);
  const title = textSimilarity(local.nome, candidate.nome);
  const author = authorSimilarity(local.autor, candidate.autor);
  const sameIsbn = Boolean(localIsbn.isbn13 && candidateIsbn.isbn13 && localIsbn.isbn13 === candidateIsbn.isbn13);
  const year = local.ano && candidate.ano && Math.abs(Number(local.ano) - Number(candidate.ano)) <= 1 ? 1 : 0;
  const publisher = local.editora && candidate.editora && textSimilarity(local.editora, candidate.editora) >= 0.7 ? 1 : 0;
  let score = sameIsbn ? 0.6 : 0;
  score += title * 0.24;
  score += author * 0.11;
  score += year * 0.025;
  score += publisher * 0.015;
  if (!localIsbn.isbn13 && title >= 0.86) score += 0.3;
  if (!localIsbn.isbn13 && title >= 0.7 && author >= 0.7) score += 0.12;
  if (!sameIsbn && candidateIsbn.isbn13 && local.evidence?.internalIsbn) score += 0.12;
  score = Math.min(1, Number(score.toFixed(3)));
  return { score, status: classifyConfidence(score), signals: { sameIsbn, title, author, year: Boolean(year), publisher: Boolean(publisher) } };
}
