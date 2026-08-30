import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const startedAt = Date.now();
let requests = 0;
let errors = 0;
let activeRequests = 0;
let totalDurationMs = 0;
const statuses = {};
const routes = new Map();
const recentDurations = [];
const storageMetrics = { requests: 0, failures: 0, bytes: 0, rangeRequests: 0, rangeFailures: 0, totalDurationMs: 0 };
const eventLoop = monitorEventLoopDelay({ resolution: 20 });
eventLoop.enable();

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
export function registrarStorageMetric({ durationMs = 0, bytes = 0, range = false, failed = false } = {}) {
  storageMetrics.requests += 1; storageMetrics.totalDurationMs += Number(durationMs) || 0; storageMetrics.bytes += Number(bytes) || 0;
  if (range) storageMetrics.rangeRequests += 1;
  if (failed) { storageMetrics.failures += 1; if (range) storageMetrics.rangeFailures += 1; }
}

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
    storage: { ...storageMetrics, averageDurationMs: storageMetrics.requests ? Number((storageMetrics.totalDurationMs / storageMetrics.requests).toFixed(2)) : 0 },
    eventLoopLagMs: { mean: Number((eventLoop.mean / 1e6).toFixed(2)), p95: Number((eventLoop.percentile(95) / 1e6).toFixed(2)), max: Number((eventLoop.max / 1e6).toFixed(2)) },
    routes: [...routes.entries()].map(([route, value]) => ({
      route, requests: value.requests, errors: value.errors,
      averageDurationMs: Number((value.totalDurationMs / value.requests).toFixed(2)),
      maxDurationMs: Number(value.maxDurationMs.toFixed(2))
    })).sort((a, b) => b.requests - a.requests).slice(0, 30)
  };
}
