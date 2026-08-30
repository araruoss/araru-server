import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import request from 'supertest';
import { createRateLimiter } from '../server/middleware/security.js';

test('rate limiter informa a cota e bloqueia somente depois do limite', async () => {
  const app = express();
  app.use(createRateLimiter({ max: 2, windowMs: 60000 }));
  app.get('/', (_req, res) => res.json({ ok: true }));

  const first = await request(app).get('/');
  const second = await request(app).get('/');
  const blocked = await request(app).get('/');

  assert.equal(first.status, 200);
  assert.equal(first.headers['ratelimit-limit'], '2');
  assert.equal(second.headers['ratelimit-remaining'], '0');
  assert.equal(blocked.status, 429);
  assert.match(blocked.headers['retry-after'], /^\d+$/);
  assert.equal(blocked.body.code, undefined);
});
