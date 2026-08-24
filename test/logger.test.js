import assert from 'node:assert/strict';
import test from 'node:test';
import { logger } from '../server/services/logger.js';

test('logger produz JSON estruturado e remove segredos', () => {
  const original = console.log;
  let output = '';
  console.log = (value) => { output = value; };
  try {
    logger.info('test.event', { accessToken: 'não-pode-vazar', nested: { password: 'secreto' }, safe: 42 });
  } finally {
    console.log = original;
  }
  const parsed = JSON.parse(output);
  assert.equal(parsed.event, 'test.event');
  assert.equal(parsed.accessToken, '[redacted]');
  assert.equal(parsed.nested.password, '[redacted]');
  assert.equal(parsed.safe, 42);
});
