import { env } from '../../config/drive.js';
import { getRedisClient } from '../redisService.js';

const keyFor = (key) => `metadata:${key}`;
export async function getCachedApiResult(key) { const redis = getRedisClient(); if (!redis) return null; try { if (redis.status === 'wait') await redis.connect(); const value = await redis.get(keyFor(key)); const parsed = value ? JSON.parse(value) : null; return parsed?.payload ?? parsed; } catch { return null; } }
export async function setCachedApiResult(key, provider, queryType, payload, positive = true) { const redis = getRedisClient(); if (!redis) return; const days = positive ? env.metadataApiCacheDays : env.metadataNegativeCacheDays; try { if (redis.status === 'wait') await redis.connect(); await redis.set(keyFor(key), JSON.stringify({ provider, queryType, payload }), 'EX', Math.max(60, days * 86400)); } catch { /* Cache indisponível não interrompe o enriquecimento. */ } }
export async function removerResultadosExpirados() { return 0; }
