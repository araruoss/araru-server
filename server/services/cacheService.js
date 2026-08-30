import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/drive.js';
import { query } from '../database/postgres.js';

export function imageDimensions(data){
  if (!data || data.length < 10) return { width: 0, height: 0 };
  if (data.length >= 24 && data.subarray(1, 4).toString() === 'PNG') return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (data.subarray(0, 3).toString() === 'GIF') return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') {
    if (data.subarray(12, 16).toString() === 'VP8X' && data.length >= 30) {
      return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
    }
    return { width: 0, height: 0 };
  }
  if (data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) { offset += 1; continue; }
      while (data[offset] === 0xff) offset += 1;
      const marker = data[offset]; offset += 1;
      if (marker === 0xd8 || marker === 0xd9) continue;
      if (offset + 2 > data.length) break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { width: data.readUInt16BE(offset + 5), height: data.readUInt16BE(offset + 3) };
      }
      offset += length;
    }
  }
  return { width: 0, height: 0 };
}
export function coverQuality({width,height,source,pipelineVersion=env.coverPipelineVersion}){const ratio=height?width/height:0;if(!width||!height)return'broken';if(ratio<.35||ratio>1.5)return'extreme-ratio';if(width<240||height<320)return'too-small';if(!source)return'invalid-source';if(pipelineVersion<env.coverPipelineVersion)return'outdated';return'ok';}
export async function registerCover(fileId,filePath,data,source){const {width,height}=imageDimensions(data);const ratio=height?width/height:null;const status=coverQuality({width,height,source});await query('UPDATE library_files SET cover_source=$1,cover_width=$2,cover_height=$3,cover_aspect_ratio=$4,cover_pipeline_version=$5,cover_quality_status=$6 WHERE id=$7',[source,width,height,ratio,env.coverPipelineVersion,status,fileId]);await query('INSERT INTO cache_entries(cache_key,cache_type,path,size,fingerprint,version) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(cache_key) DO UPDATE SET path=EXCLUDED.path,size=EXCLUDED.size,version=EXCLUDED.version,last_accessed_at=NOW()',['cover:'+fileId,'covers',filePath,data.length,'',env.coverPipelineVersion]);return{width,height,ratio,status};}
export async function listProblemCovers(){const {rows}=await query("SELECT id,filename,cover_quality_status AS status,cover_width AS width,cover_height AS height,cover_source AS source FROM library_files WHERE status='active' AND cover_quality_status!='ok'");return rows;}
export async function coverCacheStatus(){const {rows}=await query("SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE cover_quality_status='ok')::int AS ready,COUNT(*) FILTER (WHERE cover_quality_status IN ('unknown','missing'))::int AS missing,COUNT(*) FILTER (WHERE cover_quality_status='processing')::int AS processing,COUNT(*) FILTER (WHERE cover_quality_status NOT IN ('ok','unknown','missing','processing'))::int AS failed FROM library_files WHERE status='active'");return rows[0]||{total:0,ready:0,missing:0,processing:0,failed:0};}
export async function cacheStats(){const {rows}=await query('SELECT cache_type AS type,COUNT(*)::int AS entries,COALESCE(SUM(size),0)::bigint AS bytes FROM cache_entries GROUP BY cache_type');return{maxBytes:env.cacheMaxBytes,totalBytes:rows.reduce((sum,row)=>sum+Number(row.bytes||0),0),types:rows.map(row=>({...row,bytes:Number(row.bytes||0)}))};}
export async function cleanupCaches({dryRun=true,maxBytes=env.cacheMaxBytes}={}){const {rows}=await query('SELECT * FROM cache_entries ORDER BY last_accessed_at ASC');let total=rows.reduce((sum,row)=>sum+Number(row.size||0),0),freed=0;const remove=[];for(const row of rows){let orphan=false;if(row.path){try{await fs.access(row.path);}catch{orphan=true;}}if(orphan||total>maxBytes){remove.push(row);total-=Number(row.size||0);freed+=Number(row.size||0);}}if(!dryRun)for(const row of remove){if(row.path&&path.resolve(row.path).startsWith(path.resolve(path.dirname(env.coverCacheDir))))await fs.unlink(row.path).catch(()=>{});await query('DELETE FROM cache_entries WHERE cache_key=$1',[row.cache_key]);}return{dryRun,entries:remove.length,bytes:freed,remainingBytes:total};}
export async function ensureCacheCapacity(requiredBytes=0){await fs.mkdir(env.coverCacheDir,{recursive:true});const current=await cacheStats();if(current.totalBytes+requiredBytes>current.maxBytes)await cleanupCaches({dryRun:false,maxBytes:Math.max(0,current.maxBytes-requiredBytes)});const disk=await fs.statfs(env.coverCacheDir);const freeBytes=Number(disk.bavail)*Number(disk.bsize);const reserve=Math.max(32*1024*1024,Number(requiredBytes||0));if(freeBytes<reserve)throw Object.assign(new Error('Espaço em disco insuficiente para gerar o arquivo derivado.'),{statusCode:507});return{freeBytes,maxBytes:current.maxBytes};}
