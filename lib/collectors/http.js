export async function fetchText(url, headers = {}, ms = 4000) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'lead-desk/1.0', Accept: 'application/json, application/xml, text/xml, */*', ...headers },
    signal: AbortSignal.timeout(ms),
  });
  if (!response.ok) throw new Error(String(response.status));
  return response.text();
}

export async function fetchJson(url, headers = {}, ms = 4000) {
  const text = await fetchText(url, headers, ms);
  return JSON.parse(text);
}

export function hostOf(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

const BLOCKED = new Set([
  'news.ycombinator.com', 'news.google.com', 'google.com', 'youtube.com', 'wikipedia.org',
  'reddit.com', 'twitter.com', 'x.com', 'facebook.com', 'medium.com', 'github.com',
  'producthunt.com', 'sec.gov', 'reuters.com', 'bloomberg.com', 'techcrunch.com',
  'theverge.com', 'bbc.com', 'bbc.co.uk', 'cnn.com', 'nytimes.com', 'yahoo.com',
]);

export function companyHost(value) {
  const host = hostOf(value);
  if (!host || !host.includes('.') || BLOCKED.has(host)) return '';
  return host;
}

export function titlesFromXml(xml, limit = 5) {
  return [...String(xml || '').matchAll(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/gi)]
    .map((match) => match[1].replace(/<[^>]+>/g, '').trim())
    .filter((title) => title && !/^google news$/i.test(title))
    .slice(1, limit + 1);
}
