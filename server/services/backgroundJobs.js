import { env } from '../config/drive.js';
import { JobQueue } from './jobQueueService.js';

export const backgroundJobs = new JobQueue({
  concurrency: Math.max(1, env.metadataEnrichConcurrency, env.coverRenderConcurrency),
  defaultTimeoutMs: Math.max(120000, env.coverRenderTimeout)
});

export function estadoFilaTrabalhos(type) {
  return backgroundJobs.status(type);
}

export function historicoTrabalhos(options) {
  return backgroundJobs.history(options);
}
export const cancelarTrabalho=(id)=>backgroundJobs.cancel(id);
export const repetirTrabalho=(id)=>backgroundJobs.retry(id);
