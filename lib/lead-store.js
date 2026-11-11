import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseLeadAnswer } from './ask.js';
import { demoLeads, normalizeLead } from './leads.js';

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
    // A missing store means only the demo rows are available.
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

export function rememberLeads(root, incoming) {
  load(root);
  const key = path.resolve(root);
  const stored = [];
  for (const raw of incoming || []) {
    const lead = normalizeLead(raw);
    memory.set(`${key}:${lead.id}`, lead);
    stored.push(lead);
  }
  if (stored.length) persist(root);
  return stored;
}

export function allLeads(root) {
  load(root);
  const key = path.resolve(root);
  const merged = new Map();
  for (const lead of demoLeads(root)) merged.set(lead.id, lead);
  for (const [id, lead] of memory) {
    if (id.startsWith(`${key}:`)) merged.set(lead.id, lead);
  }
  return [...merged.values()];
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
