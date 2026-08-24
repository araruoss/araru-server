import { obterEstadoLeitura, salvarEstadoLeitura } from '../services/readingStateService.js';
import { resolveProfile } from '../services/profileService.js';

async function profile(req) { return resolveProfile(req.profileId || req.cookies?.biblioteca_profile || req.get('x-profile-id') || 'default'); }

export async function getReadingState(req, res, next) {
  try { const profileId = await profile(req); return res.json({ data: await obterEstadoLeitura(profileId), profileId }); } catch (error) { return next(error); }
}

export async function putReadingState(req, res, next) {
  try { const profileId = await profile(req); return res.json({ data: await salvarEstadoLeitura(req.body || {}, profileId), profileId }); } catch (error) { return next(error); }
}
