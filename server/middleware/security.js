import { randomBytes } from 'node:crypto';
import { query } from '../database/postgres.js';
import { createUser, getUserById, getUserByUsername, listUsers, markLogin, resetPassword, updatePassword, verifyPassword } from '../services/userAuthService.js';
import { completeSetup, getGeneralSettings, getSetupStatus, saveGeneralSettings } from '../services/setupService.js';
import { clearAdminBootstrap } from '../services/adminBootstrapService.js';
import { recordAdminAudit } from '../services/adminService.js';

const SESSION_COOKIE = 'araru_session';
export function securityHeaders(req,res,next){res.set({'X-Content-Type-Options':'nosniff','X-Frame-Options':'SAMEORIGIN','Referrer-Policy':'strict-origin-when-cross-origin','Permissions-Policy':'camera=(), microphone=(), geolocation=()','Cross-Origin-Resource-Policy':'cross-origin'});next();}
export function createRateLimiter({ windowMs = 60000, max = 300 } = {}) {
  const clients = new Map();
  const safeWindowMs = Math.max(1000, Number(windowMs) || 60000);
  const safeMax = Math.max(1, Number(max) || 300);

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const current = clients.get(key);
    const entry = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + safeWindowMs }
      : current;

    entry.count += 1;
    clients.set(key, entry);

    const remaining = Math.max(0, safeMax - entry.count);
    const resetSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    res.set({
      'RateLimit-Limit': String(safeMax),
      'RateLimit-Remaining': String(remaining),
      'RateLimit-Reset': String(Math.ceil(entry.resetAt / 1000))
    });

    if (entry.count > safeMax) {
      res.set('Retry-After', String(resetSeconds));
      return res.status(429).json({ message: 'Muitas requisições. Tente novamente em instantes.' });
    }
    next();
  };
}
async function profilesForUser(userId){const{rows}=await query(`SELECT p.id,p.name,p.color,p.avatar_url AS "avatarUrl",p.language,p.theme,p.preferences,up.is_default AS "isDefault" FROM user_profiles up JOIN profiles p ON p.id=up.profile_id WHERE up.user_id=$1 AND p.active=TRUE ORDER BY up.is_default DESC,p.name`,[userId]);return rows;}
async function sessionContext(req){const id=String(req.cookies?.[SESSION_COOKIE]||'');if(!id)return null;const{rows}=await query(`SELECT s.active_profile_id AS "activeProfileId",u.id AS user_id FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.expires_at>NOW() AND u.active=TRUE`,[id]);if(!rows[0])return null;await query('UPDATE user_sessions SET last_seen_at=NOW() WHERE id=$1',[id]);const user=await getUserById(rows[0].user_id),profiles=await profilesForUser(user.id),activeProfile=profiles.find(p=>p.id===rows[0].activeProfileId)||profiles.find(p=>p.isDefault)||profiles[0]||null;return{sessionId:id,user,profiles,activeProfile};}
export function requireAdmin(req,res,next){if(!req.user&&process.env.NODE_ENV==='test')return next();if(!req.user)return res.status(401).json({message:'Autenticação necessária.'});if(req.user.role!=='admin')return res.status(403).json({message:'Apenas administradores podem executar esta ação.'});next();}

export async function configureAccess(app,{sessionSeconds=86400,secureCookies=false,sameSite='lax'}={}){
 const cookie={httpOnly:true,sameSite,secure:secureCookies,maxAge:sessionSeconds*1000,path:'/'};
 app.get('/api/system/status',async(_q,res)=>res.json(await getSetupStatus()));
 app.post('/api/setup',async(req,res,next)=>{try{res.status(201).json(await completeSetup(req.body));}catch(e){next(e);}});
 app.post('/api/access/login',async(req,res)=>{const user=await getUserByUsername(req.body?.username);if(!user||!user.active||!verifyPassword(req.body?.password,user.password_hash))return res.status(401).json({message:'Usuário ou senha inválidos.'});const profiles=await profilesForUser(user.id),active=profiles.find(p=>p.isDefault)||profiles[0]||null,id=randomBytes(32).toString('base64url');await query("INSERT INTO user_sessions(id,user_id,active_profile_id,expires_at) VALUES($1,$2,$3,NOW()+($4 * INTERVAL '1 second'))",[id,user.id,active?.id||null,sessionSeconds]);await markLogin(user.id);res.cookie(SESSION_COOKIE,id,cookie);res.json({authenticated:true,mustChangePassword:Boolean(user.must_change_password),user:await getUserById(user.id),activeProfile:active,profiles});});
 app.get('/api/access/session',async(req,res)=>{const ctx=await sessionContext(req);return ctx?res.json({authenticated:true,...ctx}):res.status(401).json({authenticated:false});});
 app.get('/api/auth/me',async(req,res)=>{const ctx=await sessionContext(req);return ctx?res.json(ctx):res.status(401).json({message:'Autenticação necessária.'});});
 app.post('/api/access/logout',async(req,res)=>{const id=req.cookies?.[SESSION_COOKIE];if(id)await query('DELETE FROM user_sessions WHERE id=$1',[id]);res.clearCookie(SESSION_COOKIE,cookie);res.status(204).end();});
 app.post('/api/access/change-password',async(req,res)=>{const ctx=await sessionContext(req);if(!ctx)return res.status(401).json({message:'Autenticação necessária.'});try{await updatePassword(ctx.user.id,req.body?.password);if(ctx.user.username==='admin')await clearAdminBootstrap();res.json({user:await getUserById(ctx.user.id)});}catch(e){res.status(e.statusCode||400).json({message:e.message});}});
 app.use('/api',async(req,res,next)=>{const publicPaths=new Set(['/health','/system/status','/setup','/access/login','/access/logout','/access/session','/access/change-password']);if(publicPaths.has(req.path))return next();const status=await getSetupStatus();if(process.env.NODE_ENV==='test'&&!process.env.APP_ACCESS_SECRET&&status.setupRequired)return next();if(status.setupRequired)return res.status(428).json({message:'A configuração inicial precisa ser concluída.',code:'SETUP_REQUIRED'});const ctx=await sessionContext(req);if(!ctx)return res.status(401).json({message:'Autenticação necessária.'});req.user=ctx.user;req.sessionContext=ctx;req.profileId=ctx.activeProfile?.id||null;next();});
 app.get('/api/settings/general',async(req,res)=>res.json({data:await getGeneralSettings()}));
 app.put('/api/settings/general',requireAdmin,async(req,res)=>{const data=await saveGeneralSettings(req.body,req.user.id);await recordAdminAudit(req.user.id,'SYSTEM_SETTING_CHANGED','system','general',{fields:Object.keys(req.body||{})});res.json({data});});
 app.get('/api/access/users',requireAdmin,async(_q,res)=>res.json({data:await listUsers()}));
 app.post('/api/access/users',requireAdmin,async(req,res,next)=>{try{const data=await createUser({...req.body,mustChangePassword:true});await recordAdminAudit(req.user.id,'USER_CREATED','user',data.id,{role:data.role});res.status(201).json({data});}catch(e){next(e);}});
 app.patch('/api/access/users/:id',requireAdmin,async(req,res,next)=>{try{const target=await getUserById(req.params.id);if(!target)return res.status(404).json({message:'Usuário não encontrado.'});if((req.body.active===false||req.body.role==='user')&&target.role==='admin'){const count=await query("SELECT COUNT(*)::int total FROM users WHERE role='admin' AND active=TRUE AND id<>$1",[target.id]);if(!Number(count.rows[0].total))return res.status(409).json({message:'O último administrador ativo não pode ser removido ou desativado.'});}const allowed={displayName:req.body.displayName??null,email:req.body.email??null,role:['admin','user'].includes(req.body.role)?req.body.role:null,active:typeof req.body.active==='boolean'?req.body.active:null};await query('UPDATE users SET display_name=COALESCE($1,display_name),email=COALESCE($2,email),role=COALESCE($3,role),active=COALESCE($4,active),updated_at=NOW() WHERE id=$5',[allowed.displayName,allowed.email,allowed.role,allowed.active,target.id]);const data=await getUserById(target.id);await recordAdminAudit(req.user.id,'USER_UPDATED','user',target.id,{fields:Object.keys(req.body||{}).filter(key=>['displayName','email','role','active'].includes(key))});res.json({data});}catch(e){next(e);}});
 app.post('/api/access/users/:id/reset-password',requireAdmin,async(req,res,next)=>{try{await resetPassword(req.params.id,req.body.password);await query('DELETE FROM user_sessions WHERE user_id=$1',[req.params.id]);await recordAdminAudit(req.user.id,'USER_PASSWORD_RESET','user',req.params.id);res.status(204).end();}catch(e){next(e);}});
 app.delete('/api/access/users/:id',requireAdmin,async(req,res)=>{const target=await getUserById(req.params.id);if(!target)return res.status(404).json({message:'Usuário não encontrado.'});if(target.id===req.user.id)return res.status(409).json({message:'Você não pode excluir sua própria conta.'});if(target.role==='admin'){const count=await query("SELECT COUNT(*)::int total FROM users WHERE role='admin' AND active=TRUE AND id<>$1",[target.id]);if(!Number(count.rows[0].total))return res.status(409).json({message:'O último administrador ativo não pode ser excluído.'});}await query('DELETE FROM users WHERE id=$1',[target.id]);await recordAdminAudit(req.user.id,'USER_DELETED','user',target.id,{username:target.username});res.status(204).end();});
}
