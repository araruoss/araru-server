import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';

const startedAt = Date.now();
let requests = 0;
let errors = 0;
let activeRequests = 0;
let totalDurationMs = 0;
const statuses = {};
const routes = new Map();
const recentDurations = [];

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function routeName(req) {
  if (req.route?.path) return `${req.method} ${req.baseUrl || ''}${req.route.path}`;
  return `${req.method} ${req.path.replace(/\/local-[^/]+/g, '/:id').replace(/\/\d+(?=\/|$)/g, '/:number')}`;
}

export function metricsMiddleware(req, res, next) {
  requests += 1;
  activeRequests += 1;
  const started = process.hrtime.bigint();
  const requestId = req.get('x-request-id') || randomUUID();
  req.requestId = requestId;
  res.set('X-Request-Id', requestId);
  res.once('finish', () => {
    activeRequests = Math.max(0, activeRequests - 1);
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    totalDurationMs += durationMs;
    recentDurations.push(durationMs);
    if (recentDurations.length > 500) recentDurations.shift();
    const family = `${Math.floor(res.statusCode / 100)}xx`;
    statuses[family] = (statuses[family] || 0) + 1;
    const route = routeName(req);
    const current = routes.get(route) || { requests: 0, errors: 0, totalDurationMs: 0, maxDurationMs: 0 };
    current.requests += 1;
    current.errors += res.statusCode >= 500 ? 1 : 0;
    current.totalDurationMs += durationMs;
    current.maxDurationMs = Math.max(current.maxDurationMs, durationMs);
    routes.set(route, current);
    logger.info('http.request.completed', { requestId, method: req.method, path: req.originalUrl?.split('?')[0], status: res.statusCode, durationMs: Number(durationMs.toFixed(2)) });
  });
  next();
}

export function registrarErro() { errors += 1; }

export function obterMetricasRuntime() {
  const memory = process.memoryUsage();
  return {
    startedAt: new Date(startedAt).toISOString(),
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    requests, activeRequests, errors, statuses,
    latencyMs: {
      average: requests ? Number((totalDurationMs / requests).toFixed(2)) : 0,
      p50: Number(percentile(recentDurations, 0.5).toFixed(2)),
      p95: Number(percentile(recentDurations, 0.95).toFixed(2)),
      maxRecent: Number((Math.max(0, ...recentDurations)).toFixed(2))
    },
    memoryBytes: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, external: memory.external },
    routes: [...routes.entries()].map(([route, value]) => ({
      route, requests: value.requests, errors: value.errors,
      averageDurationMs: Number((value.totalDurationMs / value.requests).toFixed(2)),
      maxDurationMs: Number(value.maxDurationMs.toFixed(2))
    })).sort((a, b) => b.requests - a.requests).slice(0, 30)
  };
}
