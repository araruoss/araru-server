import { historicoTrabalhos } from '../services/backgroundJobs.js';
import { obterMetricasRuntime } from '../services/runtimeMetrics.js';
import { cacheStats, cleanupCaches, listProblemCovers } from '../services/cacheService.js';
import { enfileirarCapaLivro } from '../services/driveService.js';
import { cancelarTrabalho, repetirTrabalho } from '../services/backgroundJobs.js';
import { breakerStatuses } from '../services/circuitBreaker.js';
import { listIntegrityReports, scanIntegrity } from '../services/integrityService.js';

export async function listarJobs(req, res, next) {
  try { const data = await historicoTrabalhos({ type: req.query.type || null, limit: req.query.limit || 50 }); return res.json({ data, total: data.length }); } catch (error) { return next(error); }
}

export function listarMetricas(req, res) {
  return res.json({ data: obterMetricasRuntime() });
}
export const listarCache = async (_req,res,next)=>{try{res.json({data:await cacheStats()});}catch(e){next(e);}};
export const limparCaches = async(req,res,next)=>{try{res.json({data:await cleanupCaches({dryRun:req.query.apply!=='true'})});}catch(e){next(e);}};
export const listarCapasProblematicas=async (_req,res,next)=>{try{res.json({data:await listProblemCovers()});}catch(e){next(e);}};
export const regenerarCapasProblematicas=async(req,res,next)=>{try{const items=await listProblemCovers();if(req.query.apply!=='true')return res.json({data:{dryRun:true,total:items.length,items}});for(const item of items)void enfileirarCapaLivro(item.id,'normal').catch(()=>{});return res.status(202).json({data:{dryRun:false,queued:items.length}});}catch(e){next(e);}};
export const cancelarJob=async(req,res,next)=>{try{res.json({data:await cancelarTrabalho(req.params.id)});}catch(e){next(e);}};
export const repetirJob=async(req,res,next)=>{try{res.json({data:await repetirTrabalho(req.params.id)});}catch(e){next(e);}};
export const verificarIntegridade=async (req,res,next)=>{try{res.json({data:await scanIntegrity({apply:req.query.apply==='true'})});}catch(e){next(e);}};
export const listarIntegridade=async (req,res,next)=>{try{res.json({data:await listIntegrityReports(req.query.limit)});}catch(e){next(e);}};
export const listarCircuitos=(_req,res)=>res.json({data:breakerStatuses()});
