import { DomainError } from './apiErrors.js';

export function numberParam(value, { name, defaultValue, min = 1, max = 100 } = {}) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new DomainError(`${name} must be an integer between ${min} and ${max}.`, { code: 'VALIDATION_ERROR', statusCode: 400 });
  }
  return parsed;
}

export function enumParam(value, allowed, { name, defaultValue } = {}) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (!allowed.includes(String(value))) throw new DomainError(`${name} is invalid.`, { code: 'VALIDATION_ERROR', statusCode: 400 });
  return String(value);
}

export function pagination(query = {}) {
  return {
    page: numberParam(query.page, { name: 'page', defaultValue: 1, min: 1, max: 100000 }),
    pageSize: numberParam(query.pageSize, { name: 'pageSize', defaultValue: 30, min: 1, max: 100 })
  };
}

export function paged(items, page, pageSize, total = items.length) {
  return { items, pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) } };
}
