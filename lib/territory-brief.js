import { allLeads } from './lead-store.js';
import { dbscan, planRoute, ringCounts, scoreLead } from '../web/geo.js';

function placed(lead) {
  return lead && lead.lat != null && lead.lng != null && Number.isFinite(Number(lead.lat)) && Number.isFinite(Number(lead.lng));
}

export function territoryFacts(root, start) {
  const leads = allLeads(root);
  const pins = leads.filter(placed).map((lead) => ({ ...lead, lat: Number(lead.lat), lng: Number(lead.lng) }));
  const context = { start: start || null, leads: pins, epsKm: 25 };
  const grouped = dbscan(pins, { epsKm: 25, minPts: 2 });
  const scores = pins.map((lead) => {
    const scored = scoreLead(lead, context);
    return { company: lead.company, score: scored.score, reasons: scored.reasons };
  });
  const highs = pins.filter((lead) => lead.priority === 'High' && !lead.negative);
  const plan = start ? planRoute(start, highs, { max: 10 }) : null;
  return {
    placed: pins.length,
    withoutCoordinates: leads.length - pins.length,
    clusters: grouped.clusters.map((cluster) => ({
      label: cluster.label,
      count: cluster.points.length,
      companies: cluster.points.map((point) => point.company),
      score: cluster.points.reduce((sum, point) => sum + scoreLead(point, context).score, 0),
    })),
    scores,
    rings: start ? ringCounts(start, pins) : [],
    plan: plan ? {
      stops: plan.order.map((stop) => stop.company),
      totalKm: Number(plan.totalKm.toFixed(1)),
      minutes: Math.round(plan.minutes),
      label: 'estimate',
    } : null,
  };
}

export function briefPrompt(facts) {
  return [
    'You are the lead desk. Write a short territory note from the JSON below.',
    'Do not invent a company, a distance, a score, or a contact. If a value is missing, say it is unknown.',
    'Nothing was sent. This note is only for the person reading the desk.',
    JSON.stringify(facts),
  ].join('\n');
}

export async function narrateTerritory({ apiKey, model, facts }) {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: briefPrompt(facts) }] }],
  });
  let text = '';
  try {
    text = String(response?.text || '').trim();
  } catch {
    text = '';
  }
  if (!text) throw new Error('Gemini returned no text. Nothing was written.');
  return text.slice(0, 2000);
}
