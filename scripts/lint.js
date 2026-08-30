import fs from 'node:fs';
import path from 'node:path';

const roots = ['server', 'scripts', 'test'];
const files = [];

function walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(js|jsx)$/.test(entry.name)) files.push(full);
  }
}

for (const root of roots) walk(root);

const findings = [];
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  if (/\bTODO\b|\bFIXME\b/.test(source)) findings.push(`${file}: marcador pendente`);
  if (file.startsWith('server/') && /console\.(log|warn|error)\(/.test(source) && !file.endsWith('logger.js')) {
    findings.push(`${file}: console no backend`);
  }
}

if (findings.length) {
  console.error(findings.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`${files.length} arquivos verificados sem pendências ou logs temporários.`);
}
