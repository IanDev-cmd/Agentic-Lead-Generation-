import { fetchJson } from './http.js';

const ADAPTERS = [
  {
    key: 'NEWSDATA_API_KEY',
    signup: 'https://newsdata.io/register',
    run(query, apiKey) {
      return fetchJson(`https://newsdata.io/api/1/latest?apikey=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(query)}&language=en`).then((data) =>
        (data.results || []).slice(0, 5).map((item) => `NewsData: ${item.title}`));
    },
  },
  {
    key: 'GNEWS_API_KEY',
    signup: 'https://gnews.io/register',
    run(query, apiKey) {
      return fetchJson(`https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=en&max=5&token=${encodeURIComponent(apiKey)}`).then((data) =>
        (data.articles || []).slice(0, 5).map((item) => `GNews: ${item.title}`));
    },
  },
  {
    key: 'CURRENTS_API_KEY',
    signup: 'https://currentsapi.services/en/register',
    run(query, apiKey) {
      return fetchJson(`https://api.currentsapi.services/v1/search?keywords=${encodeURIComponent(query)}&apiKey=${encodeURIComponent(apiKey)}`).then((data) =>
        (data.news || []).slice(0, 5).map((item) => `Currents: ${item.title}`));
    },
  },
  {
    key: 'ALPHAVANTAGE_API_KEY',
    signup: 'https://www.alphavantage.co/support/#api-key',
    run(query, apiKey) {
      return fetchJson(`https://www.alphavantage.co/query?function=NEWS_SENTIMENT&topics=technology&limit=5&apikey=${encodeURIComponent(apiKey)}`).then((data) =>
        (data.feed || []).slice(0, 5).map((item) => `Alpha Vantage: ${item.title}`));
    },
  },
  {
    key: 'FINNHUB_API_KEY',
    signup: 'https://finnhub.io/register',
    run(_query, apiKey) {
      return fetchJson(`https://finnhub.io/api/v1/news?category=general&token=${encodeURIComponent(apiKey)}`).then((data) =>
        (Array.isArray(data) ? data : []).slice(0, 5).map((item) => `Finnhub: ${item.headline}`));
    },
  },
  {
    key: 'FMP_API_KEY',
    signup: 'https://site.financialmodelingprep.com/developer/docs',
    run(_query, apiKey) {
      return fetchJson(`https://financialmodelingprep.com/stable/news/general-latest?limit=5&apikey=${encodeURIComponent(apiKey)}`).then((data) =>
        (Array.isArray(data) ? data : []).slice(0, 5).map((item) => `FMP: ${item.title}`));
    },
  },
];

export const optionalKeyNames = ADAPTERS.map((item) => item.key);

export async function keyedNotes(query, env = process.env) {
  const q = String(query || '').trim().slice(0, 180);
  if (q.length < 3) return [];
  const jobs = ADAPTERS.filter((item) => String(env[item.key] || '').trim() && !/^(your-|paste-)/i.test(env[item.key])).map((item) => item.run(q, env[item.key].trim()));
  const settled = await Promise.allSettled(jobs);
  return settled.flatMap((item) => (item.status === 'fulfilled' ? item.value : [])).filter(Boolean).slice(0, 12);
}
