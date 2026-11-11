import { inflateRawSync } from 'node:zlib';

export function officeText(buffer) {
  const chunks = [];
  for (const entry of zipEntries(buffer)) {
    const name = entry.name.toLowerCase();
    const useful = name.endsWith('document.xml') || name.endsWith('sharedstrings.xml') || /ppt\/slides\/slide\d+\.xml$/.test(name);
    if (!useful) continue;
    chunks.push(xmlText(entry.text));
    if (chunks.join('\n').length > 80000) break;
  }
  return chunks.join('\n').replace(/\s+/g, ' ').trim().slice(0, 80000);
}

function zipEntries(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 30 < buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const compressed = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const data = buffer.subarray(dataStart, dataStart + compressed);
    let text = '';
    if (method === 0) text = data.toString('utf8');
    else if (method === 8) {
      try { text = inflateRawSync(data).toString('utf8'); } catch { text = ''; }
    }
    entries.push({ name, text });
    offset = dataStart + compressed;
  }
  return entries;
}

function xmlText(xml) {
  return String(xml || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
