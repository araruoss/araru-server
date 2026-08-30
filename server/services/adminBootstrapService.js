import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/drive.js';

const bootstrapPath = path.join(env.dataDir, '.araru-admin-bootstrap.json');

export async function saveAdminBootstrap(password) {
  await fs.mkdir(env.dataDir, { recursive: true });
  const payload = JSON.stringify({ username: 'admin', temporaryPassword: password, createdAt: new Date().toISOString() });
  await fs.writeFile(bootstrapPath, payload, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(bootstrapPath, 0o600).catch(() => {});
  return bootstrapPath;
}

export async function loadAdminBootstrap() {
  try {
    const payload = JSON.parse(await fs.readFile(bootstrapPath, 'utf8'));
    return payload?.username === 'admin' && payload?.temporaryPassword ? payload : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function clearAdminBootstrap() {
  await fs.rm(bootstrapPath, { force: true });
}

export function getAdminBootstrapPath() {
  return bootstrapPath;
}
