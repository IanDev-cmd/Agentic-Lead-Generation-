import { inflateRawSync } from 'node:zlib';

const CAP = 80000;

export function officeText(buffer) {
  const entries = zipEntries(buffer);
  if (entries.length) {
    const text = officeFromZip(entries);
    if (text) return text.slice(0, CAP);
  }
  return binaryStrings(buffer).slice(0, CAP);
}

function officeFromZip(entries) {
  const files = new Map(entries.map((entry) => [entry.name.replace(/\\/g, '/').toLowerCase(), entry.text]));
  const sheets = [...files.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort();
  if (sheets.length) {
    const shared = sharedStrings(files.get('xl/sharedstrings.xml') || '');
    return sheets.map((name) => sheetTable(files.get(name), shared)).filter(Boolean).join('\n\n');
  }
  const parts = [...files.entries()]
    .filter(([name]) => name.endsWith('document.xml') || name === 'content.xml' || /ppt\/slides\/slide\d+\.xml$/.test(name) || /word\/header\d+\.xml$/.test(name) || /word\/footer\d+\.xml$/.test(name))
    .map(([, text]) => xmlText(text));
  return parts.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function sharedStrings(xml) {
  return [...String(xml).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) =>
    [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => decodeXml(part[1])).join('')
  );
}

function sheetTable(xml, shared) {
  const rows = [...String(xml).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)];
  return rows.map((row) => [...row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)]
    .map((cell) => cellValue(cell[1], cell[2], shared))
    .join('\t')
    .trimEnd()).filter((line) => line.replace(/\t/g, '').trim()).join('\n');
}

function cellValue(attrs, body, shared) {
  const type = (/\bt="([^"]+)"/.exec(attrs) || [])[1] || '';
  if (type === 'inlineStr') {
    return [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => decodeXml(part[1])).join(' ');
  }
  const raw = (/<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body) || [])[1] || '';
  if (type === 's') return shared[Number(raw)] || '';
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
  return decodeXml(raw);
}

function zipEntries(buffer) {
  const central = centralEntries(buffer);
  if (central.length) return central;
  return localEntries(buffer);
}

function centralEntries(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 > buffer.length) return [];
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < count && offset + 46 <= buffer.length; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    entries.push({ name, text: inflateLocal(buffer, localOffset, method, compressed) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function localEntries(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 30 < buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressed = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const data = buffer.subarray(dataStart, Math.min(buffer.length, dataStart + compressed));
    entries.push({ name, text: inflate(method, data) });
    offset = dataStart + compressed;
  }
  return entries;
}

function inflateLocal(buffer, offset, method, compressed) {
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) return '';
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  return inflate(method, buffer.subarray(dataStart, Math.min(buffer.length, dataStart + compressed)));
}

function inflate(method, data) {
  if (method === 0) return data.toString('utf8');
  if (method !== 8) return '';
  try { return inflateRawSync(data).toString('utf8'); } catch { return ''; }
}

function xmlText(xml) {
  return decodeXml(String(xml || '').replace(/<[^>]+>/g, ' ')).replace(/[ \t]{2,}/g, ' ').trim();
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => safeChar(Number(num)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function safeChar(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  return String.fromCodePoint(code);
}

function binaryStrings(buffer) {
  const found = [];
  let utf = '';
  for (let index = 0; index + 1 < buffer.length; index += 2) {
    const code = buffer.readUInt16LE(index);
    if ((code >= 32 && code <= 126) || (code >= 160 && code <= 591)) utf += String.fromCharCode(code);
    else {
      if (utf.length >= 4) found.push(utf);
      utf = '';
    }
  }
  if (utf.length >= 4) found.push(utf);
  return [...new Set(found)].join('\n').trim();
}
