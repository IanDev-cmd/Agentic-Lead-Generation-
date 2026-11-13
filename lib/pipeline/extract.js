import { companyHost } from '../collectors/http.js';
import { extractPrompt } from './prompts.js';

export function visibleText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function quoteWords(text, max = 25) {
  return String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).slice(0, max).join(' ');
}

export function applyQuote(candidate, pageText) {
  const quote = quoteWords(candidate?.evidence_quote);
  const page = String(pageText || '').replace(/\s+/g, ' ');
  if (quote && page.includes(quote)) {
    return { ...candidate, evidence_quote: quote, quoteVerified: true };
  }
  return { ...candidate, evidence_quote: '', quoteVerified: false, highEligible: false };
}

export function groupByDomain(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const domain = companyHost(row.website || row.evidenceUrl || row.domain || '');
    if (!domain) continue;
    const current = groups.get(domain) || { domain, company: row.company || '', website: row.website || `https://${domain}`, rows: [] };
    if (!current.company && row.company) current.company = row.company;
    current.rows.push(row);
    groups.set(domain, current);
  }
  return [...groups.values()];
}

export async function extractCandidates({ rows, fetchPage, generateJson, limit, deadline }) {
  const groups = groupByDomain(rows).slice(0, limit);
  const prepared = [];
  for (const group of groups) {
    if (deadline?.expired?.()) break;
    const evidenceUrl = group.rows.find((row) => row.evidenceUrl)?.evidenceUrl || group.website;
    let pageText = group.rows.map((row) => row.fact).filter(Boolean).join(' ');
    if (fetchPage && evidenceUrl) {
      try {
        const page = await fetchPage(evidenceUrl);
        if (page?.ok) pageText = `${pageText} ${visibleText(page.text)}`.trim();
      } catch {
        pageText = pageText.trim();
      }
    }
    prepared.push({ ...group, evidenceUrl, pageText: pageText.slice(0, 4000) });
  }
  const extracted = [];
  for (let index = 0; index < prepared.length; index += 5) {
    if (deadline?.expired?.()) break;
    const batch = prepared.slice(index, index + 5);
    let parsed = [];
    try {
      const result = await generateJson(extractPrompt(batch.map((item) => ({
        company: item.company,
        domain: item.domain,
        evidence_url: item.evidenceUrl,
        page_text: item.pageText,
      }))));
      parsed = Array.isArray(result) ? result : (result?.candidates || []);
    } catch (error) {
      if (error?.code === 'quota' || error?.code === 'no-key') throw error;
      parsed = batch.map((item) => ({
        company: item.company,
        domain: item.domain,
        evidence_url: item.evidenceUrl,
        evidence_quote: '',
        signal: item.rows[0]?.fact || '',
      }));
    }
    for (const item of parsed) {
      const domain = companyHost(item.domain || item.website || '') || item.domain;
      const source = batch.find((entry) => entry.domain === domain) || batch[0];
      extracted.push(applyQuote({
        ...item,
        company: item.company || source?.company || '',
        domain,
        website: item.website || source?.website || (domain ? `https://${domain}` : ''),
        evidence_url: item.evidence_url || source?.evidenceUrl || '',
        pageText: source?.pageText || '',
        signal: item.signal || source?.rows?.[0]?.fact || '',
        signal_type: item.signal_type || source?.rows?.[0]?.signalType || '',
      }, source?.pageText || ''));
    }
  }
  return extracted.filter((item) => item.company && item.domain);
}
