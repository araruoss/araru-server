import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { env } from '../../config/drive.js';
import { cleanDisplayText, extractYear } from './normalizer.js';
import { extractIsbns, isbnForms } from './isbn.js';

let pdfParseModulePromise;
const execFileAsync = promisify(execFile);

async function readBuffer(asset) {
  if (Number(asset.fileSize || 0) > env.readerMaxInMemoryBytes) {
    const error = new Error('Este arquivo excede o limite seguro para extração em memória.');
    error.code = 'METADATA_STREAM_REQUIRED';
    throw error;
  }
  if (typeof asset.getBuffer === 'function') return asset.getBuffer();
  if (asset.filePath) {
    const info = await fs.stat(asset.filePath);
    if (info.size > env.readerMaxInMemoryBytes) {
      const error = new Error('Este arquivo excede o limite seguro para extração em memória. O processamento será retomado por um worker compatível.');
      error.code = 'METADATA_STREAM_REQUIRED';
      throw error;
    }
    return fs.readFile(asset.filePath);
  }
  return null;
}

async function pdfParse() {
  if (!pdfParseModulePromise) pdfParseModulePromise = import('pdf-parse');
  const mod = await pdfParseModulePromise;
  return mod.default || mod;
}

function firstUsefulLine(text = '') {
  return String(text).split(/\r?\n/).map(cleanDisplayText)
    .find((line) => line.length >= 4 && line.length <= 180 && !/^(isbn|sumario|contents|copyright|\d+\s+of\s+\d+)/i.test(line) && !/^\d[\d\s.-]*$/.test(line)) || '';
}

async function extractPdf(asset) {
  if (Number(asset.fileSize || 0) > env.readerMaxInMemoryBytes && asset.filePath) return extractLargePdf(asset);
  const buffer = await readBuffer(asset);
  if (!buffer) return {};
  let parser;
  try {
    const { PDFParse } = await pdfParse();
    parser = new PDFParse({ data: buffer });
    const infoData = await parser.getInfo();
    const pages = Array.from({ length: Math.max(1, env.metadataPdfPages) }, (_, index) => index + 1);
    let textData;
    try {
      textData = await parser.getText({ partial: pages });
    } catch {
      textData = await parser.getText();
    }
    const info = infoData.info || {};
    const text = [textData.text, info.Title, info.Author, info.Subject, info.Keywords].filter(Boolean).join('\n');
    const isbns = extractIsbns(text);
    return {
      nome: cleanDisplayText(info.Title || '') || firstUsefulLine(textData.text),
      autor: info.Author ? [cleanDisplayText(info.Author)] : [],
      editora: cleanDisplayText(info.Publisher || ''),
      descricao: cleanDisplayText(info.Subject || ''),
      ano: extractYear(info.CreationDate || ''),
      ...isbnForms(isbns[0]), isbn: isbns[0] || '',
      numeroPaginas: infoData.total || null,
      idioma: info.Language || '',
      tags: [info.Subject, info.Keywords].filter(Boolean).flatMap((value) => String(value).split(/[;,]/).map(cleanDisplayText).filter(Boolean)),
      evidence: { pdfMetadata: Boolean(info.Title || info.Author), pdfText: Boolean(textData.text), internalIsbn: Boolean(isbns[0]) },
      extractedText: String(textData.text || '').slice(0, 30000)
    };
  } finally {
    await parser?.destroy().catch(() => {});
  }
}

async function extractLargePdf(asset) {
  const timeout = Number(env.metadataTimeoutMs || 30_000);
  const { stdout: infoText } = await execFileAsync('pdfinfo', [asset.filePath], { timeout, maxBuffer: 256 * 1024 });
  const value = (key) => infoText.match(new RegExp(`^${key}:\\s*(.*)$`, 'mi'))?.[1]?.trim() || '';
  let text = '';
  try {
    ({ stdout: text } = await execFileAsync('pdftotext', ['-f', '1', '-l', String(Math.max(1, env.metadataPdfPages)), '-layout', asset.filePath, '-'], { timeout, maxBuffer: 2 * 1024 * 1024 }));
  } catch { /* PDFs with protected text still expose pdfinfo metadata. */ }
  const combined = [text, value('Title'), value('Author'), value('Subject'), value('Keywords')].filter(Boolean).join('\n');
  const isbns = extractIsbns(combined);
  return {
    nome: cleanDisplayText(value('Title')) || firstUsefulLine(text),
    autor: value('Author') ? [cleanDisplayText(value('Author'))] : [], editora: '', descricao: cleanDisplayText(value('Subject')),
    ano: extractYear(value('CreationDate')), ...isbnForms(isbns[0]), isbn: isbns[0] || '', numeroPaginas: Number(value('Pages')) || null,
    idioma: '', tags: [value('Subject'), value('Keywords')].filter(Boolean).flatMap((item) => item.split(/[;,]/).map(cleanDisplayText).filter(Boolean)),
    evidence: { pdfMetadata: Boolean(value('Title') || value('Author')), pdfText: Boolean(text), internalIsbn: Boolean(isbns[0]), streamed: true },
    extractedText: text.slice(0, 30000)
  };
}

function xmlValue(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? cleanDisplayText(match[1].replace(/<[^>]+>/g, ' ')) : '';
}

async function extractEpub(asset) {
  const buffer = await readBuffer(asset);
  if (!buffer) return {};
  const zip = await JSZip.loadAsync(buffer);
  const container = await zip.file('META-INF/container.xml')?.async('text');
  const opfPath = container?.match(/full-path=["']([^"']+)["']/i)?.[1];
  const opf = opfPath ? await zip.file(opfPath)?.async('text') : '';
  if (!opf) return {};
  const identifiers = [...opf.matchAll(/<dc:identifier[^>]*>([\s\S]*?)<\/dc:identifier>/gi)].map((match) => match[1]);
  const isbns = extractIsbns(identifiers.join(' '));
  return {
    nome: xmlValue(opf, 'dc:title'), autor: [...opf.matchAll(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/gi)].map((m) => cleanDisplayText(m[1])).filter(Boolean),
    editora: xmlValue(opf, 'dc:publisher'), descricao: xmlValue(opf, 'dc:description'), ano: extractYear(xmlValue(opf, 'dc:date')),
    idioma: xmlValue(opf, 'dc:language'), tags: [...opf.matchAll(/<dc:subject[^>]*>([\s\S]*?)<\/dc:subject>/gi)].map((m) => cleanDisplayText(m[1])).filter(Boolean),
    ...isbnForms(isbns[0]), isbn: isbns[0] || '', evidence: { epubMetadata: true, internalIsbn: Boolean(isbns[0]) }
  };
}

export async function extractLocalMetadata(asset) {
  const format = (asset.formato || path.extname(asset.nome || asset.filePath || '')).replace('.', '').toLowerCase();
  if (format === 'pdf') return extractPdf(asset).catch((error) => ({ extractionError: error.message }));
  if (format === 'epub') return extractEpub(asset).catch((error) => ({ extractionError: error.message }));
  return { evidence: { [format || 'unknown']: true } };
}
