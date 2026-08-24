import { normalizeForMatch } from './normalizer.js';

function tokens(value = '') {
  return new Set(normalizeForMatch(value).split(' ').filter((word) => word.length > 1));
}

export function textSimilarity(left = '', right = '') {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  const common = [...a].filter((word) => b.has(word)).length;
  const jaccard = common / new Set([...a, ...b]).size;
  const coverage = common / Math.min(a.size, b.size);
  return Number((jaccard * 0.45 + coverage * 0.55).toFixed(3));
}

export function authorSimilarity(left = [], right = []) {
  const leftText = Array.isArray(left) ? left.join(' ') : left;
  const rightText = Array.isArray(right) ? right.join(' ') : right;
  return textSimilarity(leftText, rightText);
}

