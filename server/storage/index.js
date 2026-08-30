import { createDriveClient, env, hasGoogleApiKey, hasGoogleCredentials } from '../config/drive.js';
import { LocalStorageProvider } from './localStorageProvider.js';
import { R2StorageProvider } from './r2StorageProvider.js';
import { GoogleDriveStorageProvider } from './googleDriveStorageProvider.js';
import { breakerFor } from '../services/circuitBreaker.js';

let r2;
export function getStorageProviders() {
  const providers = { local: new LocalStorageProvider(env.localLibraryDir) };
  if (env.r2Configured) { r2 ||= new R2StorageProvider(env.r2); providers.r2 = r2; }
  if (env.enableGoogleDrive && (hasGoogleApiKey() || hasGoogleCredentials())) providers.drive = new GoogleDriveStorageProvider({ client: createDriveClient(), request: (task) => breakerFor('google-drive').execute(task) });
  return providers;
}
export function getStorageProvider(type = env.storageProvider) { const provider = getStorageProviders()[type]; if (!provider) throw Object.assign(new Error(`Storage provider não configurado: ${type}`), { code: 'STORAGE_PROVIDER_NOT_CONFIGURED', statusCode: 503 }); return provider; }
export async function storageHealth() { const providers = getStorageProviders(); const result = { local: { provider: 'local', configured: true, healthy: true } }; if (providers.drive) result.drive = { provider: 'drive', configured: true, healthy: null, status: 'configured' }; if (providers.r2) result.r2 = await providers.r2.health(); return result; }
