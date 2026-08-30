import { performance } from 'node:perf_hooks';

const baseUrl = process.env.BENCHMARK_URL || 'http://127.0.0.1:3001';
const iterations = Math.max(1, Number(process.env.BENCHMARK_ITERATIONS || 20));
const paths = (process.env.BENCHMARK_PATHS || '/health,/api/v1/system/info,/api/v1/works,/api/v1/admin/system/metrics,/api/v1/admin/jobs').split(',').map((item) => item.trim()).filter(Boolean);

function percentile(values, ratio) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] || 0; }
const result = { baseUrl, iterations, generatedAt: new Date().toISOString(), scenarios: [] };
for (const path of paths) {
  const durations = []; let failures = 0; let bytes = 0;
  for (let i = 0; i < iterations; i += 1) {
    const started = performance.now();
    try { const response = await fetch(`${baseUrl}${path}`); const body = await response.arrayBuffer(); bytes += body.byteLength; if (!response.ok) failures += 1; }
    catch { failures += 1; }
    durations.push(performance.now() - started);
  }
  result.scenarios.push({ path, requests: iterations, failures, bytes, latencyMs: { p50: percentile(durations, .5), p95: percentile(durations, .95), p99: percentile(durations, .99), max: Math.max(...durations) } });
}
console.log(JSON.stringify(result, null, 2));
