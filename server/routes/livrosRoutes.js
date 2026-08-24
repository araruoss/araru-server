import { Router, raw } from 'express';
import {
  buscarLivros,
  buscarLivroPorIsbn,
  enriquecerPendentes,
  enriquecerMetadadosLivro,
  listarCategorias,
  listarArvoreCategorias,
  listarMetadadosLivro,
  listarPaginasLeitura,
  listarLivros,
  listarRevisoesMetadados,
  servirConteudoLivro,
  servirCapaLivro,
  servirPaginaLeitura,
  servirRecursoMobi,
  listarPorCategoria,
  sincronizarCategorias,
  atualizarMetadadosLivro
} from '../controllers/livrosController.js';
import { getReadingState, putReadingState } from '../controllers/readingStateController.js';
import { baixarBackup, importarBackup, validarBackup } from '../controllers/backupController.js';
import { listarJobs, listarMetricas } from '../controllers/operationsController.js';
import { cancelarJob, limparCaches, listarCache, listarCapasProblematicas, listarCircuitos, listarIntegridade, regenerarCapasProblematicas, repetirJob, verificarIntegridade } from '../controllers/operationsController.js';
import { deleteProfile, getProfiles, postProfile, putProfile, putProfileUsers, selectProfile } from '../controllers/profileController.js';
import { getWork, getWorks } from '../controllers/workController.js';
import { getDuplicates, getFeatureFlags, getMetadataExport, getPrefs, getReaderMetrics, getSeriesDetail, getSeriesList, getViews, postDuplicateDecision, postMetadataImport, postReaderMetric, postView, putPrefs, removeView } from '../controllers/productController.js';
import { requireAdmin } from '../middleware/security.js';
import { adminOverview, listAdminAudit } from '../services/adminService.js';

const router = Router();

router.get('/reading-state', getReadingState);
router.put('/reading-state', putReadingState);
router.get('/admin/overview', requireAdmin, async (_req,res,next)=>{try{return res.json({data:await adminOverview()});}catch(error){next(error);}});
router.get('/admin/audit', requireAdmin, async (req,res,next)=>{try{return res.json({data:await listAdminAudit(req.query.limit)});}catch(error){next(error);}});
router.get('/backup', requireAdmin, baixarBackup);
router.post('/backup/restore', requireAdmin, raw({ type: ['application/gzip', 'application/octet-stream'], limit: '100mb' }), importarBackup);
router.post('/backup/verify', requireAdmin, raw({ type: ['application/gzip', 'application/octet-stream'], limit: '100mb' }), validarBackup);
router.use('/operations', requireAdmin);
router.get('/operations/jobs', listarJobs);
router.get('/operations/metrics', listarMetricas);
router.get('/operations/cache', listarCache);
router.post('/operations/cache/cleanup', limparCaches);
router.get('/operations/covers/problems', listarCapasProblematicas);
router.post('/operations/covers/regenerate', regenerarCapasProblematicas);
router.post('/operations/jobs/:id/cancel', cancelarJob);
router.post('/operations/jobs/:id/retry', repetirJob);
router.get('/operations/integrity', listarIntegridade);
router.post('/operations/integrity/scan', verificarIntegridade);
router.get('/operations/circuit-breakers', listarCircuitos);
router.get('/profiles', getProfiles);
router.post('/profiles', requireAdmin, postProfile);
router.put('/profiles/:id', requireAdmin, putProfile);
router.put('/profiles/:id/users', requireAdmin, putProfileUsers);
router.delete('/profiles/:id', requireAdmin, deleteProfile);
router.post('/profiles/:id/select', selectProfile);
router.get('/works', getWorks);
router.get('/works/:id', getWork);
router.get('/saved-views', getViews);
router.post('/saved-views', postView);
router.delete('/saved-views/:id', removeView);
router.get('/preferences', getPrefs);
router.put('/preferences', putPrefs);
router.get('/series', getSeriesList);
router.get('/series/:id', getSeriesDetail);
router.get('/features', getFeatureFlags);
router.post('/reader-metrics', postReaderMetric);
router.get('/operations/reader-metrics', getReaderMetrics);
router.get('/duplicates', requireAdmin, getDuplicates);
router.post('/duplicates/decision', requireAdmin, postDuplicateDecision);
router.get('/metadata/export', requireAdmin, getMetadataExport);
router.post('/metadata/import', requireAdmin, postMetadataImport);

router.get('/livros', listarLivros);
router.get('/livros/categoria/:categoria', listarPorCategoria);
router.get('/livros/busca', buscarLivros);
router.get('/categorias', listarCategorias);
router.get('/categorias/arvore', listarArvoreCategorias);
router.get('/livros/isbn/:isbn', buscarLivroPorIsbn);
router.get('/livros/:id/metadados', listarMetadadosLivro);
router.get('/livros/:id/paginas', listarPaginasLeitura);
router.get('/livros/:id/paginas/:page', servirPaginaLeitura);
router.get('/livros/:id/recursos/mobi/:recindex', servirRecursoMobi);
router.get('/livros/:id/conteudo', servirConteudoLivro);
router.head('/livros/:id/conteudo', servirConteudoLivro);
router.get('/livros/:id/capa', servirCapaLivro);
router.post('/livros/:id/atualizar', requireAdmin, atualizarMetadadosLivro);
router.post('/livros/:id/enriquecer', requireAdmin, enriquecerMetadadosLivro);
router.post('/livros/enriquecer-pendentes', requireAdmin, enriquecerPendentes);
router.get('/livros/revisar-metadados', requireAdmin, listarRevisoesMetadados);
router.post('/categorias/sincronizar', requireAdmin, sincronizarCategorias);

export default router;
