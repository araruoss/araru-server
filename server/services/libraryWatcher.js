import chokidar from 'chokidar';
import { env } from '../config/drive.js';
import { enfileirarAtualizacaoCatalogo } from './driveService.js';
import { logger } from './logger.js';

let watcher;
let timer;
let mudancasPendentes = new Set();

function agendarReconciliacao() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const mudancas = [...mudancasPendentes];
    mudancasPendentes = new Set();
    try {
      await enfileirarAtualizacaoCatalogo({ priority: 'normal', reason: 'filesystem-watch' });
      logger.info('catalog.watch.reconciled', { changes: mudancas.length });
    } catch (error) {
      logger.warn('catalog.watch.reconcile_failed', { error, changes: mudancas.length });
    }
  }, Math.max(100, env.libraryWatchDebounceMs));
}

export function iniciarObservadorBiblioteca() {
  if (!env.libraryWatchEnabled || env.useMockData || watcher) return watcher;

  watcher = chokidar.watch(env.localLibraryDir, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100
    },
    ignored: /(^|[/\\])\../
  });

  watcher.on('all', (evento, arquivo) => {
    if (!['add', 'change', 'unlink', 'addDir', 'unlinkDir'].includes(evento)) return;
    mudancasPendentes.add(arquivo);
    agendarReconciliacao();
  });
  watcher.on('error', (error) => {
    logger.warn('catalog.watch.failed', { error });
  });

  logger.info('catalog.watch.started', { directory: env.localLibraryDir, debounceMs: env.libraryWatchDebounceMs });
  return watcher;
}

export async function encerrarObservadorBiblioteca() {
  clearTimeout(timer);
  timer = undefined;
  mudancasPendentes.clear();
  if (!watcher) return;
  const atual = watcher;
  watcher = undefined;
  await atual.close();
}

export function estadoObservadorBiblioteca() {
  return { enabled: env.libraryWatchEnabled, running: Boolean(watcher), pendingChanges: mudancasPendentes.size };
}
