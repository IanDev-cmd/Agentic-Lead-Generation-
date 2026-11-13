import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REDIRECT = /vertexaisearch\.cloud\.google\.com\/grounding-api-redirect/i;

export function limitsFor(model) {
  const name = String(model || '').toLowerCase();
  // gemini-3.6-flash is a Gemini 3 model, so it uses the 1,500/day and 5,000/month caps.
  if (name.includes('gemini-3')) {
    return { dailyCap: 1500, monthlyCap: 5000 };
  }
  return { dailyCap: 500, monthlyCap: null };
}

export function pacificKeys(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  const day = `${get('year')}-${get('month')}-${get('day')}`;
  return { day, month: day.slice(0, 7) };
}

export class GroundingQuota {
  constructor(file, model, perRunCap) {
    this.file = file;
    this.model = model;
    this.limits = limitsFor(model);
    this.perRunCap = perRunCap;
    this.usedThisRun = 0;
    this.dayCount = 0;
    this.monthCount = 0;
    const keys = pacificKeys();
    this.dayKey = keys.day;
    this.monthKey = keys.month;
    this.load();
  }

  allow() {
    const underMonth = this.limits.monthlyCap == null || this.monthCount < this.limits.monthlyCap;
    return this.usedThisRun < this.perRunCap && this.dayCount < this.limits.dailyCap && underMonth;
  }

  commit() {
    if (!this.allow()) {
      const error = new Error('Grounding quota is spent for this run.');
      error.code = 'quota';
      throw error;
    }
    this.usedThisRun += 1;
    this.dayCount += 1;
    this.monthCount += 1;
    this.save();
  }

  load() {
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8'));
      if (saved.day === this.dayKey) this.dayCount = Number(saved.day_count) || 0;
      if (saved.month === this.monthKey) this.monthCount = Number(saved.month_count) || 0;
    } catch {
      this.dayCount = 0;
      this.monthCount = 0;
    }
  }

  save() {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify({
      model: this.model,
      day: this.dayKey,
      day_count: this.dayCount,
      month: this.monthKey,
      month_count: this.monthCount,
      daily_cap: this.limits.dailyCap,
      monthly_cap: this.limits.monthlyCap,
    }, null, 2));
  }
}

export function repairJson(text) {
  const raw = String(text || '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    const listStart = raw.indexOf('[');
    const listEnd = raw.lastIndexOf(']');
    if (listStart >= 0 && listEnd > listStart) return JSON.parse(raw.slice(listStart, listEnd + 1));
    throw new Error('Gemini returned no JSON.');
  }
}

export function groundingTargets(response) {
  const chunks = response?.candidates?.[0]?.groundingMetadata?.groundingChunks
    || response?.groundingMetadata?.groundingChunks
    || [];
  return chunks.map((chunk) => ({
    uri: chunk?.web?.uri || '',
    title: chunk?.web?.title || '',
  })).filter((item) => item.uri);
}

export function isGroundingRedirect(url) {
  return REDIRECT.test(String(url || ''));
}

export async function resolveFinalUrl(url, fetchImpl = globalThis.fetch, hops = 3) {
  let current = String(url || '');
  if (!current) return '';
  for (let hop = 0; hop < hops; hop += 1) {
    let response = null;
    try {
      response = await fetchImpl(current, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(5000) });
    } catch {
      response = null;
    }
    const status = Number(response?.status);
    if (!response || status === 405 || status === 501) {
      try {
        response = await fetchImpl(current, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(5000) });
      } catch {
        return current;
      }
    }
    const nextStatus = Number(response?.status);
    const location = response?.headers?.get?.('location') || response?.headers?.location || '';
    if (location && nextStatus >= 300 && nextStatus < 400) {
      current = new URL(location, current).href;
      continue;
    }
    return current;
  }
  return current;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryable(error) {
  const text = String(error?.message || error || '');
  return /\b429\b|\b5\d\d\b|unavailable|timeout|fetch failed/i.test(text);
}

export async function withRetry(fn) {
  try {
    return await fn();
  } catch (error) {
    if (!retryable(error)) throw error;
    await sleep(40 + Math.floor(Math.random() * 80));
    return fn();
  }
}

export function responseText(response) {
  try {
    return String(response?.text || '');
  } catch {
    return '';
  }
}
