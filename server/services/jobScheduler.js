import { query } from '../database/postgres.js';
import { runJob, cronMatchesForTest, ensureJobDefinitions } from './jobCenterService.js';
let timer;
function nextRun(cron, from = new Date()) { const candidate = new Date(from); candidate.setUTCSeconds(0, 0); for (let i = 0; i < 1_051_200; i += 1) { candidate.setUTCMinutes(candidate.getUTCMinutes() + 1); if (cronMatchesForTest(cron, candidate)) return candidate; } return null; }
async function tick() { const { rows } = await query("SELECT id,job_type AS \"jobType\",cron,payload FROM job_schedules WHERE enabled=TRUE AND (next_run_at IS NULL OR next_run_at<=NOW())"); for (const schedule of rows) { try { await runJob(schedule.jobType, schedule.payload || {}, { priority: 'normal', dedupeKey: `schedule:${schedule.id}:${new Date().toISOString().slice(0, 16)}` }); const next = nextRun(schedule.cron); await query("UPDATE job_schedules SET last_run_at=NOW(),next_run_at=$1,last_error=NULL,updated_at=NOW() WHERE id=$2", [next, schedule.id]); } catch (error) { await query('UPDATE job_schedules SET last_error=$1,updated_at=NOW() WHERE id=$2', [String(error.message).slice(0, 2000), schedule.id]); } } }
export function startJobScheduler() { if (timer) return; void ensureJobDefinitions().catch(() => {}); timer = setInterval(() => void tick().catch(() => {}), 60_000); timer.unref?.(); void tick().catch(() => {}); }
export function stopJobScheduler() { if (timer) clearInterval(timer); timer = undefined; }
export { cronMatchesForTest as cronMatches } from './jobCenterService.js';
