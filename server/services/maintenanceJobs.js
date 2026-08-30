import { env } from '../config/drive.js';
import { enfileirarAtualizacaoCatalogo } from './driveService.js';
import { removerItensAusentesExpirados } from './libraryIndexService.js';
import { removerResultadosExpirados } from './metadata/apiCache.js';
import { logger } from './logger.js';
import { cleanupCaches } from './cacheService.js';

const timers = [];

async function executarJob(nome, tarefa) {
  try {
    await tarefa();
  } catch (error) {
    logger.warn('maintenance.failed', { name: nome, error });
  }
}

function agendar(nome, minutos, tarefa) {
  if (!Number.isFinite(minutos) || minutos <= 0) return;
  const intervalo = setInterval(() => executarJob(nome, tarefa), minutos * 60 * 1000);
  intervalo.unref?.();
  timers.push(intervalo);
}

export function iniciarJobsManutencao() {
  if (!env.jobsEnabled || env.useMockData || timers.length > 0) return;

  agendar('reconciliacao do catalogo', env.catalogRefreshIntervalMinutes, async () => {
    await enfileirarAtualizacaoCatalogo({ priority: 'low', reason: 'periodic-maintenance' });
    logger.info('maintenance.catalog.reconciled');
  });
  agendar('limpeza de manutencao', env.maintenanceIntervalMinutes, async () => {
    const apiRemovidos = await removerResultadosExpirados();
    const arquivosRemovidos = await removerItensAusentesExpirados();
    const cache = await cleanupCaches({ dryRun: false });
    if (apiRemovidos || arquivosRemovidos) {
      logger.info('maintenance.cleanup.completed', { apiCacheRemoved: apiRemovidos, missingFilesRemoved: arquivosRemovidos, cacheEntriesRemoved: cache.entries, cacheBytesFreed: cache.bytes });
    }
  });
}

export function encerrarJobsManutencao() {
  for (const timer of timers.splice(0)) clearInterval(timer);
}

export function estadoJobsManutencao() {
  return { enabled: env.jobsEnabled, scheduled: timers.length };
}
