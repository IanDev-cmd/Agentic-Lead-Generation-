import { clipExplanation } from '../ask.js';
import { isGroundingRedirect } from './gemini.js';

const LEAD_KEYS = ['company', 'domain', 'website', 'hq', 'lat', 'lng', 'contact', 'title', 'email', 'pain', 'hook', 'priority', 'source'];

function numberOrNull(value, limit) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > limit) return null;
  return number;
}

export function safeSource(url, uploadUrls = []) {
  const source = String(url || '').trim();
  if (!source || isGroundingRedirect(source)) return '';
  if (uploadUrls.some((item) => item && source.includes(item))) return '';
  if (!/^https?:\/\//i.test(source)) return '';
  return source;
}

export function mapLead(row, uploadUrls = []) {
  const domain = String(row.domain || '').replace(/^www\./, '').toLowerCase();
  const website = domain ? `https://${domain}` : '';
  const source = safeSource(row.evidence_url || row.source, uploadUrls);
  const priority = row.priority === 'High' && row.hook ? 'High' : 'Low';
  const lead = {
    company: row.company || '',
    domain,
    website,
    hq: row.hq || '',
    lat: numberOrNull(row.lat, 90),
    lng: numberOrNull(row.lng, 180),
    contact: row.contact || '',
    title: row.title || '',
    email: row.email && String(row.email).includes('@') ? row.email : '',
    pain: row.pain || row.pain_inferred_from_signal || row.signal || '',
    hook: priority === 'High' ? row.hook : '',
    priority,
    source: source || website,
    signal: row.signal || '',
    evidence_url: source,
    evidence: row.evidence_quote || '',
    fit_score: Number(row.fit_score) || 0,
    tier: row.tier || '',
  };
  return lead;
}

export function explainLeads(spec, leads) {
  const seller = spec?.seller?.name || 'The seller';
  const offer = spec?.seller?.offering_summary || 'its services';
  const primary = (spec?.regions?.primary || []).filter(Boolean).join(', ') || 'the primary region';
  const primaryCount = (leads || []).filter((lead) => lead.regionRank === 'primary' || (lead.hq && primary.toLowerCase().includes(String(lead.hq).toLowerCase()))).length;
  const shown = primaryCount || (leads || []).length;
  return clipExplanation(`${seller} sells ${offer}. These ${(leads || []).length} companies are possible buyers, ${primary} first, then elsewhere. ${shown} of them are in ${primary}.`);
}

export function mapResult(spec, leads, uploadUrls = []) {
  const mapped = (leads || []).map((lead) => mapLead(lead, uploadUrls));
  for (const lead of mapped) {
    if (!LEAD_KEYS.every((key) => key in lead)) throw new Error('Lead shape is missing a field.');
  }
  return { explanation: explainLeads(spec, leads), leads: mapped };
}
