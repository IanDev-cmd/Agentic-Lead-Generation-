import { parseLeadAnswer } from './ask.js';
import { sourceKind } from './uploads.js';

export const AGENT_WEBHOOK_URL = 'https://proxyproxy.app.n8n.cloud/webhook/multimodal-lead-gen';

const MAX_FILES = 8;
const MAX_BYTES = 18 * 1024 * 1024;

function clean(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

function fileData(value) {
  let data = String(value || '');
  const comma = data.indexOf(',');
  if (data.startsWith('data:') && comma >= 0) data = data.slice(comma + 1);
  data = data.replace(/\s/g, '');
  if (!data || data.length > Math.ceil(MAX_BYTES * 4 / 3) + 8) return '';
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return '';
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > MAX_BYTES) return '';
  return data;
}

export function agentRequest(body = {}) {
  const input = body.input === 'sources' ? 'sources' : 'ask';
  const question = clean(body.question, 2000);
  const sources = [];
  for (const file of (Array.isArray(body.sources) ? body.sources : []).slice(0, MAX_FILES)) {
    const name = clean(file?.name, 180) || 'file';
    const data = fileData(file?.data);
    if (!data) continue;
    sources.push({
      name,
      mime: clean(file?.mime, 120) || 'application/octet-stream',
      kind: sourceKind(name),
      data,
    });
  }
  const maxLeads = /^(4|8|15|50)$/.test(String(body.maxLeads ?? '').trim()) ? Number(body.maxLeads) : 50;
  return {
    input,
    question,
    sources,
    profile: {
      sellerName: clean(body.sellerName, 120),
      offering: clean(body.offering, 500),
      icp: clean(body.icp, 500),
      industry: clean(body.industry, 200),
      region: clean(body.region, 200),
      maxLeads,
    },
  };
}

function shortText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 600);
}

function unwrapItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  if (item.json && typeof item.json === 'object' && !Array.isArray(item.json)) return item.json;
  return item;
}

function rowsFrom(value) {
  if (Array.isArray(value)) return value.map(unwrapItem).filter(Boolean);
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value.leads)) return value.leads.map(unwrapItem).filter(Boolean);
  return [];
}

function leadRows(payload) {
  if (Array.isArray(payload)) return payload.map(unwrapItem).filter(Boolean);
  if (!payload || typeof payload !== 'object') return [];
  const nested = [payload.leads, payload.items, payload.companies, payload.data, payload.output, payload.result, payload.body, payload.json];
  for (const candidate of nested) {
    const rows = rowsFrom(candidate);
    if (rows.length) return rows;
  }
  const single = unwrapItem(payload);
  if (single && (single.company || single.companyName || single.name)) return [single];
  return [];
}

function explanationFrom(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const keys = ['explanation', 'message', 'text', 'output'];
  for (const key of keys) {
    if (typeof payload[key] === 'string' && payload[key].trim()) return shortText(payload[key]);
  }
  if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
    return explanationFrom(payload.data);
  }
  return '';
}

function leadRow(raw) {
  const company = clean(raw.company || raw.companyName || raw.name, 200);
  if (!company) return null;
  const priority = /high/i.test(String(raw.priority || '')) ? 'High' : 'Low';
  return {
    company,
    domain: clean(raw.domain, 200),
    website: clean(raw.website || raw.url, 300),
    email: clean(raw.email || raw.contactEmail, 200),
    hq: clean(raw.hq || raw.hqAddress || raw.headquarters, 300),
    lat: raw.lat ?? null,
    lng: raw.lng ?? null,
    contact: clean(raw.contact || raw.contactName, 200),
    title: clean(raw.title || raw.contactTitle, 200),
    pain: clean(raw.pain || raw.painPoint, 500),
    hook: clean(raw.hook, 500),
    priority,
    source: clean(raw.source, 500),
    sources: Array.isArray(raw.sources) ? raw.sources.map((item) => clean(item, 500)).filter(Boolean).slice(0, 12) : [],
    signals: Array.isArray(raw.signals) ? raw.signals.map((item) => clean(item, 300)).filter(Boolean).slice(0, 12) : [],
    photo: clean(raw.photo || raw.logo, 500),
  };
}

export function leadsFromAgent(payload) {
  const explanation = explanationFrom(payload);
  const leads = leadRows(payload).slice(0, 50).map(leadRow).filter(Boolean);
  if (!leads.length && explanation.includes('|')) {
    const table = parseLeadAnswer(explanation);
    return { explanation: table.explanation || explanation, leads: table.leads };
  }
  return { explanation, leads };
}

export async function postAgentWebhook(payload, options = {}) {
  const url = options.url || AGENT_WEBHOOK_URL;
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(options.timeoutMs || 900000),
  });
  const raw = await response.text();
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const error = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed.error || parsed.message || '')
      : '';
    return {
      ok: false,
      status: response.status,
      error: clean(error, 300) || `The lead webhook returned ${response.status}.`,
      explanation: '',
      leads: [],
    };
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.ok === false) {
    return {
      ok: false,
      status: 502,
      error: clean(parsed.error || parsed.message, 300) || 'The lead webhook refused the request.',
      explanation: '',
      leads: [],
    };
  }
  if (parsed == null) {
    const table = parseLeadAnswer(raw);
    if (table.leads.length) return { ok: true, status: 200, explanation: table.explanation, leads: table.leads };
    return { ok: false, status: 502, error: 'The lead webhook did not return JSON.', explanation: '', leads: [] };
  }
  const found = leadsFromAgent(parsed);
  return { ok: true, status: 200, explanation: found.explanation, leads: found.leads };
}
