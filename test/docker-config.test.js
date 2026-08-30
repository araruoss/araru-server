import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const compose = await readFile(new URL('../docker-compose.dev.yml', import.meta.url), 'utf8');
const debug = await readFile(new URL('../docker-compose.debug.yml', import.meta.url), 'utf8');

test('Compose dev não expõe banco/cache nem usa credenciais fixas', () => {
  assert.doesNotMatch(compose, /POSTGRES_PASSWORD:\s*araru/);
  assert.doesNotMatch(compose, /ports:\s*\["(?:5432|6379):/);
  assert.match(compose, /POSTGRES_PASSWORD:\s*\$\{POSTGRES_PASSWORD:\?/);
  assert.match(compose, /REDIS_PASSWORD:\s*\$\{REDIS_PASSWORD:\?/);
  assert.match(compose, /--requirepass/);
});

test('debug Compose exige binding explícito localhost', () => {
  assert.match(debug, /127\.0\.0\.1:5432:5432/);
  assert.match(debug, /127\.0\.0\.1:6379:6379/);
  assert.match(debug, /127\.0\.0\.1:3001:3001/);
});
