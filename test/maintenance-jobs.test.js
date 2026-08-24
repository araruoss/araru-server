import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('jobs de manutenção podem ser iniciados e encerrados sem bloquear a aplicação', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'araru-jobs-'));
  Object.assign(process.env, {
    LOCAL_LIBRARY_DIR: path.join(directory, 'library'),
    JOBS_ENABLED: 'true',
    CATALOG_REFRESH_INTERVAL_MINUTES: '0',
    MAINTENANCE_INTERVAL_MINUTES: '0',
    USE_MOCK_DATA: 'false'
  });

  const { iniciarJobsManutencao, encerrarJobsManutencao } = await import('../server/services/maintenanceJobs.js');
  assert.doesNotThrow(() => iniciarJobsManutencao());
  assert.doesNotThrow(() => encerrarJobsManutencao());
  await rm(directory, { recursive: true, force: true });
});
