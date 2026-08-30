import assert from 'node:assert/strict';
import test from 'node:test';
import { requireAdmin } from '../server/middleware/security.js';

test('requireAdmin rejects anonymous requests even when NODE_ENV=test', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  let statusCode;
  let body;
  await requireAdmin({}, { status(value) { statusCode = value; return this; }, json(value) { body = value; } }, () => { throw new Error('anonymous request was authorized'); });
  process.env.NODE_ENV = previous;
  assert.equal(statusCode, 401);
  assert.equal(body.message, 'Autenticação necessária.');
});
