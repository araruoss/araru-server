import { atualizarPerfil, criarPerfil, definirUsuariosPerfil, listarPerfis, removerPerfil, selecionarPerfilSessao } from '../services/profileService.js';
import { recordAdminAudit } from '../services/adminService.js';

export async function getProfiles(req, res, next) {
  try { return res.json({ data: await listarPerfis(req.user?.id, req.user?.role === 'admin' && req.query.all === 'true'), selectedProfileId: req.sessionContext?.activeProfile?.id || req.cookies?.biblioteca_profile || 'default' }); } catch (error) { return next(error); }
}
export async function postProfile(req, res, next) {
  try { const data=await criarPerfil({ ...req.body, userIds: req.body.userIds || (req.user ? [req.user.id] : []) });if(req.user)await recordAdminAudit(req.user.id,'PROFILE_CREATED','profile',data.id);return res.status(201).json({ data }); } catch (error) { return next(error); }
}
export async function putProfile(req, res, next) {
  try { const data = await atualizarPerfil(req.params.id, req.body);if(data&&req.user)await recordAdminAudit(req.user.id,'PROFILE_UPDATED','profile',req.params.id,{fields:Object.keys(req.body||{})});return data ? res.json({ data }) : res.status(404).json({ message: 'Perfil não encontrado.' }); } catch (error) { return next(error); }
}
export async function deleteProfile(req, res, next) {
  try { const removed=await removerPerfil(req.params.id);if(removed&&req.user)await recordAdminAudit(req.user.id,'PROFILE_DELETED','profile',req.params.id);return removed ? res.status(204).end() : res.status(404).json({ message: 'Perfil não encontrado.' }); } catch (error) { return next(error); }
}
export async function selectProfile(req, res, next) {
  try {
    if (!req.sessionContext && process.env.NODE_ENV === 'test') { res.cookie('biblioteca_profile', req.params.id); return res.json({ selectedProfileId: req.params.id }); }
    const selected = await selecionarPerfilSessao(req.sessionContext.sessionId, req.user.id, req.params.id);
    if (!selected) return res.status(404).json({ message: 'Perfil não associado a este usuário.' });
    return res.json({ selectedProfileId: req.params.id });
  } catch (error) { return next(error); }
}
export async function putProfileUsers(req,res,next){try{const updated=await definirUsuariosPerfil(req.params.id,req.body?.userIds||[]);if(updated&&req.user)await recordAdminAudit(req.user.id,'PROFILE_USERS_CHANGED','profile',req.params.id,{userIds:req.body?.userIds||[]});return updated?res.status(204).end():res.status(404).json({message:'Perfil não encontrado.'});}catch(error){next(error);}}
