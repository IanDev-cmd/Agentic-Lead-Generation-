import { companyHost } from '../collectors/http.js';
import { visibleText } from './extract.js';

export const DENY_HOSTS = [
  'linkedin.com', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com', 'youtube.com', 'tiktok.com',
  'wikipedia.org', 'crunchbase.com', 'zoominfo.com', 'yelp.com', 'yellowpages.com',
  'amazon.com', 'alibaba.com', 'ebay.com', 'reddit.com', 'medium.com',
  'reuters.com', 'bbc.com', 'bbc.co.uk', 'cnn.com', 'nytimes.com', 'theguardian.com',
  'indeed.com', 'glassdoor.com', 'brightermonday.co.ke', 'myjobmag.com',
  'news.google.com', 'google.com',
];

export function deniedHost(domain) {
  const host = companyHost(domain) || String(domain || '').replace(/^www\./, '').toLowerCase();
  return DENY_HOSTS.some((item) => host === item || host.endsWith(`.${item}`));
}

export function nameOnPage(company, text) {
  const tokens = String(company || '').toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2);
  if (!tokens.length) return false;
  const page = String(text || '').toLowerCase();
  const hits = tokens.filter((token) => page.includes(token));
  return hits.length >= Math.ceil(tokens.length * 0.6);
}

function sameName(left, right) {
  const a = String(left || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const b = String(right || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function hostOfCandidate(candidate) {
  return companyHost(candidate.website || '')
    || companyHost(candidate.domain || '')
    || companyHost(`https://${candidate.domain || ''}`)
    || String(candidate.domain || '').replace(/^www\./, '').toLowerCase();
}

export function exclusionReason(candidate, spec) {
  const domain = hostOfCandidate(candidate);
  if (!domain) return 'missing-domain';
  if (deniedHost(domain)) return 'denylist';
  if (spec?.seller?.name && sameName(spec.seller.name, candidate.company)) return 'seller';
  const clients = spec?.existing_clients || [];
  if (clients.some((client) => sameName(client, candidate.company))) return 'existing-client';
  const excluded = new Set((spec?.exclude_domains || []).map((item) => companyHost(item) || companyHost(`https://${item}`) || String(item).toLowerCase()));
  if (spec?.seller?.domain) excluded.add(companyHost(spec.seller.domain) || companyHost(`https://${spec.seller.domain}`) || String(spec.seller.domain).toLowerCase());
  if (excluded.has(domain)) return 'seller-or-excluded-domain';
  return '';
}

export async function verifyCandidates(candidates, { fetchPage, spec, deadline } = {}) {
  const kept = [];
  const dropped = [];
  const seenDomains = new Set();
  const seenNames = new Set();
  for (const candidate of candidates || []) {
    if (deadline?.expired?.()) break;
    const domain = hostOfCandidate(candidate);
    const reason = exclusionReason({ ...candidate, domain }, spec);
    if (reason) {
      dropped.push({ company: candidate.company, domain, reason });
      continue;
    }
    let page = candidate.pageText || '';
    let live = !fetchPage;
    if (fetchPage) {
      try {
        const home = /^https?:/i.test(candidate.website || '') ? candidate.website : `https://${domain}`;
        const response = await fetchPage(home);
        live = Boolean(response?.ok) || (Number(response?.status) >= 200 && Number(response?.status) < 400);
        page = `${page} ${visibleText(response?.text || '')}`;
      } catch {
        live = false;
      }
    }
    if (!live) {
      dropped.push({ company: candidate.company, domain, reason: 'dead-domain' });
      continue;
    }
    if (page && !nameOnPage(candidate.company, page)) {
      dropped.push({ company: candidate.company, domain, reason: 'name-mismatch' });
      continue;
    }
    if (seenDomains.has(domain)) {
      dropped.push({ company: candidate.company, domain, reason: 'duplicate' });
      continue;
    }
    const city = String(candidate.hq || '').toLowerCase();
    const nameKey = `${String(candidate.company || '').toLowerCase()}|${city}`;
    if (seenNames.has(nameKey)) {
      dropped.push({ company: candidate.company, domain, reason: 'duplicate' });
      continue;
    }
    seenDomains.add(domain);
    seenNames.add(nameKey);
    kept.push({ ...candidate, domain, pageText: page });
  }
  return { kept, dropped };
}
