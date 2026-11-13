const SOCIAL_HOSTS = ['linkedin.com', 'facebook.com', 'fb.com', 'instagram.com', 'x.com', 'twitter.com', 'youtube.com', 'youtu.be', 'reddit.com', 'tiktok.com', 'pinterest.com'];
const cache = new Map();

function hostOf(value) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    const bare = String(value || '').trim().toLowerCase().replace(/^www\./, '').split('/')[0];
    return bare.includes('.') ? bare : '';
  }
}

export function isSocialHost(host) {
  const name = String(host || '').toLowerCase().replace(/^www\./, '');
  return SOCIAL_HOSTS.some((item) => name === item || name.endsWith(`.${item}`));
}

export function isPlatformIcon(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'static.licdn.com' || host === 'static.xx.fbcdn.net') return true;
  if (isSocialHost(host) && !host.startsWith('media.')) return true;
  if (parsed.pathname.includes('/s2/favicons')) {
    return isSocialHost(parsed.searchParams.get('domain') || '');
  }
  return false;
}

function isFaviconService(url) {
  try {
    return new URL(url).pathname.includes('/s2/favicons');
  } catch {
    return false;
  }
}

export function ownHost(value) {
  const host = hostOf(value);
  if (!host || isSocialHost(host) || isPrivateHost(host)) return '';
  return host;
}

export function ownWebsite(value) {
  const host = ownHost(value);
  return host ? `https://${host}` : '';
}

export function faviconFor(host) {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`;
}

function isPrivateHost(host) {
  const name = String(host || '').toLowerCase();
  if (!name || name === 'localhost' || name.endsWith('.local') || name.endsWith('.internal')) return true;
  if (name.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(name)) return true;
  return false;
}

export function safePageUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    return '';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
  if (parsed.username || parsed.password) return '';
  if (isPrivateHost(parsed.hostname)) return '';
  return parsed.toString();
}

function absUrl(value, base) {
  try {
    return new URL(value, base).toString();
  } catch {
    return '';
  }
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
  return match ? match[1].trim() : '';
}

export function imagesIn(html, base) {
  const found = [];
  const text = String(html || '');
  for (const tag of text.match(/<meta\b[^>]*>/gi) || []) {
    const key = `${attr(tag, 'property')} ${attr(tag, 'name')}`.toLowerCase();
    if (!/og:image|twitter:image/.test(key)) continue;
    const url = absUrl(attr(tag, 'content'), base);
    if (url && !isPlatformIcon(url)) found.push({ kind: 'image', url });
  }
  for (const tag of text.match(/<link\b[^>]*>/gi) || []) {
    const rel = attr(tag, 'rel').toLowerCase();
    const url = absUrl(attr(tag, 'href'), base);
    if (!url || isPlatformIcon(url)) continue;
    if (rel.includes('apple-touch-icon')) found.push({ kind: 'apple', url });
    else if (/(^|\s)icon(\s|$)/.test(rel)) found.push({ kind: 'icon', url });
  }
  return found;
}

function pickImage(found) {
  return found.find((item) => item.kind === 'apple')?.url
    || found.find((item) => item.kind === 'image')?.url
    || found.find((item) => item.kind === 'icon' && !item.url.endsWith('.ico'))?.url
    || found.find((item) => item.kind === 'icon')?.url
    || '';
}

function words(value) {
  return String(value || '').toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2);
}

function titleFits(query, title) {
  const wanted = words(query);
  const found = new Set(words(title));
  if (!wanted.length || !found.size) return false;
  return wanted.every((token) => found.has(token));
}

async function readPage(url, fetchImpl) {
  const target = safePageUrl(url);
  if (!target) return '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetchImpl(target, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        accept: 'text/html,application/json',
        'user-agent': 'LeadDesk/1.0 (public logo lookup)',
      },
    });
    if (!response.ok || !safePageUrl(response.url || target)) return '';
    const type = response.headers.get('content-type') || '';
    if (type && !/text\/html|application\/xhtml|application\/json/i.test(type)) return '';
    return (await response.text()).slice(0, 800000);
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function imagesOn(url, fetchImpl) {
  const html = await readPage(url, fetchImpl);
  return imagesIn(html, url);
}

function filePath(name) {
  const file = String(name || '').trim().replace(/ /g, '_');
  if (!file) return '';
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=500`;
}

function claimValue(claims, property) {
  return claims?.[property]?.[0]?.mainsnak?.datavalue?.value || '';
}

async function wikidataMark(name, fetchImpl) {
  const query = String(name || '').trim();
  if (query.length < 2) return { site: '', image: '' };
  const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(query)}&language=en&format=json&limit=5`;
  let hits = [];
  try {
    hits = JSON.parse(await readPage(searchUrl, fetchImpl) || '{}').search || [];
  } catch {
    hits = [];
  }
  const hit = hits.find((item) => titleFits(query, item.label));
  if (!hit?.id) return { site: '', image: '' };
  let claims = {};
  try {
    const entity = JSON.parse(await readPage(`https://www.wikidata.org/wiki/Special:EntityData/${hit.id}.json`, fetchImpl) || '{}');
    claims = entity.entities?.[hit.id]?.claims || {};
  } catch {
    claims = {};
  }
  const portrait = filePath(claimValue(claims, 'P18'));
  const logo = filePath(claimValue(claims, 'P154'));
  return { site: String(claimValue(claims, 'P856') || ''), image: portrait || logo };
}

export async function resolveMark(input = {}, fetchImpl = globalThis.fetch) {
  const company = String(input.company || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const contact = String(input.contact || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const photo = String(input.photo || '').trim();
  const own = ownHost(input.website) || ownHost(input.source);
  const key = [company, contact, own, String(input.source || '').slice(0, 180), photo].join('|');
  if (cache.has(key)) return cache.get(key);
  const resolved = await lookupMark({ company, contact, photo, own, source: input.source }, fetchImpl);
  cache.set(key, resolved);
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return resolved;
}

async function lookupMark({ company, contact, photo, own, source }, fetchImpl) {
  if (photo && !isPlatformIcon(photo) && !isFaviconService(photo)) return photo;
  let host = own;
  if (host) {
    const fromSite = pickImage(await imagesOn(`https://${host}/`, fetchImpl));
    if (fromSite) return fromSite;
  }
  const sourceUrl = safePageUrl(source);
  if (sourceUrl) {
    const fromSource = pickImage(await imagesOn(sourceUrl, fetchImpl));
    if (fromSource) return fromSource;
  }
  const companyMark = await wikidataMark(company, fetchImpl);
  const samePerson = contact && contact.toLowerCase() === company.toLowerCase();
  const personMark = contact && !samePerson ? await wikidataMark(contact, fetchImpl) : { site: '', image: '' };
  if (samePerson && companyMark.image) return companyMark.image;
  const official = ownHost(companyMark.site) || ownHost(personMark.site);
  if (!host && official) {
    const fromOfficial = pickImage(await imagesOn(`https://${official}/`, fetchImpl));
    if (fromOfficial) return fromOfficial;
    host = official;
  }
  if (!samePerson && personMark.image) return personMark.image;
  if (companyMark.image) return companyMark.image;
  if (host) return faviconFor(host);
  return '';
}
