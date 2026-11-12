import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseLeadAnswer } from './ask.js';
import { normalizeLead } from './leads.js';

const memory = new Map();
const loaded = new Set();

function storePath(root) {
  return path.join(root, 'output', 'discovered-leads.json');
}

function load(root) {
  const key = path.resolve(root);
  if (loaded.has(key)) return;
  loaded.add(key);
  try {
    const parsed = JSON.parse(readFileSync(storePath(key), 'utf8'));
    for (const lead of parsed.leads || []) {
      const normalized = normalizeLead(lead);
      memory.set(`${key}:${normalized.id}`, normalized);
    }
  } catch {
    // A missing store means the desk has no companies yet.
  }
}

function persist(root) {
  const key = path.resolve(root);
  const leads = [];
  for (const [id, lead] of memory) {
    if (id.startsWith(`${key}:`)) leads.push(lead);
  }
  mkdirSync(path.join(key, 'output'), { recursive: true });
  writeFileSync(storePath(key), JSON.stringify({ leads }, null, 2));
}

function keep(previous, next) {
  return previous || next;
}

export function rememberLeads(root, incoming) {
  load(root);
  const key = path.resolve(root);
  const stored = [];
  for (const raw of incoming || []) {
    const lead = normalizeLead(raw);
    const existing = memory.get(`${key}:${lead.id}`);
    const next = existing ? normalizeLead({
      ...existing,
      ...lead,
      email: keep(existing.email, lead.email),
      domain: keep(existing.domain, lead.domain),
      website: keep(existing.website, lead.website),
      photo: keep(existing.photo, lead.photo),
      hq: keep(existing.hq, lead.hq),
      hook: keep(existing.hook, lead.hook),
      source: keep(existing.source, lead.source),
      score: Math.max(Number(existing.score) || 0, Number(lead.score) || 0),
      sources: [...new Set([...(existing.sources || []), ...(lead.sources || [])])],
      signals: [...new Set([...(existing.signals || []), ...(lead.signals || [])])],
      priority: existing.priority === 'High' || lead.priority === 'High' ? 'High' : 'Low',
      score: Math.max(Number(existing.score) || 0, Number(lead.score) || 0),
    }) : lead;
    memory.set(`${key}:${next.id}`, next);
    stored.push(next);
  }
  if (stored.length) persist(root);
  return stored;
}

function shownOnDesk(lead) {
  const company = String(lead.company || '').trim().toLowerCase();
  const domain = String(lead.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  if (company === 'northwind analytics' || company === 'contoso fabrication') return false;
  if (domain.endsWith('.example')) return false;
  return true;
}

export function allLeads(root) {
  load(root);
  const key = path.resolve(root);
  const merged = new Map();
  for (const [id, lead] of memory) {
    if (id.startsWith(`${key}:`)) merged.set(lead.id, lead);
  }
  return [...merged.values()].filter(shownOnDesk);
}

export function findLead(root, id) {
  return allLeads(root).find((lead) => lead.id === id) || null;
}

export function leadsFromMarkdown(markdown, interactionId) {
  const parsed = parseLeadAnswer(String(markdown || ''));
  return parsed.leads.map((lead) => normalizeLead({
    company: lead.company,
    domain: lead.domain,
    hq: lead.hq,
    painPoint: lead.pain,
    hook: lead.hook,
    priority: lead.priority,
    source: lead.source,
    interactionId: interactionId || '',
  }));
}
