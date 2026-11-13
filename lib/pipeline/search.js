import { groundingTargets, isGroundingRedirect, resolveFinalUrl } from './gemini.js';
import { searchPrompt } from './prompts.js';

export function parseOrgLines(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).flatMap((line) => {
    if (!line.includes('|')) return [];
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 5) return [];
    if (/^org$/i.test(cells[0]) || /^-+$/.test(cells[0])) return [];
    return [{
      company: cells[0],
      website: cells[1],
      fact: cells[2],
      evidenceUrl: cells[3],
      signalType: cells[4],
    }];
  });
}

async function settleUrl(url, fetchImpl) {
  if (!url) return '';
  if (!isGroundingRedirect(url) && !/^https?:/i.test(url)) return url;
  try {
    return await resolveFinalUrl(url, fetchImpl);
  } catch {
    return isGroundingRedirect(url) ? '' : url;
  }
}

export async function searchQueries({ queries, spec, generateGrounded, fetchImpl, concurrency = 3, deadline }) {
  const rows = [];
  const counts = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (cursor < queries.length) {
      if (deadline?.expired?.()) return;
      const index = cursor;
      cursor += 1;
      const query = queries[index];
      try {
        const response = await generateGrounded(searchPrompt(query, spec));
        if (response?.stopped) return;
        const text = response?.text || '';
        const parsed = parseOrgLines(text);
        const chunks = groundingTargets(response);
        for (const chunk of chunks) {
          const finalUrl = await settleUrl(chunk.uri, fetchImpl);
          if (finalUrl && !parsed.some((row) => row.evidenceUrl === finalUrl)) {
            parsed.push({ company: chunk.title || '', website: finalUrl, fact: '', evidenceUrl: finalUrl, signalType: 'page' });
          }
        }
        for (const row of parsed) {
          row.evidenceUrl = await settleUrl(row.evidenceUrl, fetchImpl);
          row.website = await settleUrl(row.website, fetchImpl);
          row.query = query;
        }
        counts.push({ query, count: parsed.length });
        rows.push(...parsed.filter((row) => row.company || row.website));
      } catch (error) {
        if (error?.code === 'quota' || error?.code === 'no-key') throw error;
        counts.push({ query, count: 0, error: error instanceof Error ? error.message : 'search failed' });
      }
    }
  });
  await Promise.all(workers);
  return { rows, counts };
}
