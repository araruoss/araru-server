import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { env } from '../config/drive.js';
import { query, withTransaction } from '../database/postgres.js';
import { sincronizarObras } from './workService.js';

const parse = (value, fallback = {}) => value && typeof value === 'object' ? value : (() => { try { return JSON.parse(value || '{}'); } catch { return fallback; } })();
const root = path.resolve(env.localLibraryDir);
function derivedFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? derivedFiles(target) : [path.resolve(target)];
  });
}
export async function scanIntegrity({ apply = false } = {}) {
  const findings = []; const { rows: active } = await query("SELECT id,source,relative_path,fingerprint,payload FROM library_files WHERE status='active'"); const activeIds = new Set(active.map((row) => row.id));
  for (const file of active) if (file.source === 'local') {
    const full = path.resolve(root, file.relative_path || '');
    if (!full.startsWith(`${root}${path.sep}`) || !fs.existsSync(full)) {
      findings.push({ type:'missing-file',severity:'high',id:file.id,path:file.relative_path,repair:'mark-missing' });
      continue;
    }
    const stats = fs.statSync(full);
    const actualFingerprint = `${stats.size}:${Math.floor(stats.mtimeMs)}`;
    if (file.fingerprint && file.fingerprint !== actualFingerprint) findings.push({
      type:'changed-fingerprint', severity:'medium', id:file.id, path:file.relative_path,
      expected:file.fingerprint, actual:actualFingerprint, repair:'reindex-file'
    });
  }
  const { rows: trackedCovers } = await query("SELECT path FROM cache_entries WHERE cache_type='covers' AND path IS NOT NULL UNION SELECT cover_path AS path FROM livros WHERE cover_path IS NOT NULL AND cover_path <> ''");
  const trackedCoverPaths = new Set(trackedCovers.map((row) => path.resolve(row.path)));
  derivedFiles(env.coverCacheDir).filter((file) => !trackedCoverPaths.has(file)).forEach((file) => findings.push({
    type:'untracked-cover-file', severity:'low', path:file, repair:'delete-untracked-cover'
  }));
  const { rows: emptyWorks } = await query('SELECT id FROM works WHERE id NOT IN (SELECT DISTINCT work_id FROM work_files)'); emptyWorks.forEach((row) => findings.push({ type:'work-without-file',severity:'medium',id:row.id,repair:'remove-empty-work' }));
  const { rows: orphanFiles } = await query("SELECT id FROM library_files WHERE status='active' AND id NOT IN (SELECT file_id FROM work_files)"); orphanFiles.forEach((row) => findings.push({ type:'file-without-work',severity:'medium',id:row.id,repair:'rebuild-works' }));
  const { rows: broken } = await query('SELECT wf.file_id AS id,wf.work_id AS "workId" FROM work_files wf LEFT JOIN works w ON w.id=wf.work_id LEFT JOIN library_files f ON f.id=wf.file_id WHERE w.id IS NULL OR f.id IS NULL'); broken.forEach((row) => findings.push({ type:'broken-work-reference',severity:'high',id:row.id,workId:row.workId,repair:'remove-broken-reference' }));
  const { rows: states } = await query('SELECT profile_id,progress FROM reading_state'); states.forEach((state) => Object.keys(parse(state.progress)).filter((id) => !activeIds.has(id)).forEach((id) => findings.push({ type:'orphan-progress',severity:'low',id,profileId:state.profile_id,repair:'remove-progress' })));
  const reportId = randomUUID(); let rebuild = false;
  if (apply) await withTransaction(async (client) => { for (const finding of findings) { if(finding.repair==='mark-missing') await client.query("UPDATE library_files SET status='missing' WHERE id=$1",[finding.id]); if(finding.repair==='reindex-file') rebuild=true; if(finding.repair==='delete-untracked-cover') fs.rmSync(finding.path,{force:true}); if(finding.repair==='remove-empty-work') await client.query('DELETE FROM works WHERE id=$1',[finding.id]); if(finding.repair==='remove-broken-reference') await client.query('DELETE FROM work_files WHERE file_id=$1 AND work_id=$2',[finding.id,finding.workId]); if(finding.repair==='rebuild-works') rebuild=true; if(finding.repair==='remove-progress'){const {rows}=await client.query('SELECT progress FROM reading_state WHERE profile_id=$1',[finding.profileId]);const progress=parse(rows[0]?.progress);delete progress[finding.id];await client.query('UPDATE reading_state SET progress=$1::jsonb,updated_at=NOW() WHERE profile_id=$2',[JSON.stringify(progress),finding.profileId]);} } });
  if (rebuild) await sincronizarObras(); const summary={total:findings.length,high:findings.filter((x)=>x.severity==='high').length,medium:findings.filter((x)=>x.severity==='medium').length,low:findings.filter((x)=>x.severity==='low').length,applied:apply}; await query('INSERT INTO integrity_reports(id,status,dry_run,summary,findings,completed_at) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,NOW())',[reportId,'completed',!apply,JSON.stringify(summary),JSON.stringify(findings)]); return {id:reportId,summary,findings};
}
export async function listIntegrityReports(limit=20) { const {rows}=await query('SELECT id,status,dry_run AS "dryRun",summary,created_at AS "createdAt",completed_at AS "completedAt" FROM integrity_reports ORDER BY created_at DESC LIMIT $1',[Math.min(100,Number(limit)||20)]); return rows; }
