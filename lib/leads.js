import { readFileSync } from 'node:fs';
import path from 'node:path';
import { blankUnknown } from './safety.js';

const PHOTOS = {
  'northwind analytics': 'northwind.jpg',
  'contoso fabrication': 'contoso.jpg',
};

export function leadId(company) {
  return String(company || 'lead').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'lead';
}

export function normalizeLead(raw) {
  const company = blankUnknown(raw.company) || 'Untitled';
  const hook = blankUnknown(raw.hook);
  const pain = blankUnknown(raw.painPoint || raw.pain);
  const priority = blankUnknown(raw.priority) || 'Low';
  const high = priority === 'High' && Boolean(hook);
  return {
    id: raw.id || leadId(company),
    company,
    domain: blankUnknown(raw.domain),
    hq: blankUnknown(raw.hq || raw.hqAddress),
    distance: blankUnknown(raw.distance),
    coords: blankUnknown(raw.coords),
    priority: high ? 'High' : 'Low',
    pain: pain || 'No public pain point.',
    hook,
    source: blankUnknown(raw.source),
    photo: raw.photo || PHOTOS[company.toLowerCase()] || '',
    stage: raw.stage || 'discovered',
    negative: !high,
    interactionId: blankUnknown(raw.interactionId),
    task: high ? `Review pitch deck for ${company}` : '',
    taskWhy: high
      ? 'High priority. The task is due on the calendar date 48 hours after the batch, because Google Tasks stores a date. The Gmail draft is created only after approval.'
      : 'Negative match. No draft, briefing, or task was created.',
  };
}

export function demoLeads(root = process.cwd()) {
  const file = path.join(root, 'fallback', 'demo_leads.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return (parsed.leads || []).map((lead) => normalizeLead(lead));
}
