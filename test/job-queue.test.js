import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { JobQueue } from '../server/services/jobQueueService.js';
import { migratePostgres } from '../server/database/postgresMigrations.js';
import { query } from '../server/database/postgres.js';

test('prioriza jobs, deduplica e tenta novamente após falha', async () => {
  await migratePostgres();
  const type = `queue-test-${randomUUID()}`;
  const queue = new JobQueue({ concurrency: 1, defaultTimeoutMs: 500 });
  const executed = [];
  let tentativas = 0;
  queue.register(type, async (payload) => {
    executed.push(payload.name);
    if (payload.name === 'retry' && ++tentativas === 1) throw new Error('temporário');
    return payload.name;
  });

  const first = queue.enqueue(type, { name: 'normal' });
  const high = queue.enqueue(type, { name: 'high' }, { priority: 'high' });
  const retryKey = `${type}:retry`;
  const retry = queue.enqueue(type, { name: 'retry' }, { maxAttempts: 2, dedupeKey: retryKey });
  const duplicate = queue.enqueue(type, { name: 'retry' }, { dedupeKey: retryKey });

  assert.equal(retry, duplicate);
  assert.deepEqual(await Promise.all([first, high, retry]), ['normal', 'high', 'retry']);
  assert.equal(executed.filter((name) => name === 'normal').length, 1);
  assert.equal(executed.filter((name) => name === 'high').length, 1);
  assert.equal(executed.filter((name) => name === 'retry').length, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(queue.status(type), { pending: 0, processing: 0, concurrency: 1 });
  const history = await queue.history({ type });
  assert.ok(history.some((job) => job.priority === 3 && job.status === 'completed'));
  await query('DELETE FROM background_jobs WHERE type=$1', [type]);
});

test('persiste histórico e recupera trabalho interrompido após reinício', async () => {
  await migratePostgres();
  const type = `recover-test-${randomUUID()}`;
  const id = randomUUID();
  await query("INSERT INTO background_jobs(id,type,dedupe_key,priority,payload,status,attempts,max_attempts,timeout_ms,created_at,started_at,updated_at) VALUES($1,$2,$3,3,$4::jsonb,'running',1,3,1000,NOW(),NOW(),NOW())", [id, type, `${type}:1`, JSON.stringify({ value: 42 })]);

  const queue = new JobQueue({ concurrency: 1 });
  let received;
  queue.register(type, async (payload) => { received = payload.value; return payload.value; });

  const deadline = Date.now() + 1000;
  let row;
  while (Date.now() < deadline) {
    row = (await query('SELECT status,attempts FROM background_jobs WHERE id=$1', [id])).rows[0];
    if (row?.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(received, 42);
  assert.equal(row.status, 'completed');
  assert.equal(row.attempts, 2);
  assert.equal((await queue.history({ type }))[0].status, 'completed');
  await query('DELETE FROM background_jobs WHERE type=$1', [type]);
});

test('dois workers fazem claim concorrente sem executar o mesmo job duas vezes', async () => {
  await migratePostgres();
  const type = `claim-test-${randomUUID()}`;
  const first = new JobQueue({ concurrency: 3 });
  const second = new JobQueue({ concurrency: 3 });
  const executed = [];
  const handler = async (payload) => { executed.push(payload.id); await new Promise((resolve) => setTimeout(resolve, 20)); return payload.id; };
  const previousProcessJobs = process.env.ARARU_PROCESS_JOBS;
  process.env.ARARU_PROCESS_JOBS = 'false';
  first.register(type, handler); second.register(type, handler);
  const jobs = Array.from({ length: 8 }, (_, index) => first.enqueue(type, { id: index }, { dedupeKey: `${type}:${index}` }));
  while ((await query('SELECT COUNT(*)::int AS count FROM background_jobs WHERE type=$1', [type])).rows[0].count < 8) await new Promise((resolve) => setTimeout(resolve, 5));
  process.env.ARARU_PROCESS_JOBS = 'true';
  first.process(); second.process();
  await Promise.allSettled(jobs);
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && executed.length < 8) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(executed.length, 8);
  assert.equal(new Set(executed).size, 8);
  const rows = await query('SELECT status,COUNT(*)::int AS count FROM background_jobs WHERE type=$1 GROUP BY status', [type]);
  assert.equal(rows.rows.find((row) => row.status === 'completed')?.count, 8);
  await query('DELETE FROM background_jobs WHERE type=$1', [type]);
  if (previousProcessJobs === undefined) delete process.env.ARARU_PROCESS_JOBS; else process.env.ARARU_PROCESS_JOBS = previousProcessJobs;
});
