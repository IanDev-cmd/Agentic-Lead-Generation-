import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REDIRECT = /vertexaisearch\.cloud\.google\.com\/grounding-api-redirect/i;

export function limitsFor(model) {
  const name = String(model || '').toLowerCase();
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

export const FREE_TIER_MODELS = Object.freeze([
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemma-4-27b-it',
]);

export const PRIMARY_MODEL = FREE_TIER_MODELS[0];

const FALLBACK_STATUSES = new Set([404, 429, 503]);

const STATUS_NAMES = {
  BAD_REQUEST: 400,
  INVALID_ARGUMENT: 400,
  FAILED_PRECONDITION: 400,
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  RESOURCE_EXHAUSTED: 429,
  UNAVAILABLE: 503,
  OVERLOADED: 503,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeStatus(value) {
  if (typeof value === 'number' && value >= 400 && value <= 599) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{3}$/.test(trimmed)) {
      const code = Number(trimmed);
      if (code >= 400 && code <= 599) return code;
    }
    if (STATUS_NAMES[trimmed]) return STATUS_NAMES[trimmed];
  }
  return 0;
}

export function httpStatus(error) {
  const candidates = [
    error?.status,
    error?.statusCode,
    error?.code,
    error?.error?.code,
    error?.error?.status,
    error?.cause?.status,
    error?.cause?.code,
  ];
  for (const value of candidates) {
    const status = normalizeStatus(value);
    if (status) return status;
  }
  const message = String(error?.message || '');
  const jsonCode = message.match(/"code"\s*:\s*(\d{3})/);
  if (jsonCode) return Number(jsonCode[1]);
  const named = message.match(/"status"\s*:\s*"([A-Z_]+)"/);
  if (named && STATUS_NAMES[named[1]]) return STATUS_NAMES[named[1]];
  return 0;
}

function retryable(error) {
  const status = httpStatus(error);
  if (status) return status === 500 || status === 502 || status === 504;
  const text = String(error?.message || error || '');
  return /unavailable|timeout|fetch failed/i.test(text);
}

export function modelChain(preferred) {
  const requested = String(preferred ?? process.env.FREE_MODEL ?? '').trim();
  const index = FREE_TIER_MODELS.indexOf(requested);
  if (index > 0) return FREE_TIER_MODELS.slice(index);
  return [...FREE_TIER_MODELS];
}

export function configuredModel(preferred) {
  return modelChain(preferred)[0];
}

function hasTools(request) {
  const tools = request?.config?.tools;
  return Array.isArray(tools) && tools.length > 0;
}

function withoutTools(request, model) {
  const config = { ...(request?.config || {}) };
  delete config.tools;
  const next = { ...request, model };
  if (Object.keys(config).length) next.config = config;
  else delete next.config;
  return next;
}

function warnSwitch(model, status) {
  console.warn(`Gemini model ${model} failed with HTTP ${status}. Retrying the same request on the next free-tier model.`);
}

export async function generateWithFallback(ai, request, options = {}) {
  const models = options.models || modelChain(options.model);
  if (!models.length) throw new Error('No Gemini model is configured.');
  let lastError = null;
  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];
    try {
      return await ai.models.generateContent({ ...request, model });
    } catch (error) {
      lastError = error;
      const status = httpStatus(error);
      if (index > 0 && status === 400 && hasTools(request)) {
        console.warn(`Gemini model ${model} rejected a tool or grounding feature (HTTP 400). Retrying without tools.`);
        try {
          return await ai.models.generateContent(withoutTools(request, model));
        } catch (stripped) {
          lastError = stripped;
          const strippedStatus = httpStatus(stripped);
          if (FALLBACK_STATUSES.has(strippedStatus) && index < models.length - 1) {
            warnSwitch(model, strippedStatus);
            continue;
          }
          throw stripped;
        }
      }
      if (FALLBACK_STATUSES.has(status) && index < models.length - 1) {
        warnSwitch(model, status);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
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
