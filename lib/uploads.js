import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { officeText } from './office.js';

const MAX_BYTES = 18 * 1024 * 1024;
const TEXT = new Set(['txt', 'csv', 'md', 'json', 'html', 'htm', 'xml', 'tsv', 'log']);
const INLINE = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'mp3', 'wav', 'm4a', 'mp4', 'webm', 'mov', 'mpeg', 'mpga']);
const OFFICE = new Set(['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt']);

const MIME = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mpeg: 'video/mpeg',
  csv: 'text/csv',
  txt: 'text/plain',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  md: 'text/markdown',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function sourceKind(name) {
  const ext = extension(name);
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'].includes(ext)) return 'Image';
  if (['mp4', 'webm', 'mov', 'mpeg'].includes(ext)) return 'Video';
  if (['mp3', 'wav', 'm4a'].includes(ext)) return 'Audio';
  if (ext === 'pdf') return 'PDF';
  if (['doc', 'docx'].includes(ext)) return 'Word';
  if (['xls', 'xlsx', 'csv', 'tsv'].includes(ext)) return 'Sheet';
  if (['ppt', 'pptx'].includes(ext)) return 'Slides';
  return 'File';
}

export function saveUploads(root, files) {
  const dir = path.join(root, 'output', 'uploads');
  mkdirSync(dir, { recursive: true });
  const saved = [];
  for (const file of files || []) {
    const name = cleanName(file?.name);
    const bytes = decode(file?.data);
    if (!name || !bytes) {
      saved.push({ ok: false, name: name || 'file', error: 'That file had no readable bytes.' });
      continue;
    }
    if (bytes.length > MAX_BYTES) {
      saved.push({ ok: false, name, error: `${name} is over 18 MB. It was not added.` });
      continue;
    }
    const id = randomUUID();
    const meta = { id, name, mime: mimeFor(name, file?.mime), ext: extension(name) };
    writeFileSync(path.join(dir, `${id}.bin`), bytes);
    writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(meta));
    saved.push({ ok: true, id, name, kind: sourceKind(name) });
  }
  return saved;
}

export function loadUpload(root, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null;
  const dir = path.join(root, 'output', 'uploads');
  try {
    const meta = JSON.parse(readFileSync(path.join(dir, `${id}.json`), 'utf8'));
    const bytes = readFileSync(path.join(dir, `${id}.bin`));
    return { ...meta, bytes };
  } catch {
    return null;
  }
}

export function uploadPart(record) {
  const ext = record.ext || extension(record.name);
  if (TEXT.has(ext) || ['csv', 'tsv'].includes(ext)) {
    return { text: `Source file ${record.name}:\n${record.bytes.toString('utf8').slice(0, 80000)}` };
  }
  if (OFFICE.has(ext)) {
    const text = officeText(record.bytes);
    return { text: `Source file ${record.name}:\n${text || 'No readable text was extracted from this office file.'}`, tabular: ['csv', 'xls', 'xlsx', 'tsv'].includes(ext) };
  }
  if (INLINE.has(ext)) {
    return {
      inline: true,
      mime: record.mime || MIME[ext] || 'application/octet-stream',
      data: record.bytes.toString('base64'),
      tabular: false,
    };
  }
  const asText = record.bytes.toString('utf8');
  if (!asText.includes('\u0000')) return { text: `Source file ${record.name}:\n${asText.slice(0, 80000)}` };
  return { text: `Source file ${record.name} is attached as ${record.mime || ext || 'a binary file'}. Use the filename only. Do not invent its contents.` };
}

function extension(name) {
  const match = String(name || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return match ? match[1] : '';
}

function cleanName(name) {
  return String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 180);
}

function mimeFor(name, mime) {
  const given = String(mime || '').trim().toLowerCase();
  if (given && given !== 'application/octet-stream') return given.slice(0, 120);
  return MIME[extension(name)] || 'application/octet-stream';
}

function decode(data) {
  const raw = String(data || '');
  if (!raw) return null;
  try {
    return Buffer.from(raw, 'base64');
  } catch {
    return null;
  }
}
