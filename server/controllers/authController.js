import { createAuthUrl, env, hasDriveConfig, hasGoogleApiKey, oauth2Client } from '../config/drive.js';
import { limparCache } from '../services/driveService.js';
import { removerCredenciaisOAuth, salvarCredenciaisOAuth } from '../services/drivePersistenceService.js';

export function iniciarLogin(req, res, next) {
  try {
    if (env.useMockData || !env.enableGoogleDrive || !hasDriveConfig()) {
      return res.status(200).json({
        message: 'Google Drive nao esta configurado nesta instancia.'
      });
    }

    if (hasGoogleApiKey()) {
      return res.status(200).json({
        message: 'Google Drive publico configurado com GOOGLE_API_KEY. OAuth nao e necessario.'
      });
    }

    return res.redirect(createAuthUrl());
  } catch (error) {
    return next(error);
  }
}

export async function finalizarLogin(req, res, next) {
  try {
    const { code } = req.query;
    if (!code) {
      return res.status(400).json({ message: 'Codigo OAuth nao informado.' });
    }

    const { tokens } = await oauth2Client.getToken(code);
    await salvarCredenciaisOAuth(tokens);
    limparCache();

    return res.redirect(`${env.frontendUrl}/?auth=success`);
  } catch (error) {
    return next(error);
  }
}

export async function sairGoogleDrive(req, res, next) {
  try {
    await removerCredenciaisOAuth();
    limparCache();
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
}
