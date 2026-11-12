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

function finiteCoord(value, limit) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > limit) return null;
  return number;
}

function pairFromCoords(value) {
  const match = String(value || '').match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!match) return { lat: null, lng: null };
  return { lat: finiteCoord(match[1], 90), lng: finiteCoord(match[2], 180) };
}

function geoRecord(raw, hq, lat, lng) {
  const prior = raw && typeof raw.geo === 'object' && raw.geo ? raw.geo : {};
  const precision = ['rooftop', 'street', 'area', 'region'].includes(prior.precision) ? prior.precision : '';
  const confidence = Number(prior.confidence);
  const safeConfidence = Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0;
  if (!hq) return { status: 'skipped', precision: '', confidence: 0, source: '', resolvedAt: '' };
  if (lat == null || lng == null) {
    if (prior.status === 'not_found') {
      return {
        status: 'not_found',
        precision: '',
        confidence: 0,
        source: blankUnknown(prior.source),
        resolvedAt: blankUnknown(prior.resolvedAt),
      };
    }
    return { status: 'pending', precision: '', confidence: 0, source: '', resolvedAt: '' };
  }
  return {
    status: 'ok',
    precision: precision || 'street',
    confidence: Number.isFinite(confidence) ? safeConfidence : 0.5,
    source: blankUnknown(prior.source),
    resolvedAt: blankUnknown(prior.resolvedAt),
  };
}

export function normalizeLead(raw) {
  const company = blankUnknown(raw.company) || 'Untitled';
  const hook = blankUnknown(raw.hook);
  const pain = blankUnknown(raw.painPoint || raw.pain);
  const priority = blankUnknown(raw.priority) || 'Low';
  const high = priority === 'High' && Boolean(hook);
  const hq = blankUnknown(raw.hq || raw.hqAddress);
  const parsed = pairFromCoords(raw.coords);
  const lat = finiteCoord(raw.lat, 90) ?? parsed.lat;
  const lng = finiteCoord(raw.lng, 180) ?? parsed.lng;
  return {
    id: raw.id || leadId(company),
    company,
    domain: blankUnknown(raw.domain),
    hq,
    distance: blankUnknown(raw.distance),
    coords: lat == null || lng == null ? blankUnknown(raw.coords) : `${lat}, ${lng}`,
    lat,
    lng,
    geo: geoRecord(raw, hq, lat, lng),
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
