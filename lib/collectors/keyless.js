import { companyHost, fetchJson, fetchText, titlesFromXml } from './http.js';

function leadFromSite(company, url, sourceName, signal) {
  const domain = companyHost(url);
  if (!domain || !company) return null;
  return {
    company: String(company).slice(0, 120),
    domain,
    website: `https://${domain}`,
    source: url,
    sources: [sourceName],
    signals: signal ? [signal] : [],
    priority: 'Low',
  };
}

async function clearbit(query) {
  const rows = await fetchJson(`https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(query)}`);
  return (Array.isArray(rows) ? rows : []).slice(0, 8).map((item) => {
    const domain = companyHost(`https://${item.domain || ''}`);
    if (!domain || !item.name) return null;
    return {
      company: item.name,
      domain,
      website: `https://${domain}`,
      photo: item.logo || '',
      logo: item.logo || '',
      source: `https://${domain}`,
      sources: ['clearbit'],
      signals: ['Clearbit public company record'],
      priority: 'Low',
    };
  }).filter(Boolean);
}

async function hackerNews(query) {
  const data = await fetchJson(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=6`);
  return (data.hits || []).map((hit) => leadFromSite(hit.title, hit.url, 'hacker_news', hit.title)).filter(Boolean);
}

async function github(query) {
  const data = await fetchJson(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=5`,
    { Accept: 'application/vnd.github+json' },
  );
  return (data.items || []).map((item) => leadFromSite(item.full_name || item.name, item.homepage, 'github', item.description || '')).filter(Boolean);
}

async function wikipedia(query) {
  const data = await fetchJson(`https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=3&namespace=0&format=json`);
  const titles = Array.isArray(data?.[1]) ? data[1] : [];
  const urls = Array.isArray(data?.[3]) ? data[3] : [];
  return titles.map((title, index) => ({
    company: title,
    domain: '',
    website: urls[index] || '',
    source: urls[index] || '',
    sources: ['wikipedia'],
    signals: ['Wikipedia public article'],
    priority: 'Low',
  })).filter((item) => item.company && item.website);
}

export async function keylessNotes(query) {
  const q = String(query || '').trim().slice(0, 180);
  if (q.length < 3) return [];
  const jobs = [
    fetchText(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`).then((xml) => titlesFromXml(xml).map((title) => `Google News: ${title}`)),
    fetchJson(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=ArtList&maxrecords=5&format=json`).then((data) => (data.articles || []).slice(0, 5).map((item) => `GDELT: ${item.title}`)),
    fetchText('https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&count=5&output=atom').then((xml) => titlesFromXml(xml, 3).map((title) => `SEC 8-K: ${title}`)),
    fetchText('https://www.producthunt.com/feed').then((xml) => titlesFromXml(xml, 3).map((title) => `Product Hunt: ${title}`)),
  ];
  const settled = await Promise.allSettled(jobs);
  return settled.flatMap((item) => (item.status === 'fulfilled' ? item.value : [])).filter(Boolean).slice(0, 12);
}

export async function keylessLeads(query) {
  const q = String(query || '').trim().slice(0, 180);
  if (q.length < 3) return [];
  const settled = await Promise.allSettled([clearbit(q), hackerNews(q), github(q), wikipedia(q)]);
  return settled.flatMap((item) => (item.status === 'fulfilled' ? item.value : [])).slice(0, 12);
}
