import { historicoTrabalhos } from '../services/backgroundJobs.js';
import { obterMetricasRuntime } from '../services/runtimeMetrics.js';
import { cacheStats, cleanupCaches, listProblemCovers, coverCacheStatus } from '../services/cacheService.js';
import { enfileirarCapaLivro } from '../services/driveService.js';
import { query } from '../database/postgres.js';
import { randomUUID } from 'node:crypto';
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
export const statusCacheCapas=async(_req,res,next)=>{try{return res.json({data:await coverCacheStatus()});}catch(e){return next(e);}};
async function enqueueCoverSelection(items, mode){const batchId=randomUUID();for(const item of items)void enfileirarCapaLivro(item.id,'normal').catch(()=>{});return{batchId,mode,queued:items.length};}
export const gerarCapasAusentes=async(_req,res,next)=>{try{const {rows}=await query("SELECT id FROM library_files WHERE status='active' AND cover_quality_status IN ('unknown','missing')");return res.status(202).json({data:await enqueueCoverSelection(rows,'missing')});}catch(e){return next(e);}};
export const reconstruirCacheCapas=async(req,res,next)=>{try{const mode=String(req.body?.mode||'missing');if(!['missing','failed','stale','force'].includes(mode))return res.status(400).json({message:'Invalid cover rebuild mode.'});if(mode==='force'&&req.body?.confirmed!==true)return res.status(400).json({message:'Rebuilding all covers requires explicit confirmation.'});const condition=mode==='force'?"status='active'":mode==='failed'?"status='active' AND cover_quality_status NOT IN ('ok','unknown','missing','processing')":mode==='stale'?"status='active' AND cover_quality_status='outdated'":"status='active' AND cover_quality_status IN ('unknown','missing')";const {rows}=await query(`SELECT id FROM library_files WHERE ${condition}`);return res.status(202).json({data:await enqueueCoverSelection(rows,mode)});}catch(e){return next(e);}};
export const repetirCapasComErro=async(_req,res,next)=>{try{const {rows}=await query("SELECT id FROM library_files WHERE status='active' AND cover_quality_status NOT IN ('ok','unknown','missing','processing')");return res.status(202).json({data:await enqueueCoverSelection(rows,'failed')});}catch(e){return next(e);}};
export const cancelarJob=async(req,res,next)=>{try{res.json({data:await cancelarTrabalho(req.params.id)});}catch(e){next(e);}};
export const repetirJob=async(req,res,next)=>{try{res.json({data:await repetirTrabalho(req.params.id)});}catch(e){next(e);}};
export const verificarIntegridade=async (req,res,next)=>{try{res.json({data:await scanIntegrity({apply:req.query.apply==='true'})});}catch(e){next(e);}};
export const listarIntegridade=async (req,res,next)=>{try{res.json({data:await listIntegrityReports(req.query.limit)});}catch(e){next(e);}};
export const listarCircuitos=(_req,res)=>res.json({data:breakerStatuses()});
