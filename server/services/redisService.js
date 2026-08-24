import Redis from 'ioredis';
import { env } from '../config/drive.js';
import { logger } from './logger.js';

let client;

export function getRedisClient() {
  if (!env.redisEnabled || !env.redisUrl) return null;
  if (!client) {
    client = new Redis(env.redisUrl, {
      keyPrefix: env.redisKeyPrefix,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: true
    });
    client.on('error', (error) => logger.error('redis.connection_failed', { error }));
  }
  return client;
}

export async function checkRedis() {
  const redis = getRedisClient();
  if (!redis) return { configured: false, healthy: false };
  try {
    if (redis.status === 'wait') await redis.connect();
    await redis.ping();
    return { configured: true, healthy: true };
  } catch (error) {
    return { configured: true, healthy: false, error: error.message };
  }
}

export async function closeRedis() {
  if (!client) return;
  await client.quit().catch(() => client.disconnect());
  client = undefined;
}
