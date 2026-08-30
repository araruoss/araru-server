import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import YAML from 'yaml';

const source = fs.readFileSync(new URL('../server/routes/v1Routes.js', import.meta.url), 'utf8');
const accessSource = fs.readFileSync(new URL('../server/middleware/security.js', import.meta.url), 'utf8');
const spec = YAML.parse(fs.readFileSync(new URL('../api/openapi.yaml', import.meta.url), 'utf8'));
const normalize = (value) => value.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
const actual = new Set([...source.matchAll(/router\.(get|post|put|patch|delete)\('\/([^']*)'/g)].map((match) => `${match[1].toUpperCase()} /v1/${normalize(match[2])}`));
for (const match of accessSource.matchAll(/app\.(get|post)\('\/api\/v1([^']*)'/g)) actual.add(`${match[1].toUpperCase()} /v1${normalize(match[2])}`);
const documented = new Set();
for (const [path, operations] of Object.entries(spec.paths || {})) for (const method of Object.keys(operations)) if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) documented.add(`${method.toUpperCase()} ${path}`);

test('rotas v1 declaradas possuem contrato OpenAPI', () => {
  const missing = [...actual].filter((route) => !documented.has(route));
  assert.deepEqual(missing, [], `Rotas não documentadas: ${missing.join(', ')}`);
});

test('OpenAPI declara filtros modernos de works e contratos administrativos', () => {
  const parameters = (spec.paths['/v1/works']?.get?.parameters || []).map((item) => item.name || item.$ref);
  for (const name of ['libraryId', 'author', 'category', 'format', 'favorite', 'completed', 'sort', 'order']) assert.ok(parameters.includes(name), `Filtro ausente: ${name}`);
  for (const path of ['/v1/admin/metadata/export', '/v1/admin/jobs', '/v1/admin/backup', '/v1/admin/security']) assert.ok(spec.paths[path], `Contrato ausente: ${path}`);
});
